import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import { createCorrelationId, initializeTelemetry, log, withSpan } from "@aiautosales/telemetry";
import {
  buildBridgeMediaWebSocketUrl,
  claimNextBridgeSession,
  createBridgeSession,
  getBridgeSession,
  ingestBridgeEvent,
  listBridgeSessions
} from "./runtime.js";
import { subscribeVoicePlayback } from "@aiautosales/voice-gateway";

export {
  buildBridgeMediaWebSocketUrl,
  claimNextBridgeSession,
  createBridgeSession,
  getBridgeSession,
  ingestBridgeEvent,
  listBridgeSessions
};

initializeTelemetry("bridge-gateway");
export const app = express();
app.use(express.json());

app.use((request, response, next) => {
  const startedAt = Date.now();
  response.on("finish", () => {
    log("info", "http.request.completed", {
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      correlationId: request.header("x-correlation-id") ?? null
    });
  });
  next();
});

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
    mediaWebsocketIngressPath: "/bridge-sessions/:id/media",
    recommendedAgentDestinationFormat: "sip:agent@your-sbc.example.com",
    sonetelAgentDestination: env.sonetelAgentDestination || null,
    sonetelLiveOutboundEnabled: env.sonetelEnableLiveOutbound
  });
});

app.get("/bridge-sessions", async (_request, response) => {
  response.json(await listBridgeSessions());
});

app.get("/bridge-sessions/:id", async (request, response) => {
  const session = await getBridgeSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Bridge session not found" });
    return;
  }

  response.json(session);
});

app.post("/bridge-sessions", async (request, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  const body = request.body as {
    callSessionId?: string;
    prospectId?: string;
    transport?: "sip" | "websocket" | "simulation";
    agentDestination?: string;
  };

  if (!body.callSessionId || !body.prospectId) {
    response.status(400).json({ error: "callSessionId and prospectId are required" });
    return;
  }

  const callSessionId = body.callSessionId;
  const prospectId = body.prospectId;

  try {
    const result = await withSpan(
      "bridge-gateway.create-session",
      {
        "aiautosales.call_session_id": callSessionId,
        "aiautosales.prospect_id": prospectId,
        "aiautosales.transport": body.transport ?? "sip"
      },
      () =>
        createBridgeSession({
          callSessionId,
          prospectId,
          transport: body.transport,
          agentDestination: body.agentDestination,
          correlationId
        })
    );

    response.status(201).json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create bridge session"
    });
  }
});

app.post("/bridge-sessions/claim-next", async (_request, response) => {
  const claimed = await claimNextBridgeSession();
  if (!claimed) {
    response.status(404).json({ error: "No bridge sessions are waiting to be claimed" });
    return;
  }

  response.json(claimed);
});

app.post("/bridge-sessions/:id/events", async (request, response) => {
  const correlationId = request.header("x-correlation-id") ?? createCorrelationId();
  try {
    const session = await ingestBridgeEvent(request.params.id, request.body, correlationId);
    response.json({ ok: true, session });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to ingest bridge event"
    });
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown server error";
  response.status(500).json({ error: message });
});

export async function startBridgeGateway() {
  const env = loadEnv();
  await db.init();

  const server = createServer(app);
  const websocket = new WebSocketServer({ noServer: true });

  websocket.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const pathname = url.pathname;
    const isMediaStream = pathname.endsWith("/media");
    const sessionId = extractBridgeSessionId(pathname);
    void handleBridgeSocket(socket, sessionId, isMediaStream ? "media" : "events", url.searchParams.get("correlationId") ?? createCorrelationId());
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    if (
      !pathname.startsWith("/bridge-sessions/") ||
      !(pathname.endsWith("/media") || pathname.split("/").length >= 3)
    ) {
      socket.destroy();
      return;
    }

    websocket.handleUpgrade(request, socket, head, (ws) => {
      websocket.emit("connection", ws, request);
    });
  });

  server.listen(env.bridgeGatewayPort, () => {
    log("info", "bridge-gateway.started", {
      port: env.bridgeGatewayPort,
      bridgeGatewayPublicBaseUrl: env.bridgeGatewayPublicBaseUrl || null
    });
  });

  return server;
}

async function handleBridgeSocket(
  socket: WebSocket,
  sessionId: string,
  mode: "events" | "media",
  correlationId: string
) {
  const bridgeSession = await getBridgeSession(sessionId);
  if (!bridgeSession) {
    socket.close(1008, "bridge session not found");
    return;
  }

  let playbackDetach: (() => void) | undefined;
  let finalized = false;

  const publishPlayback = (payload: Record<string, unknown>) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(payload));
  };

  if (bridgeSession.voiceSessionId) {
    playbackDetach = subscribeVoicePlayback(bridgeSession.voiceSessionId, (event) => {
      if (event.type === "audio.delta") {
        publishPlayback({
          event: "streamAudio",
          data: {
            audioDataType: "raw",
            sampleRate: 8000,
            audioData: event.audio,
            responseId: event.responseId ?? null
          }
        });
      }

      if (event.type === "audio.done") {
        publishPlayback({
          event: "streamAudio.done",
          data: {
            responseId: event.responseId ?? null
          }
        });
      }
    });
  }

  socket.send(
    JSON.stringify({
      ok: true,
      sessionId,
      mode,
      status: "connected",
      mediaWebsocketUrl: mode === "media" ? buildBridgeMediaWebSocketUrl(sessionId) : undefined
    })
  );

  if (mode === "media") {
    try {
      await ingestBridgeEvent(
        sessionId,
        {
          event: "session.connected",
          metadata: {
            transport: bridgeSession.transport,
            mode: "media"
          }
        },
        correlationId
      );
    } catch (error) {
      log("warn", "bridge-gateway.media.connect_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      socket.close(1011, "failed to connect bridge session");
      playbackDetach?.();
      return;
    }
  }

  socket.on("message", async (message, isBinary) => {
    if (isBinary) {
      const audio = bufferToBase64(message);
      try {
        await ingestBridgeEvent(
          sessionId,
          {
            event: "audio.append",
            audio,
            metadata: {
              transport: mode,
              encoding: "binary"
            }
          },
          correlationId
        );
      } catch (error) {
        log("warn", "bridge-gateway.audio.append_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const payload = parseWebsocketPayload(message.toString());
    if (!payload) {
      return;
    }

    try {
      await ingestBridgeEvent(sessionId, payload, payload.correlationId ?? correlationId);
    } catch (error) {
      log("warn", "bridge-gateway.websocket.message_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  socket.on("close", async () => {
    playbackDetach?.();

    if (finalized) {
      return;
    }

    const current = await getBridgeSession(sessionId);
    if (!current || current.status === "completed" || current.status === "failed") {
      return;
    }

    finalized = true;
    try {
      await ingestBridgeEvent(
        sessionId,
        {
          event: "session.completed",
          outcome: "disconnected",
          metadata: {
            transport: mode,
            reason: "socket_closed"
          }
        },
        correlationId
      );
    } catch (error) {
      log("warn", "bridge-gateway.websocket.close_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function parseWebsocketPayload(raw: string): {
  event:
    | "session.connected"
    | "session.disconnected"
    | "session.completed"
    | "session.failed"
    | "transcript"
    | "audio.append"
    | "audio.commit"
    | "audio.clear"
    | "response.create"
    | "prospect.message";
  speaker?: "agent" | "prospect" | "system";
  text?: string;
  audio?: string;
  outcome?: string;
  followupSummary?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
} | undefined {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const event = String(payload.event ?? "");
    if (
      event !== "session.connected" &&
      event !== "session.disconnected" &&
      event !== "session.completed" &&
      event !== "session.failed" &&
      event !== "transcript" &&
      event !== "audio.append" &&
      event !== "audio.commit" &&
      event !== "audio.clear" &&
      event !== "response.create" &&
      event !== "prospect.message"
    ) {
      return undefined;
    }

    return {
      event,
      speaker:
        payload.speaker === "agent" || payload.speaker === "prospect" || payload.speaker === "system"
          ? payload.speaker
          : undefined,
      text: typeof payload.text === "string" ? payload.text : undefined,
      audio: typeof payload.audio === "string" ? payload.audio : undefined,
      outcome: typeof payload.outcome === "string" ? payload.outcome : undefined,
      followupSummary: typeof payload.followupSummary === "string" ? payload.followupSummary : undefined,
      metadata: payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>) : undefined,
      correlationId: typeof payload.correlationId === "string" ? payload.correlationId : undefined
    };
  } catch {
    return undefined;
  }
}

function bufferToBase64(message: unknown): string {
  if (Buffer.isBuffer(message)) {
    return message.toString("base64");
  }

  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("base64");
  }

  if (Array.isArray(message)) {
    return Buffer.concat(message.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part as ArrayBuffer))).toString("base64");
  }

  return Buffer.from(String(message)).toString("base64");
}

function extractBridgeSessionId(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "bridge-sessions") {
    return parts[1];
  }

  if (parts.length === 3 && parts[0] === "bridge-sessions" && parts[2] === "media") {
    return parts[1];
  }

  return parts[parts.length - 1] ?? "";
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false;
if (isDirectRun) {
  void startBridgeGateway();
}
