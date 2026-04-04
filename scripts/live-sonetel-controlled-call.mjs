import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const targetNumber = process.argv[2];
if (!targetNumber) {
  console.error("Usage: npm run live:sonetel-call -- <target-number>");
  process.exit(1);
}

const apiPort = 4500 + Math.floor(Math.random() * 200);
const apiKey = "test-operator-key";
const workspaceId = "live-call";
const baseUrl = `http://127.0.0.1:${apiPort}`;
const stdoutPath = "tmp-live-call-api-stdout.log";
const stderrPath = "tmp-live-call-api-stderr.log";

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

  const bootstrap = await fetchJson("/auth/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      workspaceId,
      workspaceName: "Live Outbound Workspace",
      operatorName: "Live Operator",
      operatorEmail: "live@example.com",
      password: "Secur3Pass!"
    })
  });
  assert(bootstrap.response.status === 201, `Expected bootstrap 201, got ${bootstrap.response.status}`);

  const login = await fetchJson("/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      workspaceId,
      email: "live@example.com",
      password: "Secur3Pass!"
    })
  });
  assert(login.response.status === 200, `Expected login 200, got ${login.response.status}`);
  const bearer = `Bearer ${login.body.token}`;

  const product = await fetchJson("/products", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer
    },
    body: JSON.stringify({
      name: "Live Outbound Product",
      description: "Controlled Sonetel live outbound validation.",
      offerSummary: "AI sales calling and meeting booking",
      icpSummary: "operators"
    })
  });
  assert(product.response.status === 201, `Expected product create 201, got ${product.response.status}`);

  const directCall = await fetchJson("/direct-calls", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer,
      "x-idempotency-key": `live-${Date.now()}`
    },
    body: JSON.stringify({
      productId: product.body.id,
      companyName: "Controlled Live Prospect",
      phoneNumber: targetNumber,
      contactName: "Controlled Contact",
      autoStart: true
    })
  });
  assert(directCall.response.status === 201, `Expected direct call 201, got ${directCall.response.status}`);

  const callSessionId = directCall.body.callSession?.id;
  const bridgeSessionId = directCall.body.bridgeSession?.id;
  assert(callSessionId, "Direct call did not return a call session id");
  assert(bridgeSessionId, "Direct call did not return a bridge session id");

  await wait(3000);

  const callDetails = await fetchJson(`/calls/${callSessionId}`, {
    headers: {
      authorization: bearer
    }
  });
  const bridgeDetails = await fetchJson(`/bridge-sessions/${bridgeSessionId}`, {
    headers: {
      authorization: bearer
    }
  });
  const diagnostics = await fetchJson("/diagnostics/summary", {
    headers: {
      authorization: bearer
    }
  });

  assert(callDetails.response.status === 200, `Expected call details 200, got ${callDetails.response.status}`);
  assert(bridgeDetails.response.status === 200, `Expected bridge details 200, got ${bridgeDetails.response.status}`);
  assert(diagnostics.response.status === 200, `Expected diagnostics 200, got ${diagnostics.response.status}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        targetNumber,
        workflowRunId: directCall.body.workflowRunId,
        callSessionId,
        bridgeSessionId,
        providerCallId: callDetails.body.session.providerCallId ?? null,
        providerStatus: callDetails.body.session.providerStatus ?? null,
        bridgeStatus: bridgeDetails.body.status ?? null,
        voiceSessionId: bridgeDetails.body.voiceSessionId ?? null,
        diagnostics: diagnostics.body
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
