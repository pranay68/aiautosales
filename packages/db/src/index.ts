import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadEnv } from "@aiautosales/config";
import type {
  AuditEntry,
  BridgeSession,
  CallBrief,
  CallSession,
  Company,
  Contact,
  FollowupTask,
  IdempotencyRecord,
  OperatorAccount,
  OperatorSession,
  PolicyDecision,
  Product,
  Prospect,
  SequencePlan,
  ResearchPacket,
  TranscriptTurn,
  WorkflowRun,
  Workspace
} from "@aiautosales/domain-models";
import type { DomainEvent } from "@aiautosales/shared-events";

type RecordKind =
  | "products"
  | "companies"
  | "contacts"
  | "prospects"
  | "researchPackets"
  | "callBriefs"
  | "policyDecisions"
  | "callSessions"
  | "bridgeSessions"
  | "sequencePlans"
  | "transcriptTurns"
  | "followups"
  | "workspaces"
  | "operatorAccounts"
  | "operatorSessions"
  | "workflowRuns"
  | "idempotencyRecords"
  | "auditEntries";

type Store = {
  products: Map<string, Product>;
  companies: Map<string, Company>;
  contacts: Map<string, Contact>;
  prospects: Map<string, Prospect>;
  researchPackets: Map<string, ResearchPacket>;
  callBriefs: Map<string, CallBrief>;
  policyDecisions: Map<string, PolicyDecision>;
  callSessions: Map<string, CallSession>;
  bridgeSessions: Map<string, BridgeSession>;
  sequencePlans: Map<string, SequencePlan>;
  transcriptTurns: Map<string, TranscriptTurn>;
  followups: Map<string, FollowupTask>;
  workspaces: Map<string, Workspace>;
  operatorAccounts: Map<string, OperatorAccount>;
  operatorSessions: Map<string, OperatorSession>;
  workflowRuns: Map<string, WorkflowRun>;
  idempotencyRecords: Map<string, IdempotencyRecord>;
  auditEntries: Map<string, AuditEntry>;
  events: DomainEvent[];
};

const memoryStore: Store = {
  products: new Map(),
  companies: new Map(),
  contacts: new Map(),
  prospects: new Map(),
  researchPackets: new Map(),
  callBriefs: new Map(),
  policyDecisions: new Map(),
  callSessions: new Map(),
  bridgeSessions: new Map(),
  sequencePlans: new Map(),
  transcriptTurns: new Map(),
  followups: new Map(),
  workspaces: new Map(),
  operatorAccounts: new Map(),
  operatorSessions: new Map(),
  workflowRuns: new Map(),
  idempotencyRecords: new Map(),
  auditEntries: new Map(),
  events: []
};

let pool: Pool | undefined;
let initialized = false;

function hasWorkspaceId(value: unknown): value is { workspaceId: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "workspaceId" in value &&
      typeof (value as { workspaceId?: unknown }).workspaceId === "string"
  );
}

function getMap<T extends { id: string }>(kind: RecordKind): Map<string, T> {
  return memoryStore[kind] as unknown as Map<string, T>;
}

async function ensureInitialized(): Promise<void> {
  if (initialized) {
    return;
  }

  const env = loadEnv();
  if (env.dbProvider === "postgres") {
    pool = new Pool({
      connectionString: env.databaseUrl
    });

    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    const schemaSql = await readFile(schemaPath, "utf8");
    await pool.query(schemaSql);
  }

  initialized = true;
}

async function putRecord<T extends { id: string }>(kind: RecordKind, value: T): Promise<T> {
  await ensureInitialized();

  if (!pool) {
    getMap<T>(kind).set(value.id, value);
    return value;
  }

  await pool.query(
    `
      INSERT INTO app_records (kind, id, data, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [kind, value.id, JSON.stringify(value)]
  );

  return value;
}

async function getRecord<T>(kind: RecordKind, id: string): Promise<T | undefined> {
  await ensureInitialized();

  if (!pool) {
    return getMap<T & { id: string }>(kind).get(id) as T | undefined;
  }

  const result = await pool.query<{ data: T }>(
    "SELECT data FROM app_records WHERE kind = $1 AND id = $2",
    [kind, id]
  );

  return result.rows[0]?.data;
}

async function listRecords<T>(kind: RecordKind): Promise<T[]> {
  await ensureInitialized();

  if (!pool) {
    return Array.from(getMap<T & { id: string }>(kind).values()) as T[];
  }

  const result = await pool.query<{ data: T }>(
    "SELECT data FROM app_records WHERE kind = $1 ORDER BY created_at ASC",
    [kind]
  );

  return result.rows.map((row: { data: T }) => row.data);
}

async function updateRecord<T extends { id: string }>(
  kind: RecordKind,
  id: string,
  updater: (current: T) => T
): Promise<T | undefined> {
  const current = await getRecord<T>(kind, id);
  if (!current) {
    return undefined;
  }

  const next = updater(current);
  return putRecord(kind, next);
}

async function findOneBy<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<T | undefined> {
  const all = await listRecords<T>(kind);
  return all.find(predicate);
}

async function filterBy<T>(kind: RecordKind, predicate: (value: T) => boolean): Promise<T[]> {
  const all = await listRecords<T>(kind);
  return all.filter(predicate);
}

async function filterByWorkspace<T>(kind: RecordKind, workspaceId: string): Promise<T[]> {
  const all = await listRecords<T>(kind);
  return all.filter((entry) => hasWorkspaceId(entry) && entry.workspaceId === workspaceId);
}

export const db = {
  init: ensureInitialized,
  putProduct: (value: Product) => putRecord("products", value),
  putWorkspace: (value: Workspace) => putRecord("workspaces", value),
  getWorkspace: (id: string) => getRecord<Workspace>("workspaces", id),
  listWorkspaces: () => listRecords<Workspace>("workspaces"),
  putOperatorAccount: (value: OperatorAccount) => putRecord("operatorAccounts", value),
  getOperatorAccount: (id: string) => getRecord<OperatorAccount>("operatorAccounts", id),
  findOperatorAccountByEmail: (workspaceId: string, email: string) =>
    findOneBy<OperatorAccount>(
      "operatorAccounts",
      (entry) => entry.workspaceId === workspaceId && entry.email.toLowerCase() === email.toLowerCase()
    ),
  listOperatorAccountsByWorkspace: (workspaceId: string) =>
    filterByWorkspace<OperatorAccount>("operatorAccounts", workspaceId),
  updateOperatorAccount: (id: string, updater: (current: OperatorAccount) => OperatorAccount) =>
    updateRecord("operatorAccounts", id, updater),
  putOperatorSession: (value: OperatorSession) => putRecord("operatorSessions", value),
  getOperatorSession: (id: string) => getRecord<OperatorSession>("operatorSessions", id),
  findOperatorSessionByTokenHash: (tokenHash: string) =>
    findOneBy<OperatorSession>(
      "operatorSessions",
      (entry) => entry.tokenHash === tokenHash && !entry.revokedAt
    ),
  updateOperatorSession: (id: string, updater: (current: OperatorSession) => OperatorSession) =>
    updateRecord("operatorSessions", id, updater),
  putWorkflowRun: (value: WorkflowRun) => putRecord("workflowRuns", value),
  getWorkflowRun: (id: string) => getRecord<WorkflowRun>("workflowRuns", id),
  updateWorkflowRun: (id: string, updater: (current: WorkflowRun) => WorkflowRun) =>
    updateRecord("workflowRuns", id, updater),
  listWorkflowRunsByWorkspace: (workspaceId: string) =>
    filterByWorkspace<WorkflowRun>("workflowRuns", workspaceId),
  putIdempotencyRecord: (value: IdempotencyRecord) => putRecord("idempotencyRecords", value),
  findIdempotencyRecord: (workspaceId: string, scope: IdempotencyRecord["scope"], key: string) =>
    findOneBy<IdempotencyRecord>(
      "idempotencyRecords",
      (entry) => entry.workspaceId === workspaceId && entry.scope === scope && entry.key === key
    ),
  updateIdempotencyRecord: (id: string, updater: (current: IdempotencyRecord) => IdempotencyRecord) =>
    updateRecord("idempotencyRecords", id, updater),
  putAuditEntry: (value: AuditEntry) => putRecord("auditEntries", value),
  listAuditEntriesByWorkspace: (workspaceId: string) => filterByWorkspace<AuditEntry>("auditEntries", workspaceId),
  getProduct: (id: string) => getRecord<Product>("products", id),
  listProducts: () => listRecords<Product>("products"),
  listProductsByWorkspace: (workspaceId: string) => filterByWorkspace<Product>("products", workspaceId),
  putCompany: (value: Company) => putRecord("companies", value),
  getCompany: (id: string) => getRecord<Company>("companies", id),
  putContact: (value: Contact) => putRecord("contacts", value),
  getContact: (id: string) => getRecord<Contact>("contacts", id),
  putProspect: (value: Prospect) => putRecord("prospects", value),
  getProspect: (id: string) => getRecord<Prospect>("prospects", id),
  updateProspect: (id: string, updater: (current: Prospect) => Prospect) =>
    updateRecord("prospects", id, updater),
  listProspects: () => listRecords<Prospect>("prospects"),
  listProspectsByWorkspace: (workspaceId: string) => filterByWorkspace<Prospect>("prospects", workspaceId),
  putResearchPacket: (value: ResearchPacket) => putRecord("researchPackets", value),
  getResearchPacketByProspectId: (prospectId: string) =>
    findOneBy<ResearchPacket>("researchPackets", (entry) => entry.prospectId === prospectId),
  putCallBrief: (value: CallBrief) => putRecord("callBriefs", value),
  getCallBriefByProspectId: (prospectId: string) =>
    findOneBy<CallBrief>("callBriefs", (entry) => entry.prospectId === prospectId),
  getCallBrief: (id: string) => getRecord<CallBrief>("callBriefs", id),
  putPolicyDecision: (value: PolicyDecision) => putRecord("policyDecisions", value),
  getPolicyDecisionByProspectId: (prospectId: string) =>
    findOneBy<PolicyDecision>("policyDecisions", (entry) => entry.prospectId === prospectId),
  putCallSession: (value: CallSession) => putRecord("callSessions", value),
  getCallSession: (id: string) => getRecord<CallSession>("callSessions", id),
  updateCallSession: (id: string, updater: (current: CallSession) => CallSession) =>
    updateRecord("callSessions", id, updater),
  listCallSessions: () => listRecords<CallSession>("callSessions"),
  listCallSessionsByWorkspace: (workspaceId: string) => filterByWorkspace<CallSession>("callSessions", workspaceId),
  putBridgeSession: (value: BridgeSession) => putRecord("bridgeSessions", value),
  getBridgeSession: (id: string) => getRecord<BridgeSession>("bridgeSessions", id),
  updateBridgeSession: (id: string, updater: (current: BridgeSession) => BridgeSession) =>
    updateRecord("bridgeSessions", id, updater),
  listBridgeSessions: () => listRecords<BridgeSession>("bridgeSessions"),
  listBridgeSessionsByWorkspace: (workspaceId: string) => filterByWorkspace<BridgeSession>("bridgeSessions", workspaceId),
  getBridgeSessionByCallSessionId: (callSessionId: string) =>
    findOneBy<BridgeSession>("bridgeSessions", (entry) => entry.callSessionId === callSessionId),
  putSequencePlan: (value: SequencePlan) => putRecord("sequencePlans", value),
  getSequencePlan: (id: string) => getRecord<SequencePlan>("sequencePlans", id),
  listSequencePlans: () => listRecords<SequencePlan>("sequencePlans"),
  listSequencePlansByWorkspace: (workspaceId: string) => filterByWorkspace<SequencePlan>("sequencePlans", workspaceId),
  listSequencePlansByProspectId: (prospectId: string) =>
    filterBy<SequencePlan>("sequencePlans", (entry) => entry.prospectId === prospectId),
  getSequencePlanByCallSessionId: (callSessionId: string) =>
    findOneBy<SequencePlan>("sequencePlans", (entry) => entry.callSessionId === callSessionId),
  putTranscriptTurn: (value: TranscriptTurn) => putRecord("transcriptTurns", value),
  listTranscriptTurns: (callSessionId: string) =>
    filterBy<TranscriptTurn>("transcriptTurns", (entry) => entry.callSessionId === callSessionId),
  putFollowup: (value: FollowupTask) => putRecord("followups", value),
  listFollowups: () => listRecords<FollowupTask>("followups"),
  listFollowupsByWorkspace: (workspaceId: string) => filterByWorkspace<FollowupTask>("followups", workspaceId),
  listFollowupsByProspectId: (prospectId: string) =>
    filterBy<FollowupTask>("followups", (entry) => entry.prospectId === prospectId),
  appendEvent: async (event: DomainEvent) => {
    await ensureInitialized();

    if (!pool) {
      memoryStore.events.push(event);
      return event;
    }

    await pool.query(
      `
        INSERT INTO events_outbox (id, name, aggregate_id, payload, occurred_at, correlation_id)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      `,
      [event.id, event.name, event.aggregateId, JSON.stringify(event.payload), event.occurredAt, event.correlationId]
    );

    return event;
  },
  listEvents: async () => {
    await ensureInitialized();

    if (!pool) {
      return memoryStore.events;
    }

    const result = await pool.query<{
      id: string;
      name: DomainEvent["name"];
      aggregate_id: string;
      payload: unknown;
      occurred_at: Date;
      correlation_id: string;
    }>("SELECT * FROM events_outbox ORDER BY occurred_at ASC");

    return result.rows.map((row: {
      id: string;
      name: DomainEvent["name"];
      aggregate_id: string;
      payload: unknown;
      occurred_at: Date;
      correlation_id: string;
    }) => ({
      id: row.id,
      name: row.name,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      occurredAt: row.occurred_at.toISOString(),
      correlationId: row.correlation_id
    }));
  },
  listEventsByWorkspace: async (workspaceId: string) => {
    const events = await db.listEvents();
    return events.filter((event) => hasWorkspaceId(event.payload) && event.payload.workspaceId === workspaceId);
  },
  snapshot: async (workspaceId?: string) => ({
    workspaces: await db.listWorkspaces(),
    products: workspaceId ? await db.listProductsByWorkspace(workspaceId) : await db.listProducts(),
    prospects: workspaceId ? await db.listProspectsByWorkspace(workspaceId) : await db.listProspects(),
    callSessions: workspaceId ? await db.listCallSessionsByWorkspace(workspaceId) : await db.listCallSessions(),
    bridgeSessions: workspaceId ? await db.listBridgeSessionsByWorkspace(workspaceId) : await db.listBridgeSessions(),
    sequencePlans: workspaceId ? await db.listSequencePlansByWorkspace(workspaceId) : await db.listSequencePlans(),
    followups: workspaceId ? await db.listFollowupsByWorkspace(workspaceId) : await db.listFollowups(),
    workflowRuns: workspaceId ? await db.listWorkflowRunsByWorkspace(workspaceId) : await listRecords<WorkflowRun>("workflowRuns"),
    auditEntries: workspaceId ? await db.listAuditEntriesByWorkspace(workspaceId) : await listRecords<AuditEntry>("auditEntries"),
    events: workspaceId ? await db.listEventsByWorkspace(workspaceId) : await db.listEvents()
  })
};
