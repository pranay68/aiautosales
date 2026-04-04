import { db } from "@aiautosales/db";
import type { CallBrief, CallSession } from "@aiautosales/domain-models";
import { createEvent } from "@aiautosales/shared-events";
import {
  executeSonetelOutboundCall,
  normalizeSonetelWebhookEvent,
  validateSonetelConfiguration
} from "./sonetel-adapter.js";

type DialCallInput = {
  prospectId: string;
  callBrief: CallBrief;
  correlationId: string;
};

export async function queueOutboundCall(input: DialCallInput): Promise<CallSession> {
  const prospect = await db.getProspect(input.prospectId);
  if (!prospect) {
    throw new Error(`Unknown prospect ${input.prospectId}`);
  }

  const contact = await db.getContact(prospect.contactId);
  if (!contact?.phoneNumber) {
    throw new Error(`Prospect ${input.prospectId} does not have a callable phone number.`);
  }

  const sonetelResult = await executeSonetelOutboundCall({
    to: contact.phoneNumber,
    prospectId: input.prospectId
  });

  const session: CallSession = {
    id: crypto.randomUUID(),
    workspaceId: prospect.workspaceId,
    prospectId: input.prospectId,
    callBriefId: input.callBrief.id,
    telephonyProvider: "sonetel",
    status: sonetelResult.live ? "dialing" : "queued",
    providerCallId: sonetelResult.providerCallId,
    providerStatus: sonetelResult.providerStatus,
    providerMetadata: {
      endpoint: sonetelResult.endpoint,
      live: sonetelResult.live,
      requestPayload: sonetelResult.payload,
      rawResponse: sonetelResult.rawResponse
    },
    strategyVersion: input.callBrief.promptVersion,
    createdAt: new Date().toISOString()
  };

  await db.putCallSession(session);
  await db.appendEvent(createEvent("call.requested", input.prospectId, session, input.correlationId));
  return session;
}

export async function handleSonetelWebhook(payload: unknown, correlationId: string) {
  const normalized = normalizeSonetelWebhookEvent(payload);
  const sessions = await db.listCallSessions();
  const session = sessions.find((entry) => entry.providerCallId === normalized.providerCallId);

  if (!session) {
    return {
      matched: false,
      normalized
    };
  }

  const nextStatus =
    normalized.providerStatus === "completed"
      ? "completed"
      : normalized.providerStatus === "failed"
        ? "failed"
        : normalized.providerStatus === "in_call"
          ? "in_call"
          : session.status;

  const updated = await db.updateCallSession(session.id, (current) => ({
    ...current,
    status: nextStatus,
    providerStatus: normalized.providerStatus,
    providerMetadata: {
      ...(current.providerMetadata ?? {}),
      lastWebhook: normalized.payload
    }
  }));

  if (updated) {
    await db.appendEvent(createEvent("call.turn.logged", updated.prospectId, normalized, correlationId));
  }

  return {
    matched: Boolean(updated),
    normalized,
    session: updated
  };
}

export async function getSonetelValidationSummary() {
  return validateSonetelConfiguration();
}

export async function markCallStarted(callSessionId: string, correlationId: string): Promise<CallSession | undefined> {
  const session = await db.updateCallSession(callSessionId, (current) => ({
    ...current,
    status: "in_call",
    startedAt: new Date().toISOString()
  }));

  if (session) {
    await db.appendEvent(createEvent("call.started", session.prospectId, session, correlationId));
  }

  return session;
}

export async function markCallEnded(
  callSessionId: string,
  outcome: string,
  correlationId: string
): Promise<CallSession | undefined> {
  const session = await db.updateCallSession(callSessionId, (current) => ({
    ...current,
    status: "completed",
    endedAt: new Date().toISOString(),
    outcome,
    latencyMsP95: 680
  }));

  if (session) {
    await db.appendEvent(createEvent("call.ended", session.prospectId, session, correlationId));
  }

  return session;
}
