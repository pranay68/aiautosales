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
  injectProspectText,
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
    | "response.create"
    | "prospect.message";
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
    workspaceId: prospect.workspaceId,
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
    .filter(
      (session) =>
        (session.status === "created" || session.status === "connecting") &&
        session.transport === "sip" &&
        !session.claimedAt &&
        !/localhost/i.test(session.agentDestination)
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

  if (!nextSession) {
    throw new Error("No unclaimed live SIP bridge sessions are waiting to be claimed.");
  }

  const claimedSession =
    (await db.updateBridgeSession(nextSession.id, (current) => ({
      ...current,
      claimedAt: new Date().toISOString(),
      claimCount: (current.claimCount ?? 0) + 1,
      updatedAt: new Date().toISOString()
    }))) ?? nextSession;

  return {
    bridgeSession: claimedSession,
    mediaWebsocketUrl: buildBridgeMediaWebSocketUrl(claimedSession.id)
  };
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

  if (payload.event === "prospect.message" && payload.text && updatedBridgeSession.voiceSessionId) {
    await injectProspectText({
      voiceSessionId: updatedBridgeSession.voiceSessionId,
      text: payload.text,
      correlationId
    });
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
