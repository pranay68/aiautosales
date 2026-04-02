export type EntityId = string;

export type LeadState =
  | "LEAD_CREATED"
  | "RESEARCHING"
  | "STRATEGY_READY"
  | "POLICY_CHECKED"
  | "READY_TO_CALL"
  | "DIALING"
  | "IN_CALL"
  | "CALL_COMPLETED"
  | "FOLLOWUP_GENERATED"
  | "SEQUENCE_SCHEDULED"
  | "WON"
  | "LOST"
  | "NURTURE"
  | "BLOCKED";

export type Product = {
  id: EntityId;
  name: string;
  description: string;
  offerSummary: string;
  icpSummary: string;
  createdAt: string;
};

export type Company = {
  id: EntityId;
  name: string;
  website?: string;
  phoneNumber?: string;
  industry?: string;
  createdAt: string;
};

export type Contact = {
  id: EntityId;
  companyId: EntityId;
  name?: string;
  title?: string;
  phoneNumber: string;
  createdAt: string;
};

export type Prospect = {
  id: EntityId;
  productId: EntityId;
  companyId: EntityId;
  contactId: EntityId;
  state: LeadState;
  sourceMode: "direct" | "campaign";
  createdAt: string;
  updatedAt: string;
};

export type ResearchPacket = {
  id: EntityId;
  prospectId: EntityId;
  companySummary: string;
  personaSummary: string;
  pains: string[];
  hooks: string[];
  buyingSignals: string[];
  sourceNotes: string[];
  confidence: number;
  createdAt: string;
};

export type ObjectionNode = {
  objection: string;
  intent: string;
  recommendedResponse: string;
  followupQuestion: string;
};

export type CallBrief = {
  id: EntityId;
  prospectId: EntityId;
  productId: EntityId;
  summary: string;
  valueProps: string[];
  painPoints: string[];
  proofPoints: string[];
  openingLines: string[];
  qualificationQuestions: string[];
  objectionTree: ObjectionNode[];
  ctaOptions: string[];
  riskFlags: string[];
  forbiddenClaims: string[];
  promptVersion: string;
  playbookVersion: string;
  createdAt: string;
};

export type PolicyDecision = {
  id: EntityId;
  prospectId: EntityId;
  status: "allowed" | "blocked" | "review_required";
  reasons: string[];
  createdAt: string;
};

export type CallSession = {
  id: EntityId;
  prospectId: EntityId;
  callBriefId: EntityId;
  telephonyProvider: "sonetel";
  status: "queued" | "dialing" | "in_call" | "completed" | "failed";
  providerCallId?: string;
  providerStatus?: string;
  providerMetadata?: Record<string, unknown>;
  voiceSessionId?: string;
  strategyVersion: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: string;
  latencyMsP95?: number;
  createdAt: string;
};

export type FollowupTask = {
  id: EntityId;
  prospectId: EntityId;
  callSessionId: EntityId;
  channel: "email" | "sms" | "callback";
  summary: string;
  dueAt: string;
  status: "open" | "completed";
  createdAt: string;
};

export type TranscriptTurn = {
  id: EntityId;
  callSessionId: EntityId;
  speaker: "agent" | "prospect" | "system";
  text: string;
  timestamp: string;
};

export type DirectCallRequest = {
  productId: EntityId;
  companyName: string;
  companyWebsite?: string;
  phoneNumber: string;
  contactName?: string;
  contactTitle?: string;
  notes?: string;
  autoStart?: boolean;
};
