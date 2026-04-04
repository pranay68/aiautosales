import { runReasoningPrompt } from "@aiautosales/azure-openai-client";
import { db } from "@aiautosales/db";
import type { CallBrief, Product, ResearchPacket } from "@aiautosales/domain-models";
import { buildStrategyPrompt } from "@aiautosales/prompt-kits";
import { createEvent } from "@aiautosales/shared-events";
import { log } from "@aiautosales/telemetry";

type StrategyInput = {
  prospectId: string;
  product: Product;
  researchPacket: ResearchPacket;
  correlationId: string;
};

export async function generateCallBrief(input: StrategyInput): Promise<CallBrief> {
  const prompt = buildStrategyPrompt({
    product: input.product,
    researchPacket: input.researchPacket
  });

  log("info", "strategy.start", {
    prospectId: input.prospectId,
    correlationId: input.correlationId,
    promptPreview: prompt.slice(0, 120)
  });

  const providerCall = await runReasoningPrompt({
    prompt,
    fallbackText: `Create a concise call brief for ${input.product.name} using the provided research.`
  });

  log("info", "strategy.provider_call", {
    prospectId: input.prospectId,
    correlationId: input.correlationId,
    ...providerCall
  });

  const companyReference = deriveCompanyReference(input.researchPacket.companySummary);

  const brief: CallBrief = {
    id: crypto.randomUUID(),
    workspaceId: input.product.workspaceId,
    prospectId: input.prospectId,
    productId: input.product.id,
    summary: `${input.researchPacket.companySummary} ${input.researchPacket.personaSummary}`,
    valueProps: [
      `${input.product.name} helps sales teams scale personalized outbound without adding manual prep work.`,
      "The system compresses prospect research, call planning, and live execution into one workflow.",
      "Teams can raise call output while staying more context-aware."
    ],
    painPoints: input.researchPacket.pains,
    proofPoints: [
      "shorter prep time per call",
      "better context per conversation",
      "higher consistency in call execution"
    ],
    openingLines: [
      `I'll be brief. I noticed teams like ${companyReference} often lose time on manual outbound prep, so I wanted to ask one quick question.`,
      "This is a cold call, but it is relevant. I think there may be a fit based on how your team likely handles outbound today."
    ],
    qualificationQuestions: [
      "How are you currently handling outbound research and call prep?",
      "Is improving rep output or meeting conversion a priority this quarter?",
      "How much of your current outreach is still manual?"
    ],
    objectionTree: [
      {
        objection: "not interested",
        intent: "brush-off",
        recommendedResponse: "Understood. Usually that means one of two things: timing is bad or the pitch feels irrelevant. Which one is closer?",
        followupQuestion: "Would it be unreasonable to ask one question to check relevance?"
      },
      {
        objection: "send me an email",
        intent: "deflection",
        recommendedResponse: "Happy to. To make the email useful, what is the main thing you would want it to address?",
        followupQuestion: "Is your bigger focus call volume, rep productivity, or conversion quality?"
      }
    ],
    ctaOptions: ["book_demo", "send_info", "callback"],
    riskFlags: input.researchPacket.confidence < 0.7 ? ["low_research_confidence"] : [],
    forbiddenClaims: [
      "guaranteed revenue increase",
      "false customer names",
      "claims not present in product facts"
    ],
    promptVersion: "strategy-v0.1",
    playbookVersion: "sales-playbook-v0.1",
    createdAt: new Date().toISOString()
  };

  await db.putCallBrief(brief);
  await db.appendEvent(createEvent("strategy.generated", input.prospectId, brief, input.correlationId));
  return brief;
}

function deriveCompanyReference(summary: string): string {
  const firstLine = summary.split("\n").find((line) => line.trim().length > 0) ?? "your team";
  const cleaned = firstLine
    .replace(/^#+\s*/, "")
    .replace(/\s+[—-].*$/, "")
    .replace(/[^\w\s&.-]/g, "")
    .trim();

  return cleaned || "your team";
}
