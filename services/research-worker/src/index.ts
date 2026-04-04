import { runReasoningPrompt } from "@aiautosales/azure-openai-client";
import { db } from "@aiautosales/db";
import type { Product, ResearchPacket } from "@aiautosales/domain-models";
import { buildResearchPrompt } from "@aiautosales/prompt-kits";
import { createEvent } from "@aiautosales/shared-events";
import { log } from "@aiautosales/telemetry";

type ResearchInput = {
  prospectId: string;
  product: Product;
  companyName: string;
  companyWebsite?: string;
  contactName?: string;
  contactTitle?: string;
  notes?: string;
  correlationId: string;
};

export async function generateResearchPacket(input: ResearchInput): Promise<ResearchPacket> {
  const prompt = buildResearchPrompt({
    product: input.product,
    companyName: input.companyName,
    companyWebsite: input.companyWebsite,
    contactName: input.contactName,
    contactTitle: input.contactTitle,
    notes: input.notes
  });

  log("info", "research.start", {
    prospectId: input.prospectId,
    correlationId: input.correlationId,
    promptPreview: prompt.slice(0, 120)
  });

  const providerCall = await runReasoningPrompt({
    prompt,
    fallbackText: `${input.companyName} appears to be a relevant company for ${input.product.name}.`
  });

  log("info", "research.provider_call", {
    prospectId: input.prospectId,
    correlationId: input.correlationId,
    ...providerCall
  });

  const packet: ResearchPacket = {
    id: crypto.randomUUID(),
    workspaceId: input.product.workspaceId,
    prospectId: input.prospectId,
    companySummary: `${providerCall.text} The company likely values faster revenue workflows and cleaner outbound execution.`,
    personaSummary: input.contactTitle
      ? `${input.contactTitle} likely cares about pipeline quality, team productivity, and conversion efficiency.`
      : "The target contact likely cares about growth, efficiency, and measurable ROI.",
    pains: [
      "inconsistent outbound pipeline generation",
      "manual prospect research slowing outreach",
      "low conversion from generic messaging"
    ],
    hooks: [
      `Lead with relevance around ${input.product.name} improving response quality.`,
      "Use a short, insight-led opener instead of a feature dump.",
      "Anchor on faster pipeline generation and rep efficiency."
    ],
    buyingSignals: [
      "likely growth mandate",
      "possible need for sales process automation",
      "potential interest in higher output per rep"
    ],
    sourceNotes: [
      `Derived from direct-mode intake for ${input.companyName}.`,
      `Website supplied: ${input.companyWebsite ?? "no"}.`,
      `Contact supplied: ${input.contactName ?? "unknown"} / ${input.contactTitle ?? "unknown"}.`
    ],
    confidence: input.companyWebsite ? 0.78 : 0.62,
    createdAt: new Date().toISOString()
  };

  await db.putResearchPacket(packet);
  await db.appendEvent(createEvent("prospect.researched", input.prospectId, packet, input.correlationId));
  return packet;
}
