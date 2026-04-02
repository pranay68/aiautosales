import WebSocket from "ws";
import { buildRealtimeSessionConfig } from "@aiautosales/azure-openai-client";
import { loadEnv } from "@aiautosales/config";

const env = loadEnv();

if (!env.azureOpenAiEndpoint || !env.azureOpenAiApiKey || !env.azureOpenAiRealtimeDeployment) {
  console.error(JSON.stringify({ ok: false, message: "Missing Azure realtime config in .env" }));
  process.exit(1);
}

const url = new URL(`${env.azureOpenAiEndpoint.replace(/^https/, "wss").replace(/\/$/, "")}/openai/v1/realtime`);
url.searchParams.set("model", env.azureOpenAiRealtimeDeployment);

const sessionConfig = buildRealtimeSessionConfig(
  "You are a concise outbound sales caller. Reply with the single word READY when asked."
);

const ws = new WebSocket(url, {
  headers: {
    "api-key": env.azureOpenAiApiKey
  }
});

const timeout = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, message: "Timed out waiting for realtime events" }));
  ws.close();
  process.exit(1);
}, 15000);

let gotSessionUpdated = false;

ws.on("open", () => {
  ws.send(JSON.stringify(sessionConfig.session));
});

ws.on("message", (data) => {
  const text = data.toString();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = String(event.type || "");
  if (type === "error") {
    clearTimeout(timeout);
    console.error(JSON.stringify({ ok: false, message: event.error ?? event }));
    ws.close();
    process.exit(1);
  }

  if (type === "session.created" || type === "session.updated") {
    gotSessionUpdated = true;
    clearTimeout(timeout);
    console.log(
      JSON.stringify({
        ok: true,
        deployment: env.azureOpenAiRealtimeDeployment,
        voice: env.azureOpenAiRealtimeVoice,
        turn_detection: env.azureOpenAiRealtimeTurnDetection,
        session_ready: gotSessionUpdated
      })
    );
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (error) => {
  clearTimeout(timeout);
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exit(1);
});
