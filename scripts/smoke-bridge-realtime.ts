function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(condition: () => Promise<T | null>, timeoutMs: number, message: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await condition();
    if (result) {
      return result;
    }
    await wait(1000);
  }

  throw new Error(message);
}

process.env.DB_PROVIDER = process.env.DB_PROVIDER || "memory";

const { db } = await import("@aiautosales/db");
const { claimNextBridgeSession, getBridgeSession, ingestBridgeEvent } = await import(
  "@aiautosales/bridge-gateway"
);

await db.init();

const correlationId = crypto.randomUUID();
const claimed = await claimNextBridgeSession();
const bridgeSession = claimed.bridgeSession;

await ingestBridgeEvent(
  bridgeSession.id,
  {
    event: "session.connected",
    metadata: {
      source: "smoke-bridge-realtime"
    }
  },
  correlationId
);

const transcriptTurns = await waitFor(
  async () => {
    const turns = await db.listTranscriptTurns(bridgeSession.callSessionId);
    return turns.find((entry) => entry.speaker === "agent" && entry.text.trim()) ? turns : null;
  },
  30000,
  "Timed out waiting for agent transcript from Azure Realtime"
);

await ingestBridgeEvent(
  bridgeSession.id,
  {
    event: "session.completed",
    outcome: "booked_meeting",
    followupSummary: "Realtime smoke test completed successfully."
  },
  correlationId
);

const completedBridge = await waitFor(
  async () => {
    const session = await getBridgeSession(bridgeSession.id);
    return session?.status === "completed" ? session : null;
  },
  10000,
  "Timed out waiting for bridge session completion"
);

const callSession = await db.getCallSession(bridgeSession.callSessionId);
const sequencePlan = callSession?.providerMetadata?.sequencePlanId
  ? await db.getSequencePlan(String(callSession.providerMetadata.sequencePlanId))
  : null;

console.log(
  JSON.stringify(
    {
      ok: true,
      bridgeSessionId: bridgeSession.id,
      callSessionId: bridgeSession.callSessionId,
      voiceSessionId: completedBridge.voiceSessionId ?? null,
      transcriptTurns: transcriptTurns.length,
      firstAgentTurn: transcriptTurns.find((entry) => entry.speaker === "agent")?.text ?? null,
      finalCallStatus: callSession?.status ?? null,
      outcome: callSession?.outcome ?? null,
      sequenceChannel: sequencePlan?.recommendedChannel ?? null,
      sequenceReason: sequencePlan?.reason ?? null
    },
    null,
    2
  )
);
