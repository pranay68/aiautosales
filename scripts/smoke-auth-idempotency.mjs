import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const apiPort = 4300 + Math.floor(Math.random() * 200);
const apiKey = "test-operator-key";
const baseUrl = `http://127.0.0.1:${apiPort}`;
const stdoutPath = "tmp-auth-smoke-api-stdout.log";
const stderrPath = "tmp-auth-smoke-api-stderr.log";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(1000);
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = response.ok ? await response.json() : null;
      if (response.ok && body?.ok === true) {
        return;
      }
    } catch {
      continue;
    }
  }

  throw new Error(`API did not become ready on port ${apiPort}`);
}

rmSync(stdoutPath, { force: true });
rmSync(stderrPath, { force: true });

const bootstrapCommand =
  process.platform === "win32"
    ? `set DB_PROVIDER=memory&& set OPERATOR_API_KEY=${apiKey}&& set DEFAULT_WORKSPACE_ID=default&& set APP_API_PORT=${apiPort}&& npm run dev:api 1>${stdoutPath} 2>${stderrPath}`
    : `DB_PROVIDER=memory OPERATOR_API_KEY=${apiKey} DEFAULT_WORKSPACE_ID=default APP_API_PORT=${apiPort} npm run dev:api 1>${stdoutPath} 2>${stderrPath}`;

const child =
  process.platform === "win32"
    ? spawn("cmd.exe", ["/c", bootstrapCommand], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore"
      })
    : spawn("sh", ["-lc", bootstrapCommand], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore"
      });

child.unref();

try {
  await waitForHealth();

  const workspaceId = "alpha-auth";
  const bootstrap = await fetchJson("/auth/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      workspaceId,
      workspaceName: "Alpha Auth Workspace",
      operatorName: "Alice Admin",
      operatorEmail: "alice@example.com",
      password: "Secur3Pass!"
    })
  });
  assert(bootstrap.response.status === 201, `Expected bootstrap to return 201, got ${bootstrap.response.status}`);

  const login = await fetchJson("/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      workspaceId,
      email: "alice@example.com",
      password: "Secur3Pass!"
    })
  });
  assert(login.response.status === 200, `Expected login to return 200, got ${login.response.status}`);
  const bearer = `Bearer ${login.body.token}`;

  const me = await fetchJson("/me", {
    headers: {
      authorization: bearer
    }
  });
  assert(me.response.status === 200, `Expected /me to return 200, got ${me.response.status}`);

  const product = await fetchJson("/products", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer
    },
    body: JSON.stringify({
      name: "Auth Product",
      description: "auth scoped",
      offerSummary: "offer",
      icpSummary: "ops"
    })
  });
  assert(product.response.status === 201, `Expected product create to return 201, got ${product.response.status}`);

  const idempotencyKey = "idem-smoke-1";
  const callPayload = {
    productId: product.body.id,
    companyName: "Acme Corp",
    phoneNumber: "+12025550123",
    contactName: "Pat Prospect",
    autoStart: false
  };

  const firstCall = await fetchJson("/direct-calls", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer,
      "x-idempotency-key": idempotencyKey
    },
    body: JSON.stringify(callPayload)
  });
  assert(firstCall.response.status === 201, `Expected first direct call to return 201, got ${firstCall.response.status}`);
  assert(firstCall.body.replayed === false, "Expected first direct call not to be replayed");

  const secondCall = await fetchJson("/direct-calls", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer,
      "x-idempotency-key": idempotencyKey
    },
    body: JSON.stringify(callPayload)
  });
  assert(secondCall.response.status === 200, `Expected second direct call to return 200, got ${secondCall.response.status}`);
  assert(secondCall.body.replayed === true, "Expected second direct call to be replayed");
  assert(
    secondCall.body.workflowRunId === firstCall.body.workflowRunId,
    "Expected idempotent replay to return the same workflow run id"
  );

  const workflowRuns = await fetchJson("/workflow-runs", {
    headers: {
      authorization: bearer
    }
  });
  const auditEntries = await fetchJson("/audit-entries", {
    headers: {
      authorization: bearer
    }
  });
  const diagnostics = await fetchJson("/diagnostics/summary", {
    headers: {
      authorization: bearer
    }
  });

  assert(workflowRuns.response.status === 200, `Expected workflow runs to return 200, got ${workflowRuns.response.status}`);
  assert(auditEntries.response.status === 200, `Expected audit entries to return 200, got ${auditEntries.response.status}`);
  assert(diagnostics.response.status === 200, `Expected diagnostics summary to return 200, got ${diagnostics.response.status}`);
  assert(workflowRuns.body.length >= 1, "Expected at least one workflow run");
  assert(auditEntries.body.length >= 2, "Expected audit entries for bootstrap/login/direct call activity");
  assert(diagnostics.body.failureCounts.workflowRuns === 0, "Expected no failed workflow runs in diagnostics");

  console.log(
    JSON.stringify(
      {
        workspaceId,
        operatorEmail: me.body.operator.email,
        workflowRunId: firstCall.body.workflowRunId,
        replayedSecondCall: secondCall.body.replayed,
        workflowRuns: workflowRuns.body.length,
        auditEntries: auditEntries.body.length,
        diagnosticsWorkflowFailures: diagnostics.body.failureCounts.workflowRuns
      },
      null,
      2
    )
  );
} finally {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(-child.pid, "SIGTERM");
  }

  await wait(1000);

  const stdout = readLog(stdoutPath);
  const stderr = readLog(stderrPath);

  if (stdout) {
    console.log("--- API STDOUT ---");
    console.log(stdout);
  }

  if (stderr) {
    console.log("--- API STDERR ---");
    console.log(stderr);
  }

  rmSync(stdoutPath, { force: true });
  rmSync(stderrPath, { force: true });
}
