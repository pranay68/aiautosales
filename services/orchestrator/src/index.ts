import { db } from "@aiautosales/db";
import { markCallEnded, markCallStarted, queueOutboundCall } from "@aiautosales/dialer-service";
import type {
  CallBrief,
  CallSession,
  DirectCallRequest,
  PolicyDecision,
  Prospect,
  ResearchPacket
} from "@aiautosales/domain-models";
import { evaluateCall } from "@aiautosales/evaluation-worker";
import { createFollowupTask } from "@aiautosales/live-tool-service";
import { generateResearchPacket } from "@aiautosales/research-worker";
import { createEvent } from "@aiautosales/shared-events";
import { generateCallBrief } from "@aiautosales/strategy-worker";
import { createCorrelationId, log } from "@aiautosales/telemetry";
import { appendTranscriptTurn, startVoiceSession } from "@aiautosales/voice-gateway";

export type DirectWorkflowResult = {
  prospect: Prospect;
  researchPacket: ResearchPacket;
  callBrief: CallBrief;
  policyDecision: PolicyDecision;
  callSession?: CallSession;
  evaluation?: Awaited<ReturnType<typeof evaluateCall>>;
};

export async function runDirectLeadWorkflow(request: DirectCallRequest): Promise<DirectWorkflowResult> {
  const correlationId = createCorrelationId();
  await db.init();
  const product = await db.getProduct(request.productId);
  if (!product) {
    throw new Error(`Unknown product ${request.productId}`);
  }

  const now = new Date().toISOString();
  const company = await db.putCompany({
    id: crypto.randomUUID(),
    name: request.companyName,
    website: request.companyWebsite,
    phoneNumber: request.phoneNumber,
    createdAt: now
  });

  const contact = await db.putContact({
    id: crypto.randomUUID(),
    companyId: company.id,
    name: request.contactName,
    title: request.contactTitle,
    phoneNumber: request.phoneNumber,
    createdAt: now
  });

  const prospect = await db.putProspect({
    id: crypto.randomUUID(),
    productId: product.id,
    companyId: company.id,
    contactId: contact.id,
    state: "LEAD_CREATED",
    sourceMode: "direct",
    createdAt: now,
    updatedAt: now
  });

  await db.appendEvent(createEvent("prospect.created", prospect.id, prospect, correlationId));
  await db.appendEvent(createEvent("prospect.research.requested", prospect.id, request, correlationId));
  await db.updateProspect(prospect.id, (current) => ({ ...current, state: "RESEARCHING", updatedAt: new Date().toISOString() }));

  const researchPacket = await generateResearchPacket({
    prospectId: prospect.id,
    product,
    companyName: request.companyName,
    companyWebsite: request.companyWebsite,
    contactName: request.contactName,
    contactTitle: request.contactTitle,
    notes: request.notes,
    correlationId
  });

  const callBrief = await generateCallBrief({
    prospectId: prospect.id,
    product,
    researchPacket,
    correlationId
  });

  await db.updateProspect(prospect.id, (current) => ({ ...current, state: "STRATEGY_READY", updatedAt: new Date().toISOString() }));

  const policyDecision = runPolicyGate(prospect.id, callBrief, request);
  await db.putPolicyDecision(policyDecision);
  await db.appendEvent(createEvent("policy.checked", prospect.id, policyDecision, correlationId));

  const nextState =
    policyDecision.status === "allowed"
      ? "READY_TO_CALL"
      : policyDecision.status === "blocked"
        ? "BLOCKED"
        : "POLICY_CHECKED";

  await db.updateProspect(prospect.id, (current) => ({ ...current, state: nextState, updatedAt: new Date().toISOString() }));

  let callSession: CallSession | undefined;
  let evaluation: Awaited<ReturnType<typeof evaluateCall>> | undefined;

  if (policyDecision.status === "allowed" && request.autoStart !== false) {
    callSession = await queueOutboundCall({
      prospectId: prospect.id,
      callBrief,
      correlationId
    });

    await db.updateProspect(prospect.id, (current) => ({ ...current, state: "DIALING", updatedAt: new Date().toISOString() }));
    const startedSession = await markCallStarted(callSession.id, correlationId);
    if (!startedSession) {
      throw new Error("Failed to start call session");
    }

    const voiceSession = await startVoiceSession({
      callSessionId: startedSession.id,
      prospectId: prospect.id,
      product,
      callBrief,
      correlationId
    });

    await db.updateProspect(prospect.id, (current) => ({ ...current, state: "IN_CALL", updatedAt: new Date().toISOString() }));

    await appendTranscriptTurn({
      callSessionId: startedSession.id,
      speaker: "system",
      text: `Voice session ${voiceSession.voiceSessionId} created.`,
      correlationId
    });
    await appendTranscriptTurn({
      callSessionId: startedSession.id,
      speaker: "agent",
      text: callBrief.openingLines[0] ?? "I wanted to make a quick introduction.",
      correlationId
    });
    await appendTranscriptTurn({
      callSessionId: startedSession.id,
      speaker: "prospect",
      text: "You have thirty seconds. What is this about?",
      correlationId
    });
    await appendTranscriptTurn({
      callSessionId: startedSession.id,
      speaker: "agent",
      text: "Fair enough. We help teams cut manual call prep and improve outbound quality. Is manual research still slowing your reps down today?",
      correlationId
    });

    const completedSession = await markCallEnded(startedSession.id, "callback_requested", correlationId);
    if (completedSession) {
      callSession = completedSession;
      await db.updateProspect(prospect.id, (current) => ({ ...current, state: "CALL_COMPLETED", updatedAt: new Date().toISOString() }));
      const followupTask = await createFollowupTask({
        prospectId: prospect.id,
        callSessionId: completedSession.id,
        channel: "callback",
        summary: "Prospect asked for a callback after hearing the initial value proposition."
      });
      await db.appendEvent(createEvent("followup.created", prospect.id, followupTask, correlationId));
      await db.updateProspect(prospect.id, (current) => ({ ...current, state: "FOLLOWUP_GENERATED", updatedAt: new Date().toISOString() }));
      evaluation = await evaluateCall(completedSession.id);
      await db.appendEvent(createEvent("evaluation.completed", completedSession.id, evaluation, correlationId));
    }
  }

  const finalProspect = await db.getProspect(prospect.id);
  if (!finalProspect) {
    throw new Error("Prospect disappeared from store");
  }

  log("info", "workflow.direct.completed", {
    prospectId: finalProspect.id,
    correlationId,
    state: finalProspect.state
  });

  return {
    prospect: finalProspect,
    researchPacket,
    callBrief,
    policyDecision,
    callSession,
    evaluation
  };
}

function runPolicyGate(prospectId: string, callBrief: CallBrief, request: DirectCallRequest): PolicyDecision {
  const reasons: string[] = [];

  if (!request.phoneNumber) {
    reasons.push("Missing phone number.");
  }

  if (callBrief.riskFlags.includes("low_research_confidence")) {
    reasons.push("Low research confidence; operator review recommended.");
  }

  const status =
    reasons.length === 0 ? "allowed" : reasons.includes("Missing phone number.") ? "blocked" : "review_required";

  return {
    id: crypto.randomUUID(),
    prospectId,
    status,
    reasons,
    createdAt: new Date().toISOString()
  };
}
