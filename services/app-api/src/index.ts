import express from "express";
import { z } from "zod";
import { Client, Connection } from "@temporalio/client";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import { getSonetelValidationSummary, handleSonetelWebhook } from "@aiautosales/dialer-service";
import { createFollowupTask, getCallBrief, lookupProductFact } from "@aiautosales/live-tool-service";
import { runDirectLeadWorkflow } from "@aiautosales/orchestrator";
import { createCorrelationId, log } from "@aiautosales/telemetry";

const app = express();
app.use(express.json());

app.use((request, _response, next) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  request.headers["x-correlation-id"] = correlationId;
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
  autoStart: z.boolean().optional()
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
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
    agentDestinationHint: env.sonetelAgentDestination || "sip:agent@your-sbc.example.com"
  });
});

app.get("/snapshot", (_request, response) => {
  db.snapshot().then((snapshot) => response.json(snapshot));
});

app.get("/products", (_request, response) => {
  db.listProducts().then((products) => response.json(products));
});

app.post("/products", async (request, response) => {
  const input = createProductSchema.parse(request.body);
  const product = await db.putProduct({
    id: crypto.randomUUID(),
    ...input,
    createdAt: new Date().toISOString()
  });

  log("info", "product.created", { productId: product.id });
  response.status(201).json(product);
});

app.post("/direct-calls", async (request, response) => {
  const input = directCallSchema.parse(request.body);
  const result = await runDirectLeadWorkflow(input);
  response.status(201).json(result);
});

app.post("/direct-calls/temporal", async (request, response) => {
  const input = directCallSchema.parse(request.body);
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

app.get("/prospects/:id", (request, response) => {
  db.getProspect(request.params.id).then(async (prospect) => {
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

app.get("/call-briefs/:id", async (request, response) => {
  const brief = await getCallBrief(request.params.id);
  if (!brief) {
    response.status(404).json({ error: "Call brief not found" });
    return;
  }

  response.json(brief);
});

app.get("/calls/:id", async (request, response) => {
  const session = await db.getCallSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Call session not found" });
    return;
  }

  response.json({
    session,
    transcript: await db.listTranscriptTurns(session.id)
  });
});

app.get("/calls/:id/transcript", (request, response) => {
  db.listTranscriptTurns(request.params.id).then((turns) => response.json(turns));
});

app.get("/product-facts/:productId", async (request, response) => {
  response.json(await lookupProductFact(request.params.productId));
});

app.post("/followups", async (request, response) => {
  const body = z
    .object({
      prospectId: z.string().min(1),
      callSessionId: z.string().min(1),
      channel: z.enum(["email", "sms", "callback"]),
      summary: z.string().min(1)
    })
    .parse(request.body);

  const followup = await createFollowupTask(body);
  response.status(201).json(followup);
});

app.post("/providers/sonetel/webhooks", async (request, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  response.json(await handleSonetelWebhook(request.body, correlationId));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
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
