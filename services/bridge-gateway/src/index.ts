import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import { buildRealtimeSessionConfig } from "@aiautosales/azure-openai-client";
import type { CallBrief, Product } from "@aiautosales/domain-models";
import { buildRealtimeSystemPrompt } from "@aiautosales/prompt-kits";
import { createCorrelationId, log } from "@aiautosales/telemetry";
import { startVoiceSession, appendTranscriptTurn } from "@aiautosales/voice-gateway";

type BridgeSession = {
  id: string;
  callSessionId: string;
  prospectId: string;
  status: "created" | "connecting" | "connected" | "closed";
  transport: "sip" | "websocket" | "simulation";
  agentDestination: string;
  voiceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastEvent?: unknown;
};

const sessions = new Map<string, BridgeSession>();

const app = express();
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/bridge-config", (_request, response) => {
  const env = loadEnv();
  const bridgeBaseUrl = env.bridgeGatewayPublicBaseUrl || `http://localhost:${env.bridgeGatewayPort}`;
  response.json({
    bridgeGatewayPort: env.bridgeGatewayPort,
    bridgeGatewayPublicBaseUrl: env.bridgeGatewayPublicBaseUrl || null,
    bridgeBaseUrl,
    websocketIngressPath: "/bridge-sessions/:id",
    recommendedAgentDestinationFormat: "sip:agent@your-sbc.example.com",
    sonetelAgentDestination: env.sonetelAgentDestination || null,
    sonetelLiveOutboundEnabled: env.sonetelEnableLiveOutbound
  });
});

app.post("/bridge-sessions", async (request, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  const body = request.body as {
    callSessionId?: string;
    prospectId?: string;
    transport?: BridgeSession["transport"];
    agentDestination?: string;
  };

  if (!body.callSessionId || !body.prospectId) {
    response.status(400).json({ error: "callSessionId and prospectId are required" });
    return;
  }

  const callSession = await db.getCallSession(body.callSessionId);
  if (!callSession) {
    response.status(404).json({ error: "Call session not found" });
    return;
  }

  const prospect = await db.getProspect(body.prospectId);
  if (!prospect) {
    response.status(404).json({ error: "Prospect not found" });
    return;
  }

  const brief = await db.getCallBriefByProspectId(prospect.id);
  const product = await db.getProduct(prospect.productId);
  if (!brief || !product) {
    response.status(409).json({ error: "Missing call brief or product for bridge session" });
    return;
  }

  const sessionId = `bridge_${crypto.randomUUID()}`;
  const agentDestination = body.agentDestination ?? loadEnv().sonetelAgentDestination;
  const now = new Date().toISOString();
  const transport = body.transport ?? "sip";

  sessions.set(sessionId, {
    id: sessionId,
    callSessionId: body.callSessionId,
    prospectId: body.prospectId,
    status: "created",
    transport,
    agentDestination,
    createdAt: now,
    updatedAt: now
  });

  const voiceSession = await startVoiceSession({
    callSessionId: body.callSessionId,
    prospectId: body.prospectId,
    product: product as Product,
    callBrief: brief as CallBrief,
    correlationId
  });

  sessions.set(sessionId, {
    ...sessions.get(sessionId)!,
    status: "connecting",
    voiceSessionId: voiceSession.voiceSessionId,
    updatedAt: new Date().toISOString()
  });

  response.status(201).json({
    id: sessionId,
    callSessionId: body.callSessionId,
    prospectId: body.prospectId,
    transport,
    agentDestination,
    voiceSessionId: voiceSession.voiceSessionId,
    realtime: buildRealtimeSessionConfig(voiceSession.systemPrompt)
  });
});

app.get("/bridge-sessions/:id", (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Bridge session not found" });
    return;
  }

  response.json(session);
});

app.post("/bridge-sessions/:id/events", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Bridge session not found" });
    return;
  }

  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  const payload = request.body as { speaker?: "agent" | "prospect" | "system"; text?: string };

  session.lastEvent = payload;
  session.updatedAt = new Date().toISOString();
  sessions.set(session.id, session);

  if (payload.text && payload.speaker) {
    await appendTranscriptTurn({
      callSessionId: session.callSessionId,
      speaker: payload.speaker,
      text: payload.text,
      correlationId
    });
  }

  response.json({ ok: true, session });
});

const server = createServer(app);
const websocket = new WebSocketServer({ noServer: true });

websocket.on("connection", (socket, request) => {
  const sessionId = new URL(request.url ?? "", "http://localhost").pathname.split("/").pop() ?? "";
  const session = sessions.get(sessionId);

  if (!session) {
    socket.close(1008, "Bridge session not found");
    return;
  }

  session.status = "connected";
  session.updatedAt = new Date().toISOString();
  sessions.set(session.id, session);

  socket.send(JSON.stringify({ ok: true, sessionId, status: session.status }));

  socket.on("message", (message) => {
    session.lastEvent = message.toString();
    session.updatedAt = new Date().toISOString();
    sessions.set(session.id, session);
  });

  socket.on("close", () => {
    const current = sessions.get(session.id);
    if (!current) {
      return;
    }

    sessions.set(session.id, {
      ...current,
      status: "closed",
      updatedAt: new Date().toISOString()
    });
  });
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "", "http://localhost").pathname;
  if (!pathname.startsWith("/bridge-sessions/")) {
    socket.destroy();
    return;
  }

  websocket.handleUpgrade(request, socket, head, (ws) => {
    websocket.emit("connection", ws, request);
  });
});

const env = loadEnv();
db.init().then(() => {
  server.listen(env.bridgeGatewayPort, () => {
    log("info", "bridge-gateway.started", {
      port: env.bridgeGatewayPort,
      bridgeGatewayPublicBaseUrl: env.bridgeGatewayPublicBaseUrl || null
    });
  });
});
