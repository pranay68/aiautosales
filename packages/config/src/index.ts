import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, "../../../");
loadDotenv({ path: resolve(repoRoot, ".env") });

export type AppEnv = {
  appApiPort: number;
  voiceGatewayPort: number;
  orchestratorPort: number;
  liveToolServicePort: number;
  bridgeGatewayPort: number;
  azureOpenAiEndpoint: string;
  azureOpenAiApiKey: string;
  azureOpenAiRealtimeDeployment: string;
  azureOpenAiReasoningDeployment: string;
  azureOpenAiRealtimeVoice: string;
  azureOpenAiRealtimeTemperature: number;
  azureOpenAiRealtimeMaxOutputTokens: number;
  azureOpenAiRealtimeInputTranscriptionModel: string;
  azureOpenAiRealtimeInputTranscriptionLanguage: string;
  azureOpenAiRealtimeTurnDetection: "server_vad" | "semantic_vad";
  azureOpenAiRealtimeVadEagerness: "low" | "medium" | "high" | "auto";
  azureOpenAiRealtimeServerVadThreshold: number;
  azureOpenAiRealtimeServerVadPrefixPaddingMs: number;
  azureOpenAiRealtimeServerVadSilenceMs: number;
  azureOpenAiRealtimeInterruptResponse: boolean;
  azureOpenAiRealtimeCreateResponse: boolean;
  azureOpenAiRealtimeInputFormat: string;
  azureOpenAiRealtimeOutputFormat: string;
  azureOpenAiRealtimeNoiseReduction: "near_field" | "far_field";
  sonetelApiBaseUrl: string;
  sonetelEmail: string;
  sonetelPassword: string;
  sonetelAccessToken: string;
  sonetelAccountId: string;
  sonetelOutgoingCallerId: string;
  sonetelAgentDestination: string;
  sonetelEnableLiveOutbound: boolean;
  bridgeGatewayPublicBaseUrl: string;
  databaseUrl: string;
  dbProvider: "memory" | "postgres";
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
};

function getNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getString(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function getBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

export function loadEnv(): AppEnv {
  return {
    appApiPort: getNumber("APP_API_PORT", 4000),
    voiceGatewayPort: getNumber("VOICE_GATEWAY_PORT", 4010),
    orchestratorPort: getNumber("ORCHESTRATOR_PORT", 4020),
    liveToolServicePort: getNumber("LIVE_TOOL_SERVICE_PORT", 4030),
    bridgeGatewayPort: getNumber("BRIDGE_GATEWAY_PORT", 4040),
    azureOpenAiEndpoint: getString("AZURE_OPENAI_ENDPOINT"),
    azureOpenAiApiKey: getString("AZURE_OPENAI_API_KEY").replace(/^AZURE_OPENAI_API_KEY=/, ""),
    azureOpenAiRealtimeDeployment: getString("AZURE_OPENAI_REALTIME_DEPLOYMENT", "gpt-realtime"),
    azureOpenAiReasoningDeployment: getString("AZURE_OPENAI_REASONING_DEPLOYMENT", "gpt-4.1"),
    azureOpenAiRealtimeVoice: getString("AZURE_OPENAI_REALTIME_VOICE", "ash"),
    azureOpenAiRealtimeTemperature: getNumber("AZURE_OPENAI_REALTIME_TEMPERATURE", 0.7),
    azureOpenAiRealtimeMaxOutputTokens: getNumber("AZURE_OPENAI_REALTIME_MAX_OUTPUT_TOKENS", 220),
    azureOpenAiRealtimeInputTranscriptionModel: getString("AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
    azureOpenAiRealtimeInputTranscriptionLanguage: getString("AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE", "en"),
    azureOpenAiRealtimeTurnDetection: getString("AZURE_OPENAI_REALTIME_TURN_DETECTION", "semantic_vad") === "server_vad" ? "server_vad" : "semantic_vad",
    azureOpenAiRealtimeVadEagerness: ((): "low" | "medium" | "high" | "auto" => {
      const value = getString("AZURE_OPENAI_REALTIME_VAD_EAGERNESS", "low");
      return value === "medium" || value === "high" || value === "auto" ? value : "low";
    })(),
    azureOpenAiRealtimeServerVadThreshold: getNumber("AZURE_OPENAI_REALTIME_SERVER_VAD_THRESHOLD", 0.55),
    azureOpenAiRealtimeServerVadPrefixPaddingMs: getNumber("AZURE_OPENAI_REALTIME_SERVER_VAD_PREFIX_PADDING_MS", 300),
    azureOpenAiRealtimeServerVadSilenceMs: getNumber("AZURE_OPENAI_REALTIME_SERVER_VAD_SILENCE_MS", 450),
    azureOpenAiRealtimeInterruptResponse: getBoolean("AZURE_OPENAI_REALTIME_INTERRUPT_RESPONSE", false),
    azureOpenAiRealtimeCreateResponse: getBoolean("AZURE_OPENAI_REALTIME_CREATE_RESPONSE", true),
    azureOpenAiRealtimeInputFormat: getString("AZURE_OPENAI_REALTIME_INPUT_FORMAT", "pcm16"),
    azureOpenAiRealtimeOutputFormat: getString("AZURE_OPENAI_REALTIME_OUTPUT_FORMAT", "pcm16"),
    azureOpenAiRealtimeNoiseReduction: getString("AZURE_OPENAI_REALTIME_NOISE_REDUCTION", "near_field") === "far_field" ? "far_field" : "near_field",
    sonetelApiBaseUrl: getString("SONETEL_API_BASE_URL", "https://public-api.sonetel.com"),
    sonetelEmail: getString("SONETEL_EMAIL"),
    sonetelPassword: getString("SONETEL_PASSWORD"),
    sonetelAccessToken: getString("SONETEL_ACCESS_TOKEN"),
    sonetelAccountId: getString("SONETEL_ACCOUNT_ID"),
    sonetelOutgoingCallerId: getString("SONETEL_OUTGOING_CALLER_ID"),
    sonetelAgentDestination: getString("SONETEL_AGENT_DESTINATION"),
    sonetelEnableLiveOutbound: getBoolean("SONETEL_ENABLE_LIVE_OUTBOUND", false),
    bridgeGatewayPublicBaseUrl: getString("BRIDGE_GATEWAY_PUBLIC_BASE_URL"),
    databaseUrl: getString("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/aiautosales"),
    dbProvider: getString("DB_PROVIDER", "memory") === "postgres" ? "postgres" : "memory",
    temporalAddress: getString("TEMPORAL_ADDRESS", "localhost:7233"),
    temporalNamespace: getString("TEMPORAL_NAMESPACE", "default"),
    temporalTaskQueue: getString("TEMPORAL_TASK_QUEUE", "aiautosales")
  };
}
