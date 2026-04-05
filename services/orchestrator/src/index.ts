import { db } from "@aiautosales/db";
import { createBridgeSession as createBridgeSessionInProcess } from "@aiautosales/bridge-gateway";
import { queueOutboundCall } from "@aiautosales/dialer-service";
import type {
  CallBrief,
  CallSession,
  DirectCallRequest,
  BridgeSession,
  PolicyDecision,
  Prospect,
  ResearchPacket
} from "@aiautosales/domain-models";
import { generateResearchPacket } from "@aiautosales/research-worker";
import { createEvent } from "@aiautosales/shared-events";
import { generateCallBrief } from "@aiautosales/strategy-worker";
import { loadEnv } from "@aiautosales/config";
import { createCorrelationId, log } from "@aiautosales/telemetry";

export type DirectWorkflowResult = {
  prospect: Prospect;
  researchPacket: ResearchPacket;
  callBrief: CallBrief;
  policyDecision: PolicyDecision;
  callSession?: CallSession;
  bridgeSession?: BridgeSession;
  evaluation?: undefined;
};

export async function runDirectLeadWorkflow(request: DirectCallRequest): Promise<DirectWorkflowResult> {
  const correlationId = createCorrelationId();
  await db.init();
  const workspaceId = request.workspaceId ?? "default";
  const product = await db.getProduct(request.productId);
  if (!product || product.workspaceId !== workspaceId) {
    throw new Error(`Unknown product ${request.productId}`);
  }

  const now = new Date().toISOString();
  const company = await db.putCompany({
    id: crypto.randomUUID(),
    workspaceId,
    name: request.companyName,
    website: request.companyWebsite,
    phoneNumber: request.phoneNumber,
    createdAt: now
  });

  const contact = await db.putContact({
    id: crypto.randomUUID(),
    workspaceId,
    companyId: company.id,
    name: request.contactName,
    title: request.contactTitle,
    phoneNumber: request.phoneNumber,
    createdAt: now
  });

  const prospect = await db.putProspect({
    id: crypto.randomUUID(),
    workspaceId,
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
  let bridgeSession: BridgeSession | undefined;
  let evaluation: undefined;

  if (policyDecision.status === "allowed" && request.autoStart !== false) {
    const env = loadEnv();
    callSession = await queueOutboundCall({
      prospectId: prospect.id,
      callBrief,
      correlationId
    });

    await db.updateProspect(prospect.id, (current) => ({ ...current, state: "DIALING", updatedAt: new Date().toISOString() }));
    const bridgeResult = await createLiveBridgeSession({
      callSessionId: callSession.id,
      prospectId: prospect.id,
      agentDestination: env.sonetelAgentDestination,
      correlationId
    });
    const createdBridgeSession = bridgeResult.bridgeSession;
    if (!createdBridgeSession) {
      throw new Error("Failed to create bridge session");
    }
    bridgeSession = createdBridgeSession;

    await db.updateProspect(prospect.id, (current) => ({ ...current, state: "DIALING", updatedAt: new Date().toISOString() }));

    await db.updateCallSession(callSession.id, (current) => ({
      ...current,
      providerMetadata: {
        ...(current.providerMetadata ?? {}),
        bridgeSessionId: createdBridgeSession.id,
        bridgeTransport: createdBridgeSession.transport,
        bridgeStatus: createdBridgeSession.status
      }
    }));

    await db.appendEvent(createEvent("call.bridge.updated", createdBridgeSession.id, createdBridgeSession, correlationId));

    /*
     * The live telephony ingress must now drive call progression.
     * We intentionally do not fabricate transcript turns or close the call here.
     */

    evaluation = undefined;
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
    bridgeSession,
    evaluation
  };
}

async function createLiveBridgeSession(input: {
  callSessionId: string;
  prospectId: string;
  agentDestination?: string;
  correlationId: string;
}) {
  const env = loadEnv();
  const bridgeBaseUrl = env.bridgeGatewayPublicBaseUrl || `http://127.0.0.1:${env.bridgeGatewayPort}`;
  try {
    const response = await fetch(`${bridgeBaseUrl}/bridge-sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": input.correlationId
      },
      body: JSON.stringify({
        callSessionId: input.callSessionId,
        prospectId: input.prospectId,
        transport: env.sonetelEnableLiveOutbound ? "sip" : "simulation",
        agentDestination: input.agentDestination
      })
    });

    if (!response.ok) {
      throw new Error(`Bridge session creation failed with status ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as { bridgeSession: BridgeSession };
  } catch (error) {
    const isLocalBridge =
      bridgeBaseUrl.includes("127.0.0.1") || bridgeBaseUrl.includes("localhost");
    if (!isLocalBridge) {
      throw error;
    }

    const result = await createBridgeSessionInProcess({
      callSessionId: input.callSessionId,
      prospectId: input.prospectId,
      transport: env.sonetelEnableLiveOutbound ? "sip" : "simulation",
      agentDestination: input.agentDestination,
      correlationId: input.correlationId
    });

    return { bridgeSession: result.bridgeSession };
  }
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
    workspaceId: request.workspaceId ?? "default",
    prospectId,
    status,
    reasons,
    createdAt: new Date().toISOString()
  };
}
