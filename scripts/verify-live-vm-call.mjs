const targetNumber = process.argv[2];
if (!targetNumber) {
  console.error("Usage: node scripts/verify-live-vm-call.mjs <target-number> [attempts]");
  process.exit(1);
}

const attempts = Number.parseInt(process.argv[3] ?? "1", 10);
const baseUrl = process.env.AIAUTOSALES_VERIFY_BASE_URL ?? "http://20.69.177.225:4000";
const apiKey = process.env.AIAUTOSALES_VERIFY_API_KEY ?? "vm-bootstrap-key-20260404";
const workspaceId = process.env.AIAUTOSALES_VERIFY_WORKSPACE ?? "live-vm";
const pollAttempts = Number.parseInt(process.env.AIAUTOSALES_VERIFY_POLL_ATTEMPTS ?? "18", 10);
const pollIntervalMs = Number.parseInt(process.env.AIAUTOSALES_VERIFY_POLL_INTERVAL_MS ?? "10000", 10);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { response, body };
}

function headers(extra = {}) {
  return {
    "x-api-key": apiKey,
    "x-workspace-id": workspaceId,
    ...extra
  };
}

function summarizeAttempt(attemptIndex, state) {
  const sequencePlanId = state.call?.session?.providerMetadata?.sequencePlanId ?? null;
  const sequenceChannel = state.call?.session?.providerMetadata?.sequenceChannel ?? null;
  const transcriptTurns = Array.isArray(state.call?.transcript) ? state.call.transcript.length : 0;
  const followupCount = Array.isArray(state.prospect?.followups) ? state.prospect.followups.length : 0;
  const callStatus = state.call?.session?.status ?? null;
  const bridgeStatus = state.bridge?.status ?? null;

  return {
    attempt: attemptIndex,
    workflowRunId: state.direct?.workflowRunId ?? null,
    prospectId: state.direct?.prospect?.id ?? null,
    callSessionId: state.direct?.callSession?.id ?? null,
    bridgeSessionId: state.direct?.bridgeSession?.id ?? null,
    callStatus,
    bridgeStatus,
    providerStatus: state.call?.session?.providerStatus ?? null,
    providerCallId: state.call?.session?.providerCallId ?? null,
    voiceSessionId: state.bridge?.voiceSessionId ?? null,
    transcriptTurns,
    firstTranscript: transcriptTurns > 0 ? state.call.transcript[0]?.text ?? null : null,
    sequencePlanId,
    sequenceChannel,
    followupCount,
    outcome: state.call?.session?.outcome ?? state.bridge?.lastEvent?.outcome ?? null,
    lastBridgeEvent: state.bridge?.lastEvent?.event ?? null,
    readyVerdict: {
      submitted: state.call?.session?.providerStatus === "submitted",
      connected: bridgeStatus === "connected" || bridgeStatus === "streaming" || bridgeStatus === "completed",
      completed: callStatus === "completed" || bridgeStatus === "completed",
      transcriptPresent: transcriptTurns > 0,
      sequenced: Boolean(sequencePlanId || followupCount > 0)
    }
  };
}

async function runAttempt(attemptIndex) {
  const health = await fetchJson("/health");
  if (!health.response.ok || health.body?.ok !== true) {
    throw new Error(`API health failed: ${health.response.status}`);
  }

  const product = await fetchJson("/products", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name: `Live Verification Product ${Date.now()}`,
      description: "Controlled live outbound production verification.",
      offerSummary: "AI outbound caller that books meetings.",
      icpSummary: "operators"
    })
  });

  if (product.response.status !== 201) {
    throw new Error(`Product creation failed: ${product.response.status} ${JSON.stringify(product.body)}`);
  }

  const direct = await fetchJson("/direct-calls", {
    method: "POST",
    headers: headers({
      "content-type": "application/json",
      "x-idempotency-key": `verify-${Date.now()}-${attemptIndex}`
    }),
    body: JSON.stringify({
      productId: product.body.id,
      companyName: "Controlled Verification Prospect",
      companyWebsite: "https://example.com",
      contactName: "Controlled Contact",
      phoneNumber: targetNumber,
      notes: `Controlled verification attempt ${attemptIndex}.`,
      autoStart: true
    })
  });

  if (direct.response.status !== 201 && direct.response.status !== 200) {
    throw new Error(`Direct call failed: ${direct.response.status} ${JSON.stringify(direct.body)}`);
  }

  const state = {
    direct: direct.body,
    call: null,
    bridge: null,
    prospect: null,
    diagnostics: null
  };

  const callSessionId = direct.body.callSession?.id;
  const bridgeSessionId = direct.body.bridgeSession?.id;
  const prospectId = direct.body.prospect?.id;

  for (let index = 0; index < pollAttempts; index += 1) {
    await wait(pollIntervalMs);

    const [call, bridge, prospect, diagnostics] = await Promise.all([
      callSessionId ? fetchJson(`/calls/${callSessionId}`, { headers: headers() }) : Promise.resolve(null),
      bridgeSessionId ? fetchJson(`/bridge-sessions/${bridgeSessionId}`, { headers: headers() }) : Promise.resolve(null),
      prospectId ? fetchJson(`/prospects/${prospectId}`, { headers: headers() }) : Promise.resolve(null),
      fetchJson("/diagnostics/summary", { headers: headers() })
    ]);

    state.call = call?.body ?? state.call;
    state.bridge = bridge?.body ?? state.bridge;
    state.prospect = prospect?.body ?? state.prospect;
    state.diagnostics = diagnostics?.body ?? state.diagnostics;

    const callStatus = state.call?.session?.status;
    const bridgeStatus = state.bridge?.status;
    const transcriptTurns = Array.isArray(state.call?.transcript) ? state.call.transcript.length : 0;

    if (
      callStatus === "completed" ||
      callStatus === "failed" ||
      bridgeStatus === "completed" ||
      bridgeStatus === "failed" ||
      (transcriptTurns > 0 && (bridgeStatus === "connected" || bridgeStatus === "streaming"))
    ) {
      break;
    }
  }

  return summarizeAttempt(attemptIndex, state);
}

const results = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    results.push(await runAttempt(attempt));
  } catch (error) {
    results.push({
      attempt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const summary = {
  baseUrl,
  workspaceId,
  targetNumber,
  attempts,
  results
};

console.log(JSON.stringify(summary, null, 2));
