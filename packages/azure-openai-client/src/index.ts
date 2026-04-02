import OpenAI from "openai";
import { loadEnv } from "@aiautosales/config";

let cachedClient: OpenAI | undefined;

function getClient(): OpenAI | undefined {
  const env = loadEnv();
  if (!env.azureOpenAiEndpoint || !env.azureOpenAiApiKey) {
    return undefined;
  }

  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: env.azureOpenAiApiKey,
      baseURL: `${env.azureOpenAiEndpoint.replace(/\/$/, "")}/openai/v1/`
    });
  }

  return cachedClient;
}

export async function runReasoningPrompt(input: {
  prompt: string;
  deployment?: string;
  fallbackText: string;
}): Promise<{ text: string; live: boolean; deployment: string }> {
  const env = loadEnv();
  const deployment = input.deployment ?? env.azureOpenAiReasoningDeployment;
  const client = getClient();

  if (!client) {
    return {
      text: input.fallbackText,
      live: false,
      deployment
    };
  }

  const response = await client.responses.create({
    model: deployment,
    input: input.prompt
  });

  return {
    text: response.output_text || input.fallbackText,
    live: true,
    deployment
  };
}

export function buildRealtimeSessionConfig(systemPrompt: string) {
  const env = loadEnv();
  return {
    provider: "azure-openai",
    endpoint: env.azureOpenAiEndpoint,
    deployment: env.azureOpenAiRealtimeDeployment,
    modelKind: "gpt-realtime",
    live: Boolean(env.azureOpenAiEndpoint && env.azureOpenAiApiKey),
    session: {
      type: "session.update",
      session: {
        voice: env.azureOpenAiRealtimeVoice,
        instructions: systemPrompt,
        input_audio_format: env.azureOpenAiRealtimeInputFormat,
        output_audio_format: env.azureOpenAiRealtimeOutputFormat,
        input_audio_transcription: {
          model: env.azureOpenAiRealtimeInputTranscriptionModel,
          language: env.azureOpenAiRealtimeInputTranscriptionLanguage
        },
        input_audio_noise_reduction: {
          type: env.azureOpenAiRealtimeNoiseReduction
        },
        turn_detection:
          env.azureOpenAiRealtimeTurnDetection === "semantic_vad"
            ? {
                type: "semantic_vad",
                eagerness: env.azureOpenAiRealtimeVadEagerness,
                create_response: env.azureOpenAiRealtimeCreateResponse,
                interrupt_response: env.azureOpenAiRealtimeInterruptResponse
              }
            : {
                type: "server_vad",
                threshold: env.azureOpenAiRealtimeServerVadThreshold,
                prefix_padding_ms: env.azureOpenAiRealtimeServerVadPrefixPaddingMs,
                silence_duration_ms: env.azureOpenAiRealtimeServerVadSilenceMs,
                create_response: env.azureOpenAiRealtimeCreateResponse,
                interrupt_response: env.azureOpenAiRealtimeInterruptResponse
              },
        temperature: env.azureOpenAiRealtimeTemperature,
        max_response_output_tokens: env.azureOpenAiRealtimeMaxOutputTokens
      }
    }
  };
}
