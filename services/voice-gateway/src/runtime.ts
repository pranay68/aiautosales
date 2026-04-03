import WebSocket from "ws";
import { buildRealtimeSessionConfig } from "@aiautosales/azure-openai-client";
import { loadEnv } from "@aiautosales/config";
import { db } from "@aiautosales/db";
import type { CallBrief, Product, TranscriptTurn } from "@aiautosales/domain-models";
import { buildRealtimeSystemPrompt } from "@aiautosales/prompt-kits";
import { createEvent } from "@aiautosales/shared-events";
import { log } from "@aiautosales/telemetry";

type VoiceSessionStatus = "created" | "connecting" | "active" | "failed" | "closed";

type VoiceSessionRecord = {
  id: string;
  callSessionId: string;
  prospectId: string;
  systemPrompt: string;
  realtimeConfig: ReturnType<typeof buildRealtimeSessionConfig>;
  status: VoiceSessionStatus;
  socket?: WebSocket;
  connectedAt?: string;
  lastEvent?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type VoicePlaybackEvent =
  | {
      type: "audio.delta";
      audio: string;
      responseId?: string;
    }
  | {
      type: "audio.done";
      responseId?: string;
    }
  | {
      type: "text.delta";
      text: string;
      responseId?: string;
    }
  | {
      type: "text.done";
      text: string;
      responseId?: string;
    }
  | {
      type: "transcript.done";
      transcript: string;
      responseId?: string;
    };

type VoicePlaybackListener = (event: VoicePlaybackEvent) => void;

type StartVoiceSessionInput = {
  callSessionId: string;
  prospectId: string;
  product: Product;
  callBrief: CallBrief;
  correlationId: string;
};

const sessions = new Map<string, VoiceSessionRecord>();
const playbackListeners = new Map<string, Set<VoicePlaybackListener>>();

export async function startVoiceSession(
  input: StartVoiceSessionInput
): Promise<{ voiceSessionId: string; systemPrompt: string }> {
  const voiceSessionId = `voice_${crypto.randomUUID()}`;
  const systemPrompt = buildRealtimeSystemPrompt({
    product: input.product,
    callBrief: input.callBrief
  });
  const realtimeConfig = buildRealtimeSessionConfig(systemPrompt);
  const env = loadEnv();
  const now = new Date().toISOString();

  const session: VoiceSessionRecord = {
    id: voiceSessionId,
    callSessionId: input.callSessionId,
    prospectId: input.prospectId,
    systemPrompt,
    realtimeConfig,
    status: "created",
    createdAt: now,
    updatedAt: now
  };

  sessions.set(voiceSessionId, session);

  await db.updateCallSession(input.callSessionId, (current) => ({
    ...current,
    voiceSessionId
  }));

  await db.appendEvent(
    createEvent(
      "call.turn.logged",
      input.prospectId,
      {
        voiceSessionId,
        kind: "session_started",
        provider: realtimeConfig.provider,
        deployment: realtimeConfig.deployment,
        live: realtimeConfig.live,
        voice: env.azureOpenAiRealtimeVoice,
        turnDetection: realtimeConfig.session.session.audio?.input?.turn_detection?.type,
        transcriptionModel: realtimeConfig.session.session.audio?.input?.transcription?.model,
        maxOutputTokens: env.azureOpenAiRealtimeMaxOutputTokens
      },
      input.correlationId
    )
  );

  return { voiceSessionId, systemPrompt };
}

export async function activateVoiceSession(voiceSessionId: string, correlationId: string) {
  const session = sessions.get(voiceSessionId);
  if (!session) {
    throw new Error(`Unknown voice session ${voiceSessionId}`);
  }

  if (session.socket && session.socket.readyState === WebSocket.OPEN) {
    return session;
  }

  const env = loadEnv();
  if (!env.azureOpenAiEndpoint || !env.azureOpenAiApiKey || !env.azureOpenAiRealtimeDeployment) {
    session.status = "failed";
    session.updatedAt = new Date().toISOString();
    throw new Error("Azure OpenAI realtime is not configured.");
  }

  const url = buildAzureRealtimeUrl(env.azureOpenAiEndpoint, env.azureOpenAiRealtimeDeployment);
  const socket = new WebSocket(url, {
    headers: {
      "api-key": env.azureOpenAiApiKey
    }
  });

  session.socket = socket;
  session.status = "connecting";
  session.updatedAt = new Date().toISOString();

  socket.on("open", () => {
    log("info", "voice-gateway.realtime.open", {
      voiceSessionId,
      correlationId
    });
    socket.send(JSON.stringify(session.realtimeConfig.session));
  });

  socket.on("message", async (data) => {
    const event = parseRealtimeEvent(data.toString());
    if (!event) {
      return;
    }

    session.lastEvent = event;
    session.updatedAt = new Date().toISOString();

    try {
      await handleRealtimeEvent(session, event, correlationId);
    } catch (error) {
      log("warn", "voice-gateway.realtime.event_failed", {
        voiceSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  socket.on("error", (error) => {
    session.status = "failed";
    session.updatedAt = new Date().toISOString();
    log("warn", "voice-gateway.realtime.error", {
      voiceSessionId,
      error: error.message
    });
  });

  socket.on("close", () => {
    session.status = "closed";
    session.updatedAt = new Date().toISOString();
  });

  await db.appendEvent(
    createEvent(
      "call.turn.logged",
      session.prospectId,
      {
        voiceSessionId,
        kind: "realtime_connecting",
        endpoint: url.toString()
      },
      correlationId
    )
  );

  return session;
}

export async function requestVoiceResponse(voiceSessionId: string, correlationId: string) {
  const session = await ensureActiveSession(voiceSessionId, correlationId);
  session.socket?.send(
    JSON.stringify({
      type: "response.create",
      response: {
        conversation: "auto",
        output_modalities: ["audio"],
        instructions: session.systemPrompt
      } as Record<string, unknown>
    })
  );
}

export async function appendAudioChunk(input: {
  voiceSessionId: string;
  audio: string;
  correlationId: string;
}) {
  const session = await ensureActiveSession(input.voiceSessionId, input.correlationId);
  session.socket?.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: input.audio
    })
  );
  await db.appendEvent(
    createEvent(
      "call.turn.logged",
      session.prospectId,
      {
        voiceSessionId: session.id,
        kind: "audio.append"
      },
      input.correlationId
    )
  );
}

export async function commitAudioBuffer(voiceSessionId: string, correlationId: string) {
  const session = await ensureActiveSession(voiceSessionId, correlationId);
  session.socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
}

export async function clearAudioBuffer(voiceSessionId: string, correlationId: string) {
  const session = await ensureActiveSession(voiceSessionId, correlationId);
  session.socket?.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
}

export async function closeVoiceSession(voiceSessionId: string, reason: string) {
  const session = sessions.get(voiceSessionId);
  if (!session) {
    return;
  }

  session.socket?.close(1000, reason);
  session.status = "closed";
  session.updatedAt = new Date().toISOString();
  playbackListeners.delete(voiceSessionId);
}

export function subscribeVoicePlayback(voiceSessionId: string, listener: VoicePlaybackListener) {
  const listeners = playbackListeners.get(voiceSessionId) ?? new Set<VoicePlaybackListener>();
  listeners.add(listener);
  playbackListeners.set(voiceSessionId, listeners);

  return () => {
    const current = playbackListeners.get(voiceSessionId);
    if (!current) {
      return;
    }

    current.delete(listener);
    if (current.size === 0) {
      playbackListeners.delete(voiceSessionId);
    }
  };
}

export function getVoiceSession(voiceSessionId: string) {
  return sessions.get(voiceSessionId);
}

export function listVoiceSessions() {
  return Array.from(sessions.values());
}

async function ensureActiveSession(voiceSessionId: string, correlationId: string) {
  const session = sessions.get(voiceSessionId);
  if (!session) {
    throw new Error(`Unknown voice session ${voiceSessionId}`);
  }

  if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
    await activateVoiceSession(voiceSessionId, correlationId);
  }

  return sessions.get(voiceSessionId) ?? session;
}

async function handleRealtimeEvent(
  session: VoiceSessionRecord,
  event: Record<string, unknown>,
  correlationId: string
) {
  switch (String(event.type ?? "")) {
    case "session.created":
    case "session.updated":
      session.status = "active";
      await db.appendEvent(
        createEvent(
          "call.turn.logged",
          session.prospectId,
          {
            voiceSessionId: session.id,
            kind: String(event.type),
            event
          },
          correlationId
        )
      );
      if (String(event.type) === "session.updated") {
        await requestVoiceResponse(session.id, correlationId);
      }
      return;
    case "input_audio_buffer.speech_started":
      if (shouldInterrupt(session)) {
        session.socket?.send(JSON.stringify({ type: "response.cancel" }));
      }
      return;
    case "conversation.item.input_audio_transcription.completed":
      if (typeof event.transcript === "string" && event.transcript.trim()) {
        await appendTranscriptTurn({
          callSessionId: session.callSessionId,
          speaker: "prospect",
          text: event.transcript,
          correlationId
        });
      }
      return;
    case "response.audio.delta":
    case "response.output_audio.delta":
      if (typeof event.delta === "string" && event.delta.trim()) {
        emitVoicePlayback(session.id, {
          type: "audio.delta",
          audio: event.delta,
          responseId: getResponseId(event)
        });
      }
      return;
    case "response.audio.done":
    case "response.output_audio.done":
      emitVoicePlayback(session.id, {
        type: "audio.done",
        responseId: getResponseId(event)
      });
      return;
    case "response.text.done":
      if (typeof event.text === "string" && event.text.trim()) {
        emitVoicePlayback(session.id, {
          type: "text.done",
          text: event.text,
          responseId: getResponseId(event)
        });
        await appendTranscriptTurn({
          callSessionId: session.callSessionId,
          speaker: "agent",
          text: event.text,
          correlationId
        });
      }
      return;
    case "response.text.delta":
      if (typeof event.delta === "string" && event.delta.trim()) {
        emitVoicePlayback(session.id, {
          type: "text.delta",
          text: event.delta,
          responseId: getResponseId(event)
        });
      }
      return;
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done":
      if (typeof event.transcript === "string" && event.transcript.trim()) {
        emitVoicePlayback(session.id, {
          type: "transcript.done",
          transcript: event.transcript,
          responseId: getResponseId(event)
        });
        await appendTranscriptTurn({
          callSessionId: session.callSessionId,
          speaker: "agent",
          text: event.transcript,
          correlationId
        });
      }
      return;
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
      if (typeof event.delta === "string" && event.delta.trim()) {
        emitVoicePlayback(session.id, {
          type: "text.delta",
          text: event.delta,
          responseId: getResponseId(event)
        });
      }
      return;
    case "response.done":
      await appendAgentTranscriptFromResponseDone(session, event, correlationId);
      return;
    case "error":
      session.status = "failed";
      await db.appendEvent(
        createEvent(
          "call.turn.logged",
          session.prospectId,
          {
            voiceSessionId: session.id,
            kind: "realtime_error",
            event
          },
          correlationId
        )
      );
      return;
    default:
      return;
  }
}

function shouldInterrupt(session: VoiceSessionRecord): boolean {
  const turnDetection = session.realtimeConfig.session.session.audio?.input?.turn_detection;
  if (!turnDetection || typeof turnDetection !== "object") {
    return true;
  }

  if ("interrupt_response" in turnDetection) {
    return Boolean((turnDetection as { interrupt_response?: boolean }).interrupt_response);
  }

  return true;
}

function buildAzureRealtimeUrl(endpoint: string, deployment: string): URL {
  const url = new URL(`${endpoint.replace(/\/$/, "").replace(/^https:/, "wss:")}/openai/v1/realtime`);
  url.searchParams.set("model", deployment);
  return url;
}

function parseRealtimeEvent(raw: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    return typeof payload.type === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
}

async function appendAgentTranscriptFromResponseDone(
  session: VoiceSessionRecord,
  event: Record<string, unknown>,
  correlationId: string
) {
  const response = event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : undefined;
  const output = Array.isArray(response?.output) ? (response?.output as Array<Record<string, unknown>>) : [];

  for (const item of output) {
    const content = Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : [];
    for (const part of content) {
      const text = typeof part.transcript === "string" ? part.transcript : typeof part.text === "string" ? part.text : "";
      if (text.trim()) {
        await appendTranscriptTurn({
          callSessionId: session.callSessionId,
          speaker: "agent",
          text,
          correlationId
        });
      }
    }
  }
}

function emitVoicePlayback(voiceSessionId: string, event: VoicePlaybackEvent) {
  const listeners = playbackListeners.get(voiceSessionId);
  if (!listeners || listeners.size === 0) {
    return;
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      continue;
    }
  }
}

function getResponseId(event: Record<string, unknown>): string | undefined {
  const response = event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : undefined;
  const responseId = response?.id ?? response?.response_id ?? event.response_id ?? event.id;
  return typeof responseId === "string" ? responseId : undefined;
}

export async function appendTranscriptTurn(input: {
  callSessionId: string;
  speaker: "agent" | "prospect" | "system";
  text: string;
  correlationId: string;
}): Promise<TranscriptTurn> {
  const session = await db.getCallSession(input.callSessionId);
  if (!session) {
    throw new Error(`Unknown call session ${input.callSessionId}`);
  }

  const turn: TranscriptTurn = {
    id: crypto.randomUUID(),
    callSessionId: input.callSessionId,
    speaker: input.speaker,
    text: input.text,
    timestamp: new Date().toISOString()
  };

  await db.putTranscriptTurn(turn);
  await db.appendEvent(createEvent("call.turn.logged", session.prospectId, turn, input.correlationId));
  return turn;
}
