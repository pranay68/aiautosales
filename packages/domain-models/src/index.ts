export type EntityId = string;
export type OperatorRole = "admin" | "operator" | "reviewer" | "analyst";

export type Workspace = {
  id: EntityId;
  name: string;
  createdAt: string;
};

export type OperatorAccount = {
  id: EntityId;
  workspaceId: EntityId;
  email: string;
  name: string;
  role: OperatorRole;
  passwordHash: string;
  passwordSalt: string;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
};

export type OperatorSession = {
  id: EntityId;
  workspaceId: EntityId;
  operatorId: EntityId;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
};

export type WorkflowRun = {
  id: EntityId;
  workspaceId: EntityId;
  type: "direct_call";
  status: "in_progress" | "completed" | "failed";
  requestPayload: Record<string, unknown>;
  resultPayload?: Record<string, unknown>;
  errorMessage?: string;
  correlationId: string;
  idempotencyKey?: string;
  operatorId?: EntityId;
  startedAt: string;
  completedAt?: string;
};

export type IdempotencyRecord = {
  id: EntityId;
  workspaceId: EntityId;
  scope: "direct_call";
  key: string;
  requestHash: string;
  status: "in_progress" | "completed" | "failed";
  workflowRunId?: EntityId;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditEntry = {
  id: EntityId;
  workspaceId: EntityId;
  operatorId?: EntityId;
  action: string;
  resourceType: string;
  resourceId: EntityId;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

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
  workspaceId: EntityId;
  name: string;
  description: string;
  offerSummary: string;
  icpSummary: string;
  createdAt: string;
};

export type Company = {
  id: EntityId;
  workspaceId: EntityId;
  name: string;
  website?: string;
  phoneNumber?: string;
  industry?: string;
  createdAt: string;
};

export type Contact = {
  id: EntityId;
  workspaceId: EntityId;
  companyId: EntityId;
  name?: string;
  title?: string;
  phoneNumber: string;
  createdAt: string;
};

export type Prospect = {
  id: EntityId;
  workspaceId: EntityId;
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
  workspaceId: EntityId;
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
  workspaceId: EntityId;
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
  workspaceId: EntityId;
  prospectId: EntityId;
  status: "allowed" | "blocked" | "review_required";
  reasons: string[];
  createdAt: string;
};

export type CallSession = {
  id: EntityId;
  workspaceId: EntityId;
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

export type BridgeSession = {
  id: EntityId;
  workspaceId: EntityId;
  callSessionId: EntityId;
  prospectId: EntityId;
  status: "created" | "connecting" | "connected" | "streaming" | "completed" | "failed" | "closed";
  transport: "sip" | "websocket" | "simulation";
  agentDestination: string;
  voiceSessionId?: string;
  claimedAt?: string;
  claimCount?: number;
  lastEvent?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type FollowupTask = {
  id: EntityId;
  workspaceId: EntityId;
  prospectId: EntityId;
  callSessionId: EntityId;
  channel: "email" | "sms" | "callback" | "meeting";
  summary: string;
  dueAt: string;
  status: "open" | "completed";
  createdAt: string;
};

export type SequencePlan = {
  id: EntityId;
  workspaceId: EntityId;
  prospectId: EntityId;
  callSessionId: EntityId;
  outcome: string;
  recommendedChannel: FollowupTask["channel"];
  nextState: LeadState;
  summary: string;
  nextTouchAt: string;
  createdAt: string;
};

export type TranscriptTurn = {
  id: EntityId;
  workspaceId: EntityId;
  callSessionId: EntityId;
  speaker: "agent" | "prospect" | "system";
  text: string;
  timestamp: string;
};

export type DirectCallRequest = {
  workspaceId?: EntityId;
  operatorId?: EntityId;
  idempotencyKey?: string;
  productId: EntityId;
  companyName: string;
  companyWebsite?: string;
  phoneNumber: string;
  contactName?: string;
  contactTitle?: string;
  notes?: string;
  autoStart?: boolean;
};
