import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadEnv } from "@aiautosales/config";
import type {
  BridgeSession,
  CallBrief,
  CallSession,
  Company,
  Contact,
  FollowupTask,
  PolicyDecision,
  Product,
  Prospect,
  SequencePlan,
  ResearchPacket,
  TranscriptTurn
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
  | "followups";

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
  events: []
};

let pool: Pool | undefined;
let initialized = false;

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

export const db = {
  init: ensureInitialized,
  putProduct: (value: Product) => putRecord("products", value),
  getProduct: (id: string) => getRecord<Product>("products", id),
  listProducts: () => listRecords<Product>("products"),
  putCompany: (value: Company) => putRecord("companies", value),
  putContact: (value: Contact) => putRecord("contacts", value),
  getContact: (id: string) => getRecord<Contact>("contacts", id),
  putProspect: (value: Prospect) => putRecord("prospects", value),
  getProspect: (id: string) => getRecord<Prospect>("prospects", id),
  updateProspect: (id: string, updater: (current: Prospect) => Prospect) =>
    updateRecord("prospects", id, updater),
  listProspects: () => listRecords<Prospect>("prospects"),
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
  putBridgeSession: (value: BridgeSession) => putRecord("bridgeSessions", value),
  getBridgeSession: (id: string) => getRecord<BridgeSession>("bridgeSessions", id),
  updateBridgeSession: (id: string, updater: (current: BridgeSession) => BridgeSession) =>
    updateRecord("bridgeSessions", id, updater),
  listBridgeSessions: () => listRecords<BridgeSession>("bridgeSessions"),
  getBridgeSessionByCallSessionId: (callSessionId: string) =>
    findOneBy<BridgeSession>("bridgeSessions", (entry) => entry.callSessionId === callSessionId),
  putSequencePlan: (value: SequencePlan) => putRecord("sequencePlans", value),
  getSequencePlan: (id: string) => getRecord<SequencePlan>("sequencePlans", id),
  listSequencePlans: () => listRecords<SequencePlan>("sequencePlans"),
  listSequencePlansByProspectId: (prospectId: string) =>
    filterBy<SequencePlan>("sequencePlans", (entry) => entry.prospectId === prospectId),
  getSequencePlanByCallSessionId: (callSessionId: string) =>
    findOneBy<SequencePlan>("sequencePlans", (entry) => entry.callSessionId === callSessionId),
  putTranscriptTurn: (value: TranscriptTurn) => putRecord("transcriptTurns", value),
  listTranscriptTurns: (callSessionId: string) =>
    filterBy<TranscriptTurn>("transcriptTurns", (entry) => entry.callSessionId === callSessionId),
  putFollowup: (value: FollowupTask) => putRecord("followups", value),
  listFollowups: () => listRecords<FollowupTask>("followups"),
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
  snapshot: async () => ({
    products: await db.listProducts(),
    prospects: await db.listProspects(),
    callSessions: await db.listCallSessions(),
    bridgeSessions: await db.listBridgeSessions(),
    sequencePlans: await db.listSequencePlans(),
    followups: await db.listFollowups(),
    events: await db.listEvents()
  })
};
