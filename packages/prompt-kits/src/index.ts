import type { CallBrief, Product, ResearchPacket } from "@aiautosales/domain-models";

export function buildResearchPrompt(input: {
  product: Product;
  companyName: string;
  companyWebsite?: string;
  contactName?: string;
  contactTitle?: string;
  notes?: string;
}): string {
  return [
    "You are the research brain for an autonomous B2B sales calling system.",
    `Product: ${input.product.name}`,
    `Offer summary: ${input.product.offerSummary}`,
    `ICP: ${input.product.icpSummary}`,
    `Company name: ${input.companyName}`,
    `Company website: ${input.companyWebsite ?? "unknown"}`,
    `Contact name: ${input.contactName ?? "unknown"}`,
    `Contact title: ${input.contactTitle ?? "unknown"}`,
    `Operator notes: ${input.notes ?? "none"}`,
    "Produce concise research that is useful for a live cold call."
  ].join("\n");
}

export function buildStrategyPrompt(input: {
  product: Product;
  researchPacket: ResearchPacket;
}): string {
  return [
    "You are the strategy brain for an autonomous B2B sales caller.",
    `Product: ${input.product.name}`,
    `Offer summary: ${input.product.offerSummary}`,
    `Research summary: ${input.researchPacket.companySummary}`,
    `Persona summary: ${input.researchPacket.personaSummary}`,
    `Pain points: ${input.researchPacket.pains.join("; ")}`,
    `Hooks: ${input.researchPacket.hooks.join("; ")}`,
    "Create a compact call brief optimized for a realtime voice sales agent."
  ].join("\n");
}

export function buildRealtimeSystemPrompt(input: {
  product: Product;
  callBrief: CallBrief;
}): string {
  return [
    "You are the speaking agent in a live outbound sales call.",
    "Be concise, confident, and natural.",
    "Ask one question at a time.",
    "Use micro-commitments rather than hard closes.",
    `Product: ${input.product.name}`,
    `Brief summary: ${input.callBrief.summary}`,
    `Value props: ${input.callBrief.valueProps.join("; ")}`,
    `Forbidden claims: ${input.callBrief.forbiddenClaims.join("; ")}`
  ].join("\n");
}

