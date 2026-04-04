import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

process.env.DB_PROVIDER = process.env.DB_PROVIDER || "memory";
process.env.SONETEL_ENABLE_LIVE_OUTBOUND = "false";

const { db } = await import("@aiautosales/db");
const { runDirectLeadWorkflow } = await import("@aiautosales/orchestrator");
const { getBridgeSession, ingestBridgeEvent } = await import("@aiautosales/bridge-gateway");
const { startBridgeGateway } = await import("@aiautosales/bridge-gateway/src/index");

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
    await wait(500);
  }

  throw new Error(message);
}

await db.init();
const bridgeServer = await startBridgeGateway();

const rl = readline.createInterface({ input, output });
let sessionClosed = false;
const correlationId = crypto.randomUUID();
const workspaceId = "local-rehearsal";

console.log("Local sales rehearsal");
console.log("Type like a chaotic prospect. Commands: /end, /snapshot, /help");

const product = await db.putProduct({
  id: crypto.randomUUID(),
  workspaceId,
  name: "AI AutoSales",
  description: "Autonomous outbound caller that researches, strategizes, calls, and drives next steps.",
  offerSummary: "AI agent that handles cold calling and books qualified meetings.",
  icpSummary: "Revenue leaders, ops leaders, and founder-led teams that need more outbound throughput.",
  createdAt: new Date().toISOString()
});

const workflow = await runDirectLeadWorkflow({
  workspaceId,
  productId: product.id,
  companyName: "Chaotic Prospect Co",
  companyWebsite: "https://example.com",
  phoneNumber: "+15551234567",
  contactName: "Chaos Prospect",
  contactTitle: "Unknown",
  notes: "This is a local rehearsal. The prospect may be skeptical, chaotic, distracted, hostile, or curious.",
  autoStart: true
});

if (!workflow.bridgeSession || !workflow.callSession) {
  throw new Error("Failed to create a rehearsal bridge/call session.");
}

await ingestBridgeEvent(
  workflow.bridgeSession.id,
  {
    event: "session.connected",
    metadata: {
      source: "local-rehearsal"
    }
  },
  correlationId
);

let lastTranscriptCount = 0;

async function printNewTurns() {
  const turns = await db.listTranscriptTurns(workflow.callSession!.id);
  const fresh = turns.slice(lastTranscriptCount);
  for (const turn of fresh) {
    const label = turn.speaker === "agent" ? "Agent" : turn.speaker === "prospect" ? "Prospect" : "System";
    console.log(`${label}: ${turn.text}`);
  }
  lastTranscriptCount = turns.length;
}

await waitFor(
  async () => {
    const turns = await db.listTranscriptTurns(workflow.callSession!.id);
    return turns.find((entry) => entry.speaker === "agent") ? true : null;
  },
  30000,
  "Timed out waiting for initial agent opener."
);

await printNewTurns();

async function completeRehearsal() {
  if (sessionClosed) {
    return;
  }

  sessionClosed = true;
  await ingestBridgeEvent(
    workflow.bridgeSession.id,
    {
      event: "session.completed",
      outcome: "disconnected",
      followupSummary: "Local rehearsal completed."
    },
    correlationId
  );
}

async function readProspectLine() {
  try {
    const line = await rl.question("You> ");
    return line.trim();
  } catch (error) {
    if (
      error instanceof Error &&
      ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE" ||
        /ERR_USE_AFTER_CLOSE/.test(error.message))
    ) {
      return null;
    }

    throw error;
  }
}

while (true) {
  const line = await readProspectLine();

  if (line === null) {
    await completeRehearsal();
    break;
  }

  if (!line) {
    continue;
  }

  if (line === "/help") {
    console.log("/snapshot  show call/session state");
    console.log("/end       complete the rehearsal");
    continue;
  }

  if (line === "/snapshot") {
    const callSession = await db.getCallSession(workflow.callSession.id);
    const bridgeSession = await getBridgeSession(workflow.bridgeSession.id);
    const followups = await db.listFollowupsByProspectId(workflow.prospect.id);
    const sequencePlans = await db.listSequencePlansByProspectId(workflow.prospect.id);
    console.log(
      JSON.stringify(
        {
          callStatus: callSession?.status ?? null,
          outcome: callSession?.outcome ?? null,
          bridgeStatus: bridgeSession?.status ?? null,
          transcriptTurns: (await db.listTranscriptTurns(workflow.callSession.id)).length,
          followupCount: followups.length,
          latestSequence: sequencePlans.at(-1) ?? null
        },
        null,
        2
      )
    );
    continue;
  }

  if (line === "/end") {
    await completeRehearsal();
    break;
  }

  await ingestBridgeEvent(
    workflow.bridgeSession.id,
    {
      event: "prospect.message",
      text: line,
      speaker: "prospect",
      metadata: {
        source: "local-rehearsal"
      }
    },
    correlationId
  );

  await waitFor(
    async () => {
      const turns = await db.listTranscriptTurns(workflow.callSession!.id);
      return turns.length > lastTranscriptCount ? true : null;
    },
    30000,
    "Timed out waiting for agent response."
  );

  await printNewTurns();
}

await printNewTurns();

const finalCall = await db.getCallSession(workflow.callSession.id);
const finalBridge = await getBridgeSession(workflow.bridgeSession.id);
const finalFollowups = await db.listFollowupsByProspectId(workflow.prospect.id);
const finalPlans = await db.listSequencePlansByProspectId(workflow.prospect.id);

console.log(
  JSON.stringify(
    {
      ok: true,
      prospectId: workflow.prospect.id,
      callSessionId: workflow.callSession.id,
      bridgeSessionId: workflow.bridgeSession.id,
      finalCallStatus: finalCall?.status ?? null,
      finalOutcome: finalCall?.outcome ?? null,
      finalBridgeStatus: finalBridge?.status ?? null,
      followupCount: finalFollowups.length,
      latestSequencePlan: finalPlans.at(-1) ?? null
    },
    null,
    2
  )
);

rl.close();
bridgeServer.close();
