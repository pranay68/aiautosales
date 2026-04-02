import { buildRealtimeSessionConfig } from "@aiautosales/azure-openai-client";
import { db } from "@aiautosales/db";
import type { CallBrief, Product, TranscriptTurn } from "@aiautosales/domain-models";
import { buildRealtimeSystemPrompt } from "@aiautosales/prompt-kits";
import { createEvent } from "@aiautosales/shared-events";

type StartVoiceSessionInput = {
  callSessionId: string;
  prospectId: string;
  product: Product;
  callBrief: CallBrief;
  correlationId: string;
};

export async function startVoiceSession(input: StartVoiceSessionInput): Promise<{ voiceSessionId: string; systemPrompt: string }> {
  const voiceSessionId = `voice_${crypto.randomUUID()}`;
  const systemPrompt = buildRealtimeSystemPrompt({
    product: input.product,
    callBrief: input.callBrief
  });
  const realtimeConfig = buildRealtimeSessionConfig(systemPrompt);

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
        voice: realtimeConfig.session.session.voice,
        turnDetection: realtimeConfig.session.session.turn_detection.type,
        transcriptionModel: realtimeConfig.session.session.input_audio_transcription.model,
        maxOutputTokens: realtimeConfig.session.session.max_response_output_tokens
      },
      input.correlationId
    )
  );

  return { voiceSessionId, systemPrompt };
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
