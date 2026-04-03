import { buildRealtimeSessionConfig } from "@aiautosales/azure-openai-client";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import type { BridgeSession, CallBrief, Product } from "@aiautosales/domain-models";
import { markCallEnded, markCallStarted } from "@aiautosales/dialer-service";
import { evaluateCall } from "@aiautosales/evaluation-worker";
import { planNextSequence, type SequenceOutcome } from "@aiautosales/sequence-worker";
import { createEvent } from "@aiautosales/shared-events";
import {
  activateVoiceSession,
  appendAudioChunk,
  appendTranscriptTurn,
  clearAudioBuffer,
  commitAudioBuffer,
  closeVoiceSession,
  requestVoiceResponse,
  startVoiceSession
} from "@aiautosales/voice-gateway";

export type BridgeEventInput = {
  event:
    | "session.connected"
    | "session.disconnected"
    | "session.completed"
    | "session.failed"
    | "transcript"
    | "audio.append"
    | "audio.commit"
    | "audio.clear"
    | "response.create";
  speaker?: "agent" | "prospect" | "system";
  text?: string;
  audio?: string;
  outcome?: string;
  followupSummary?: string;
  metadata?: Record<string, unknown>;
};

function isValidAgentDestination(destination: string): boolean {
  if (!destination) {
    return false;
  }

  if (/^https?:\/\//i.test(destination)) {
    return false;
  }

  return (
    /^sip:[^\s]+$/i.test(destination) ||
    /^tel:\+?[0-9][0-9()-\s.]{4,}$/.test(destination) ||
    /^\+?[0-9][0-9()-\s.]{6,}$/.test(destination)
  );
}

export async function createBridgeSession(input: {
  callSessionId: string;
  prospectId: string;
  agentDestination?: string;
  transport?: BridgeSession["transport"];
  correlationId: string;
}) {
  const env = loadEnv();
  const callSession = await db.getCallSession(input.callSessionId);
  const prospect = await db.getProspect(input.prospectId);

  if (!callSession) {
    throw new Error(`Call session ${input.callSessionId} not found.`);
  }

  if (!prospect) {
    throw new Error(`Prospect ${input.prospectId} not found.`);
  }

  const brief = await db.getCallBriefByProspectId(prospect.id);
  const product = await db.getProduct(prospect.productId);
  if (!brief || !product) {
    throw new Error("Bridge session requires both product and call brief.");
  }

  const now = new Date().toISOString();
  const candidateDestination = input.agentDestination ?? env.sonetelAgentDestination;
  const liveEligible = Boolean(candidateDestination && isValidAgentDestination(candidateDestination));
  if (env.sonetelEnableLiveOutbound && !liveEligible) {
    throw new Error("Live Sonetel outbound requires a valid SONETEL_AGENT_DESTINATION.");
  }
  const transport = input.transport ?? (liveEligible ? "sip" : "simulation");
  const bridgeSession: BridgeSession = {
    id: `bridge_${crypto.randomUUID()}`,
    callSessionId: input.callSessionId,
    prospectId: input.prospectId,
    status: "created",
    transport,
    agentDestination: liveEligible ? candidateDestination : "simulation",
    createdAt: now,
    updatedAt: now
  };

  await db.putBridgeSession(bridgeSession);
  await db.appendEvent(createEvent("call.bridge.created", bridgeSession.id, bridgeSession, input.correlationId));

  const voiceSession = await startVoiceSession({
    callSessionId: input.callSessionId,
    prospectId: input.prospectId,
    product: product as Product,
    callBrief: brief as CallBrief,
    correlationId: input.correlationId
  });

  const connectedSession = await db.updateBridgeSession(bridgeSession.id, (current) => ({
    ...current,
    status: "connecting",
    voiceSessionId: voiceSession.voiceSessionId,
    updatedAt: new Date().toISOString()
  }));

  await db.updateCallSession(input.callSessionId, (current) => ({
    ...current,
    status: current.status === "queued" ? "dialing" : current.status,
    providerMetadata: {
      ...(current.providerMetadata ?? {}),
      bridgeSessionId: bridgeSession.id,
      bridgeTransport: transport,
      agentDestination: bridgeSession.agentDestination
    }
  }));

  return {
    bridgeSession: connectedSession ?? bridgeSession,
    realtime: buildRealtimeSessionConfig(voiceSession.systemPrompt)
  };
}

export async function claimNextBridgeSession() {
  const sessions = await db.listBridgeSessions();
  const nextSession = sessions
    .filter((session) => session.status === "created" || session.status === "connecting")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

  if (!nextSession) {
    return createSyntheticBridgeSession();
  }

  return {
    bridgeSession: nextSession,
    mediaWebsocketUrl: buildBridgeMediaWebSocketUrl(nextSession.id)
  };
}

async function createSyntheticBridgeSession() {
  const correlationId = crypto.randomUUID();
  const now = new Date().toISOString();

  const product = await db.putProduct({
    id: `product_${crypto.randomUUID()}`,
    name: "AI Sales Demo",
    description: "Synthetic ingress demo product for FreeSWITCH bridge validation.",
    offerSummary: "A live AI calling assistant that handles cold outreach and books meetings.",
    icpSummary: "Small and mid-market teams that need outbound sales coverage.",
    createdAt: now
  });

  const company = await db.putCompany({
    id: `company_${crypto.randomUUID()}`,
    name: "Demo Prospect Inc.",
    website: "https://example.com",
    phoneNumber: "+15550001111",
    industry: "Software",
    createdAt: now
  });

  const contact = await db.putContact({
    id: `contact_${crypto.randomUUID()}`,
    companyId: company.id,
    name: "Demo Contact",
    title: "Operations Lead",
    phoneNumber: "+15550001111",
    createdAt: now
  });

  const prospect = await db.putProspect({
    id: `prospect_${crypto.randomUUID()}`,
    productId: product.id,
    companyId: company.id,
    contactId: contact.id,
    state: "READY_TO_CALL",
    sourceMode: "direct",
    createdAt: now,
    updatedAt: now
  });

  await db.putResearchPacket({
    id: `research_${crypto.randomUUID()}`,
    prospectId: prospect.id,
    companySummary: "Synthetic demo company for live bridge validation.",
    personaSummary: "Synthetic operations lead used for telephony ingress smoke tests.",
    pains: ["slow follow-up", "manual outbound work"],
    hooks: ["live AI sales calls", "automatic meeting booking"],
    buyingSignals: ["reaching out", "inbound interest"],
    sourceNotes: ["generated locally on the FreeSWITCH VM"],
    confidence: 0.5,
    createdAt: now
  });

  const callBrief = await db.putCallBrief({
    id: `brief_${crypto.randomUUID()}`,
    prospectId: prospect.id,
    productId: product.id,
    summary: "Synthetic demo brief for FreeSWITCH bridge validation.",
    valueProps: [
      "AI handles the first cold call",
      "Books positive meetings automatically",
      "Keeps the call concise and relevant"
    ],
    painPoints: ["too much manual outreach", "lost follow-up opportunities"],
    proofPoints: ["realtime voice", "call scoring", "meeting booking"],
    openingLines: [
      "Hey, this is the AI assistant calling about outbound sales coverage.",
      "Hi, I’m following up on a cold outreach workflow for your team."
    ],
    qualificationQuestions: ["Who handles outbound today?", "How are you booking meetings now?"],
    objectionTree: [
      {
        objection: "not interested",
        intent: "brush-off",
        recommendedResponse: "Fair enough. I only need 20 seconds to see if it’s relevant.",
        followupQuestion: "Who owns outbound follow-up on your side?"
      }
    ],
    ctaOptions: ["book_demo", "callback", "send_info"],
    riskFlags: ["synthetic_demo_only"],
    forbiddenClaims: ["guaranteed deals"],
    promptVersion: "synthetic-v1",
    playbookVersion: "synthetic-v1",
    createdAt: now
  });

  await db.putPolicyDecision({
    id: `policy_${crypto.randomUUID()}`,
    prospectId: prospect.id,
    status: "allowed",
    reasons: ["synthetic demo session created on demand"],
    createdAt: now
  });

  const callSession = await db.putCallSession({
    id: `call_${crypto.randomUUID()}`,
    prospectId: prospect.id,
    callBriefId: callBrief.id,
    telephonyProvider: "sonetel",
    status: "queued",
    providerMetadata: {
      synthetic: true,
      source: "bridge-gateway-claim-next"
    },
    strategyVersion: "synthetic-v1",
    createdAt: now
  });

  return createBridgeSession({
    callSessionId: callSession.id,
    prospectId: prospect.id,
    agentDestination: "sip:agent@localhost",
    transport: "sip",
    correlationId
  });
}

export async function ingestBridgeEvent(
  bridgeSessionId: string,
  payload: BridgeEventInput,
  correlationId: string
) {
  const bridgeSession = await db.getBridgeSession(bridgeSessionId);
  if (!bridgeSession) {
    throw new Error(`Bridge session ${bridgeSessionId} not found.`);
  }

  const updatedBridgeSession =
    (await db.updateBridgeSession(bridgeSessionId, (current) => ({
      ...current,
      status: nextBridgeStatus(current.status, payload.event),
      lastEvent: {
        event: payload.event,
        ...(payload.metadata ?? {}),
        speaker: payload.speaker,
        text: payload.text,
        outcome: payload.outcome
      },
      updatedAt: new Date().toISOString()
    }))) ?? bridgeSession;

  await db.appendEvent(
    createEvent("call.bridge.updated", updatedBridgeSession.id, updatedBridgeSession, correlationId)
  );

  if (payload.event === "session.connected") {
    await markCallStarted(updatedBridgeSession.callSessionId, correlationId);
    await db.updateProspect(updatedBridgeSession.prospectId, (current) => ({
      ...current,
      state: "IN_CALL",
      updatedAt: new Date().toISOString()
    }));
    if (updatedBridgeSession.voiceSessionId) {
      await activateVoiceSession(updatedBridgeSession.voiceSessionId, correlationId);
    }
  }

  if (payload.event === "transcript" && payload.text && payload.speaker) {
    await appendTranscriptTurn({
      callSessionId: updatedBridgeSession.callSessionId,
      speaker: payload.speaker,
      text: payload.text,
      correlationId
    });
  }

  if (payload.event === "audio.append" && payload.audio && updatedBridgeSession.voiceSessionId) {
    await appendAudioChunk({
      voiceSessionId: updatedBridgeSession.voiceSessionId,
      audio: payload.audio,
      correlationId
    });
  }

  if (payload.event === "audio.commit" && updatedBridgeSession.voiceSessionId) {
    await commitAudioBuffer(updatedBridgeSession.voiceSessionId, correlationId);
  }

  if (payload.event === "audio.clear" && updatedBridgeSession.voiceSessionId) {
    await clearAudioBuffer(updatedBridgeSession.voiceSessionId, correlationId);
  }

  if (payload.event === "response.create" && updatedBridgeSession.voiceSessionId) {
    await requestVoiceResponse(updatedBridgeSession.voiceSessionId, correlationId);
  }

  if (payload.event === "session.completed") {
    const completedSession = await markCallEnded(
      updatedBridgeSession.callSessionId,
      payload.outcome ?? "completed",
      correlationId
    );

    if (completedSession) {
      const sequenceResult = await planNextSequence({
        prospectId: updatedBridgeSession.prospectId,
        callSessionId: completedSession.id,
        outcome: normalizeSequenceOutcome(payload.outcome),
        followupSummary: payload.followupSummary,
        correlationId
      });

      await db.updateCallSession(updatedBridgeSession.callSessionId, (current) => ({
        ...current,
        providerMetadata: {
          ...(current.providerMetadata ?? {}),
          sequencePlanId: sequenceResult.plan.id,
          sequenceChannel: sequenceResult.plan.recommendedChannel
        }
      }));
    }

    const evaluation = await evaluateCall(updatedBridgeSession.callSessionId);
    await db.appendEvent(createEvent("evaluation.completed", updatedBridgeSession.callSessionId, evaluation, correlationId));

    if (updatedBridgeSession.voiceSessionId) {
      await closeVoiceSession(updatedBridgeSession.voiceSessionId, "call_completed");
    }
  }

  if (payload.event === "session.failed") {
    await db.updateCallSession(updatedBridgeSession.callSessionId, (current) => ({
      ...current,
      status: "failed",
      endedAt: new Date().toISOString(),
      outcome: payload.outcome ?? "failed"
    }));
    await db.updateProspect(updatedBridgeSession.prospectId, (current) => ({
      ...current,
      state: "READY_TO_CALL",
      updatedAt: new Date().toISOString()
    }));

    if (updatedBridgeSession.voiceSessionId) {
      await closeVoiceSession(updatedBridgeSession.voiceSessionId, "call_failed");
    }
  }

  return updatedBridgeSession;
}

export async function getBridgeSession(bridgeSessionId: string) {
  return db.getBridgeSession(bridgeSessionId);
}

export async function listBridgeSessions() {
  return db.listBridgeSessions();
}

function nextBridgeStatus(
  current: BridgeSession["status"],
  event: BridgeEventInput["event"]
): BridgeSession["status"] {
  if (event === "session.connected") {
    return "connected";
  }

  if (event === "transcript") {
    return current === "connected" ? "streaming" : current;
  }

  if (event === "session.completed") {
    return "completed";
  }

  if (event === "session.failed") {
    return "failed";
  }

  if (event === "session.disconnected") {
    return "closed";
  }

  return current;
}

function normalizeSequenceOutcome(outcome?: string): SequenceOutcome {
  switch (outcome) {
    case "booked_meeting":
    case "meeting_booked":
    case "callback_requested":
    case "no_answer":
    case "not_interested":
    case "nurture":
    case "blocked":
      return outcome;
    default:
      return "other";
  }
}

export function buildBridgeMediaWebSocketUrl(bridgeSessionId: string) {
  const env = loadEnv();
  const base = env.bridgeGatewayPublicBaseUrl || `http://localhost:${env.bridgeGatewayPort}`;
  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${wsBase.replace(/\/$/, "")}/bridge-sessions/${bridgeSessionId}/media`;
}
