import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const apiPort = 4100 + Math.floor(Math.random() * 200);
const apiKey = "test-operator-key";
const baseUrl = `http://127.0.0.1:${apiPort}`;
const stdoutPath = "tmp-workspace-smoke-api-stdout.log";
const stderrPath = "tmp-workspace-smoke-api-stderr.log";

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

function authHeaders(workspaceId) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "x-workspace-id": workspaceId
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
  let lastStatus = "not-started";

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(1000);
    try {
      const response = await fetch(`${baseUrl}/health`);
      lastStatus = String(response.status);
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true) {
          return;
        }
      }
    } catch (error) {
      lastStatus = String(error);
    }
  }

  throw new Error(`API did not become ready on port ${apiPort}. Last status: ${lastStatus}`);
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

  const unauth = await fetch(`${baseUrl}/dashboard`);
  const alphaCreate = await fetchJson("/products", {
    method: "POST",
    headers: authHeaders("alpha"),
    body: JSON.stringify({
      name: "Alpha Product",
      description: "alpha only",
      offerSummary: "alpha offer",
      icpSummary: "founders"
    })
  });
  const betaCreate = await fetchJson("/products", {
    method: "POST",
    headers: authHeaders("beta"),
    body: JSON.stringify({
      name: "Beta Product",
      description: "beta only",
      offerSummary: "beta offer",
      icpSummary: "operators"
    })
  });
  const alphaProducts = await fetchJson("/products", {
    headers: authHeaders("alpha")
  });
  const betaProducts = await fetchJson("/products", {
    headers: authHeaders("beta")
  });
  const defaultProducts = await fetchJson("/products", {
    headers: authHeaders("default")
  });
  const alphaDashboard = await fetchJson("/dashboard", {
    headers: authHeaders("alpha")
  });
  const betaDashboard = await fetchJson("/dashboard", {
    headers: authHeaders("beta")
  });

  assert(unauth.status === 401, `Expected unauthenticated dashboard to return 401, got ${unauth.status}`);
  assert(alphaCreate.response.status === 201, `Expected alpha product create to return 201, got ${alphaCreate.response.status}`);
  assert(betaCreate.response.status === 201, `Expected beta product create to return 201, got ${betaCreate.response.status}`);
  assert(alphaCreate.body?.workspaceId === "alpha", "Alpha product was not assigned to workspace alpha");
  assert(betaCreate.body?.workspaceId === "beta", "Beta product was not assigned to workspace beta");
  assert((alphaProducts.body ?? []).length === 1, `Expected alpha workspace to have 1 product, got ${(alphaProducts.body ?? []).length}`);
  assert((betaProducts.body ?? []).length === 1, `Expected beta workspace to have 1 product, got ${(betaProducts.body ?? []).length}`);
  assert((defaultProducts.body ?? []).length === 0, `Expected default workspace to have 0 products, got ${(defaultProducts.body ?? []).length}`);
  assert(alphaDashboard.body?.counts?.products === 1, `Expected alpha dashboard count to be 1, got ${alphaDashboard.body?.counts?.products}`);
  assert(betaDashboard.body?.counts?.products === 1, `Expected beta dashboard count to be 1, got ${betaDashboard.body?.counts?.products}`);

  console.log(
    JSON.stringify(
      {
        unauthStatus: unauth.status,
        alphaCreateWorkspace: alphaCreate.body.workspaceId,
        betaCreateWorkspace: betaCreate.body.workspaceId,
        alphaProducts: alphaProducts.body.map((entry) => entry.name),
        betaProducts: betaProducts.body.map((entry) => entry.name),
        defaultProductsCount: defaultProducts.body.length,
        alphaDashboardProducts: alphaDashboard.body.counts.products,
        betaDashboardProducts: betaDashboard.body.counts.products
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
