import express from "express";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Client, Connection } from "@temporalio/client";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import { getBridgeSession, ingestBridgeEvent, listBridgeSessions } from "@aiautosales/bridge-gateway";
import { getSonetelValidationSummary, handleSonetelWebhook } from "@aiautosales/dialer-service";
import { createFollowupTask, getCallBrief, lookupProductFact } from "@aiautosales/live-tool-service";
import { runDirectLeadWorkflow } from "@aiautosales/orchestrator";
import { createCorrelationId, initializeTelemetry, log, withSpan } from "@aiautosales/telemetry";

initializeTelemetry("app-api");
const app = express();
app.use(express.json());

type WorkspaceRequest = express.Request & {
  workspaceId?: string;
  operator?: {
    id: string;
    workspaceId: string;
    email: string;
    name: string;
    role: string;
  };
};

const bootstrapWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  operatorName: z.string().min(1),
  operatorEmail: z.string().email(),
  password: z.string().min(8)
});

const loginSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8)
});

function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

app.use((request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "content-type, x-correlation-id, x-api-key, authorization, x-idempotency-key, x-workspace-id");
  response.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use((request, _response, next) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  request.headers["x-correlation-id"] = correlationId;
  next();
});

app.use((request: WorkspaceRequest, _response, next) => {
  const env = loadEnv();
  request.workspaceId = request.header("x-workspace-id") ?? env.defaultWorkspaceId;
  next();
});

app.use((request: WorkspaceRequest, response, next) => {
  const startedAt = Date.now();
  response.on("finish", () => {
    log("info", "http.request.completed", {
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      correlationId: request.header("x-correlation-id") ?? null,
      workspaceId: request.workspaceId ?? null
    });
  });
  next();
});

app.use(async (request: WorkspaceRequest, response, next) => {
  const env = loadEnv();
  const isHealthRequest = request.path === "/health" && env.allowUnauthenticatedHealth;
  const isBootstrapRequest = request.path === "/auth/bootstrap";
  const isLoginRequest = request.path === "/auth/login";

  if (isHealthRequest || isBootstrapRequest || isLoginRequest) {
    next();
    return;
  }

  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const hashed = hashToken(token);
    const session = await db.findOperatorSessionByTokenHash(hashed);
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      response.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    const operator = await db.getOperatorAccount(session.operatorId);
    if (!operator || !operator.active) {
      response.status(401).json({ error: "Operator account unavailable" });
      return;
    }

    const requestedWorkspaceId = request.header("x-workspace-id");
    if (requestedWorkspaceId && requestedWorkspaceId !== session.workspaceId) {
      response.status(403).json({ error: "Workspace mismatch" });
      return;
    }

    request.workspaceId = session.workspaceId;
    request.operator = {
      id: operator.id,
      workspaceId: operator.workspaceId,
      email: operator.email,
      name: operator.name,
      role: operator.role
    };
    next();
    return;
  }

  if (!env.operatorApiKey) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const apiKey = request.header("x-api-key");
  if (apiKey !== env.operatorApiKey) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  offerSummary: z.string().min(1),
  icpSummary: z.string().min(1)
});

const directCallSchema = z.object({
  productId: z.string().min(1),
  companyName: z.string().min(1),
  companyWebsite: z.string().optional(),
  phoneNumber: z.string().min(1),
  contactName: z.string().optional(),
  contactTitle: z.string().optional(),
  notes: z.string().optional(),
  autoStart: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional()
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/diagnostics/summary", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const [workflowRuns, callSessions, bridgeSessions, followups, auditEntries, sonetel] = await Promise.all([
    db.listWorkflowRunsByWorkspace(workspaceId),
    db.listCallSessionsByWorkspace(workspaceId),
    db.listBridgeSessionsByWorkspace(workspaceId),
    db.listFollowupsByWorkspace(workspaceId),
    db.listAuditEntriesByWorkspace(workspaceId),
    getSonetelValidationSummary()
  ]);

  const failedRuns = workflowRuns.filter((entry) => entry.status === "failed");
  const failedCalls = callSessions.filter((entry) => entry.status === "failed");
  const failedBridges = bridgeSessions.filter((entry) => entry.status === "failed");
  const overdueFollowups = followups.filter(
    (entry) => entry.status === "open" && new Date(entry.dueAt).getTime() < Date.now()
  );

  response.json({
    workspaceId,
    providerReadiness: {
      sonetel,
      bridgeLiveReady: Boolean(loadEnv().sonetelAgentDestination && loadEnv().bridgeGatewayPublicBaseUrl)
    },
    failureCounts: {
      workflowRuns: failedRuns.length,
      callSessions: failedCalls.length,
      bridgeSessions: failedBridges.length,
      overdueFollowups: overdueFollowups.length
    },
    latestFailures: {
      workflowRun: failedRuns.at(-1) ?? null,
      callSession: failedCalls.at(-1) ?? null,
      bridgeSession: failedBridges.at(-1) ?? null
    },
    latestAuditEntry: auditEntries.at(-1) ?? null
  });
});

app.get("/diagnostics/failures", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const [workflowRuns, callSessions, bridgeSessions] = await Promise.all([
    db.listWorkflowRunsByWorkspace(workspaceId),
    db.listCallSessionsByWorkspace(workspaceId),
    db.listBridgeSessionsByWorkspace(workspaceId)
  ]);

  response.json({
    workflowRuns: workflowRuns.filter((entry) => entry.status === "failed"),
    callSessions: callSessions.filter((entry) => entry.status === "failed"),
    bridgeSessions: bridgeSessions.filter((entry) => entry.status === "failed")
  });
});

app.post("/auth/bootstrap", async (request, response) => {
  const env = loadEnv();
  if (!env.operatorApiKey || request.header("x-api-key") !== env.operatorApiKey) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const input = bootstrapWorkspaceSchema.parse(request.body);
  const existingWorkspace = await db.getWorkspace(input.workspaceId);
  const existingOperator = await db.findOperatorAccountByEmail(input.workspaceId, input.operatorEmail);
  if (existingWorkspace || existingOperator) {
    response.status(409).json({ error: "Workspace or operator already exists" });
    return;
  }

  const now = new Date().toISOString();
  const workspace = await db.putWorkspace({
    id: input.workspaceId,
    name: input.workspaceName,
    createdAt: now
  });
  const { hash, salt } = hashPassword(input.password);
  const operator = await db.putOperatorAccount({
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    email: input.operatorEmail.toLowerCase(),
    name: input.operatorName,
    role: "admin",
    passwordHash: hash,
    passwordSalt: salt,
    active: true,
    createdAt: now
  });
  await db.putAuditEntry({
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    operatorId: operator.id,
    action: "workspace.bootstrapped",
    resourceType: "workspace",
    resourceId: workspace.id,
    metadata: {
      by: "operator_api_key"
    },
    createdAt: now
  });

  response.status(201).json({
    workspace,
    operator: sanitizeOperator(operator)
  });
});

app.post("/auth/login", async (request, response) => {
  const input = loginSchema.parse(request.body);
  const operator = await db.findOperatorAccountByEmail(input.workspaceId, input.email);
  if (!operator || !operator.active || !verifyPassword(input.password, operator.passwordSalt, operator.passwordHash)) {
    response.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const now = Date.now();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now + 1000 * 60 * 60 * 24).toISOString();
  const session = await db.putOperatorSession({
    id: crypto.randomUUID(),
    workspaceId: operator.workspaceId,
    operatorId: operator.id,
    tokenHash: hashToken(token),
    expiresAt,
    createdAt: new Date(now).toISOString()
  });
  await db.updateOperatorAccount(operator.id, (current) => ({
    ...current,
    lastLoginAt: new Date(now).toISOString()
  }));
  await db.putAuditEntry({
    id: crypto.randomUUID(),
    workspaceId: operator.workspaceId,
    operatorId: operator.id,
    action: "operator.logged_in",
    resourceType: "operator_session",
    resourceId: session.id,
    createdAt: new Date(now).toISOString()
  });

  response.json({
    token,
    expiresAt,
    operator: sanitizeOperator(operator)
  });
});

app.get("/me", async (request: WorkspaceRequest, response) => {
  if (!request.operator) {
    response.status(401).json({ error: "No operator session" });
    return;
  }

  const workspace = await db.getWorkspace(request.operator.workspaceId);
  response.json({
    operator: request.operator,
    workspace
  });
});

app.get("/workflow-runs", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  response.json(await db.listWorkflowRunsByWorkspace(workspaceId));
});

app.get("/audit-entries", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  response.json(await db.listAuditEntriesByWorkspace(workspaceId));
});

app.get("/providers/sonetel/validate", async (_request, response) => {
  response.json(await getSonetelValidationSummary());
});

app.get("/providers/bridge/validate", (_request, response) => {
  const env = loadEnv();
  response.json({
    bridgeGatewayPort: env.bridgeGatewayPort,
    bridgeGatewayPublicBaseUrlPresent: Boolean(env.bridgeGatewayPublicBaseUrl),
    sonetelAgentDestinationPresent: Boolean(env.sonetelAgentDestination),
    liveOutboundReady: Boolean(env.sonetelAgentDestination && env.sonetelOutgoingCallerId),
    agentDestinationHint: env.sonetelAgentDestination || "sip:agent@your-sbc.example.com",
    mediaWebsocketHint: `${env.bridgeGatewayPublicBaseUrl || `http://localhost:${env.bridgeGatewayPort}`}/bridge-sessions/:id/media`
  });
});

app.get("/bridge-sessions", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const sessions = await listBridgeSessions();
  response.json(sessions.filter((entry) => entry.workspaceId === workspaceId));
});

app.get("/bridge-sessions/:id", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const bridgeSessionId = getRouteParam(request.params.id);
  const session = await getBridgeSession(bridgeSessionId);
  if (!session || session.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Bridge session not found" });
    return;
  }

  response.json(session);
});

app.post("/bridge-sessions/:id/events", async (request: WorkspaceRequest, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const bridgeSessionId = getRouteParam(request.params.id);
  const session = await getBridgeSession(bridgeSessionId);
  if (!session || session.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Bridge session not found" });
    return;
  }

  try {
    response.json(await ingestBridgeEvent(bridgeSessionId, request.body, correlationId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown bridge event error";
    response.status(400).json({ error: message });
  }
});

app.get("/snapshot", (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  db.snapshot(workspaceId).then((snapshot) => response.json(snapshot));
});

app.get("/dashboard", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const [products, prospects, callSessions, bridgeSessions, sequencePlans, followups, events, workflowRuns, auditEntries] =
    await Promise.all([
      db.listProductsByWorkspace(workspaceId),
      db.listProspectsByWorkspace(workspaceId),
      db.listCallSessionsByWorkspace(workspaceId),
      db.listBridgeSessionsByWorkspace(workspaceId),
      db.listSequencePlansByWorkspace(workspaceId),
      db.listFollowupsByWorkspace(workspaceId),
      db.listEventsByWorkspace(workspaceId),
      db.listWorkflowRunsByWorkspace(workspaceId),
      db.listAuditEntriesByWorkspace(workspaceId)
    ]);

  response.json({
    counts: {
      products: products.length,
      prospects: prospects.length,
      callSessions: callSessions.length,
      bridgeSessions: bridgeSessions.length,
      sequencePlans: sequencePlans.length,
      followups: followups.length,
      events: events.length,
      workflowRuns: workflowRuns.length,
      auditEntries: auditEntries.length
    },
    latest: {
      product: products.at(-1) ?? null,
      prospect: prospects.at(-1) ?? null,
      callSession: callSessions.at(-1) ?? null,
      bridgeSession: bridgeSessions.at(-1) ?? null,
      sequencePlan: sequencePlans.at(-1) ?? null,
      followup: followups.at(-1) ?? null,
      event: events.at(-1) ?? null,
      workflowRun: workflowRuns.at(-1) ?? null,
      auditEntry: auditEntries.at(-1) ?? null
    }
  });
});

app.get("/products", (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  db.listProductsByWorkspace(workspaceId).then((products) => response.json(products));
});

app.post("/products", async (request: WorkspaceRequest, response) => {
  const input = createProductSchema.parse(request.body);
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const product = await db.putProduct({
    id: crypto.randomUUID(),
    workspaceId,
    ...input,
    createdAt: new Date().toISOString()
  });

  log("info", "product.created", { productId: product.id });
  await db.putAuditEntry({
    id: crypto.randomUUID(),
    workspaceId,
    operatorId: request.operator?.id,
    action: "product.created",
    resourceType: "product",
    resourceId: product.id,
    metadata: {
      name: product.name
    },
    createdAt: new Date().toISOString()
  });
  response.status(201).json(product);
});

app.post("/direct-calls", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const idempotencyKey =
    request.header("x-idempotency-key") ?? (typeof request.body?.idempotencyKey === "string" ? request.body.idempotencyKey : undefined);
  const input = directCallSchema.parse({
    ...request.body,
    workspaceId,
    operatorId: request.operator?.id,
    idempotencyKey
  });
  const execution = await executeDirectCall(
    {
      ...input,
      workspaceId,
      operatorId: request.operator?.id,
      idempotencyKey
    },
    request.header("x-correlation-id") ?? createCorrelationId()
  );
  response.status(execution.replayed ? 200 : 201).json(execution);
});

app.post("/direct-calls/temporal", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const idempotencyKey =
    request.header("x-idempotency-key") ?? (typeof request.body?.idempotencyKey === "string" ? request.body.idempotencyKey : undefined);
  const parsed = directCallSchema.parse({ ...request.body, workspaceId, idempotencyKey });
  const input = {
    ...parsed,
    workspaceId,
    operatorId: request.operator?.id,
    idempotencyKey
  };
  const env = loadEnv();
  const connection = await Connection.connect({
    address: env.temporalAddress
  });
  const client = new Client({
    connection,
    namespace: env.temporalNamespace
  });

  const handle = await client.workflow.start("directLeadWorkflow", {
    args: [input],
    taskQueue: env.temporalTaskQueue,
    workflowId: `direct-${crypto.randomUUID()}`
  });

  response.status(202).json({
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId
  });
});

app.get("/prospects/:id", (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  db.getProspect(getRouteParam(request.params.id)).then(async (prospect) => {
    if (prospect && prospect.workspaceId !== workspaceId) {
      response.status(404).json({ error: "Prospect not found" });
      return;
    }

    if (!prospect) {
      response.status(404).json({ error: "Prospect not found" });
      return;
    }

    response.json({
      prospect,
      callBrief: await db.getCallBriefByProspectId(prospect.id),
      researchPacket: await db.getResearchPacketByProspectId(prospect.id),
      policyDecision: await db.getPolicyDecisionByProspectId(prospect.id),
      followups: await db.listFollowupsByProspectId(prospect.id)
    });
  });
});

app.get("/call-briefs/:id", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const brief = await getCallBrief(getRouteParam(request.params.id));
  if (!brief || brief.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Call brief not found" });
    return;
  }

  response.json(brief);
});

app.get("/calls/:id", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const session = await db.getCallSession(getRouteParam(request.params.id));
  if (!session || session.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Call session not found" });
    return;
  }

  response.json({
    session,
    transcript: await db.listTranscriptTurns(session.id)
  });
});

app.get("/calls/:id/transcript", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const callSessionId = getRouteParam(request.params.id);
  const session = await db.getCallSession(callSessionId);
  if (!session || session.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Call session not found" });
    return;
  }

  response.json(await db.listTranscriptTurns(callSessionId));
});

app.get("/sequence-plans", (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  db.listSequencePlansByWorkspace(workspaceId).then((plans) => response.json(plans));
});

app.get("/sequence-plans/:id", (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  db.getSequencePlan(getRouteParam(request.params.id)).then((plan) => {
    if (!plan || plan.workspaceId !== workspaceId) {
      response.status(404).json({ error: "Sequence plan not found" });
      return;
    }

    response.json(plan);
  });
});

app.get("/product-facts/:productId", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const productId = getRouteParam(request.params.productId);
  const product = await db.getProduct(productId);
  if (!product || product.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Product not found" });
    return;
  }

  response.json(await lookupProductFact(productId));
});

app.post("/followups", async (request: WorkspaceRequest, response) => {
  const workspaceId = request.workspaceId ?? loadEnv().defaultWorkspaceId;
  const body = z
    .object({
      prospectId: z.string().min(1),
      callSessionId: z.string().min(1),
      channel: z.enum(["email", "sms", "callback", "meeting"]),
      summary: z.string().min(1)
    })
    .parse(request.body);

  const prospect = await db.getProspect(body.prospectId);
  if (!prospect || prospect.workspaceId !== workspaceId) {
    response.status(404).json({ error: "Prospect not found" });
    return;
  }

  const followup = await createFollowupTask(body);
  response.status(201).json(followup);
});

app.post("/providers/sonetel/webhooks", async (request, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  response.json(await handleSonetelWebhook(request.body, correlationId));
});

async function executeDirectCall(input: z.infer<typeof directCallSchema> & {
  workspaceId: string;
  operatorId?: string;
  idempotencyKey?: string;
}, correlationId: string) {
  const requestPayload = input as unknown as Record<string, unknown>;
  const requestHash = hashJson(requestPayload);
  const idempotencyKey = input.idempotencyKey;

  if (idempotencyKey) {
    const existing = await db.findIdempotencyRecord(input.workspaceId, "direct_call", idempotencyKey);
    if (existing?.status === "completed" && existing.responsePayload) {
      return {
        replayed: true,
        workflowRunId: existing.workflowRunId ?? null,
        ...existing.responsePayload
      };
    }

    if (existing?.status === "in_progress") {
      throw new Error("A direct call with this idempotency key is already in progress.");
    }

    if (existing?.status === "failed" && existing.requestHash !== requestHash) {
      throw new Error("Idempotency key has already been used with a different request payload.");
    }
  }

  const workflowRun = await db.putWorkflowRun({
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    type: "direct_call",
    status: "in_progress",
    requestPayload,
    correlationId,
    idempotencyKey,
    operatorId: input.operatorId,
    startedAt: new Date().toISOString()
  });

  let idempotencyRecordId: string | undefined;
  if (idempotencyKey) {
    const record = await db.putIdempotencyRecord({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      scope: "direct_call",
      key: idempotencyKey,
      requestHash,
      status: "in_progress",
      workflowRunId: workflowRun.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    idempotencyRecordId = record.id;
  }

  try {
    const result = await withSpan(
      "app-api.direct-call",
      {
        "aiautosales.workspace_id": input.workspaceId,
        "aiautosales.product_id": input.productId,
        "aiautosales.workflow_run_id": workflowRun.id
      },
      () => runDirectLeadWorkflow(input)
    );

    const responsePayload = {
      prospect: result.prospect,
      researchPacket: result.researchPacket,
      callBrief: result.callBrief,
      policyDecision: result.policyDecision,
      callSession: result.callSession,
      bridgeSession: result.bridgeSession,
      evaluation: result.evaluation
    } as Record<string, unknown>;

    await db.updateWorkflowRun(workflowRun.id, (current) => ({
      ...current,
      status: "completed",
      resultPayload: responsePayload,
      completedAt: new Date().toISOString()
    }));

    if (idempotencyRecordId) {
      await db.updateIdempotencyRecord(idempotencyRecordId, (current) => ({
        ...current,
        status: "completed",
        responsePayload,
        updatedAt: new Date().toISOString()
      }));
    }

    await db.putAuditEntry({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      operatorId: input.operatorId,
      action: "direct_call.executed",
      resourceType: "workflow_run",
      resourceId: workflowRun.id,
      metadata: {
        prospectId: result.prospect.id,
        callSessionId: result.callSession?.id ?? null
      },
      createdAt: new Date().toISOString()
    });

    return {
      replayed: false,
      workflowRunId: workflowRun.id,
      ...responsePayload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateWorkflowRun(workflowRun.id, (current) => ({
      ...current,
      status: "failed",
      errorMessage: message,
      completedAt: new Date().toISOString()
    }));

    if (idempotencyRecordId) {
      await db.updateIdempotencyRecord(idempotencyRecordId, (current) => ({
        ...current,
        status: "failed",
        errorMessage: message,
        updatedAt: new Date().toISOString()
      }));
    }

    await db.putAuditEntry({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      operatorId: input.operatorId,
      action: "direct_call.failed",
      resourceType: "workflow_run",
      resourceId: workflowRun.id,
      metadata: {
        error: message
      },
      createdAt: new Date().toISOString()
    });
    throw error;
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = pbkdf2Sync(password, salt, 120000, 64, "sha512");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function hashJson(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sanitizeOperator(operator: {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
}) {
  return {
    id: operator.id,
    workspaceId: operator.workspaceId,
    email: operator.email,
    name: operator.name,
    role: operator.role,
    active: operator.active,
    createdAt: operator.createdAt,
    lastLoginAt: operator.lastLoginAt
  };
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  log("error", "app-api.request_failed", {
    error: error instanceof Error ? error.message : "Unknown server error"
  });
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: "Validation failed",
      details: error.flatten()
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  response.status(500).json({ error: message });
});

const env = loadEnv();
db.init().then(() => {
  app.listen(env.appApiPort, () => {
    log("info", "app-api.started", { port: env.appApiPort, dbProvider: env.dbProvider });
  });
});
