#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${AZURE_OPENAI_ENDPOINT:-}" || -z "${AZURE_OPENAI_API_KEY:-}" || -z "${AZURE_OPENAI_REALTIME_DEPLOYMENT:-}" || -z "${AZURE_OPENAI_REASONING_DEPLOYMENT:-}" ]]; then
  echo "Missing Azure OpenAI environment variables." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y git curl jq

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/v20.20.1/node-v20.20.1-linux-x64.tar.xz
  rm -rf /usr/local/node20
  mkdir -p /usr/local/node20
  tar -xJf node-v20.20.1-linux-x64.tar.xz -C /usr/local/node20 --strip-components=1
  ln -sf /usr/local/node20/bin/node /usr/local/bin/node
  ln -sf /usr/local/node20/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/node20/bin/npx /usr/local/bin/npx
fi

mkdir -p /opt
if [[ ! -d /opt/aiautosales/.git ]]; then
  git clone https://github.com/pranay68/aiautosales.git /opt/aiautosales
else
  cd /opt/aiautosales
  git pull --ff-only
fi

cd /opt/aiautosales
npm ci

cat >/opt/aiautosales/.env <<ENV
APP_API_PORT=4000
VOICE_GATEWAY_PORT=4010
ORCHESTRATOR_PORT=4020
LIVE_TOOL_SERVICE_PORT=4030
BRIDGE_GATEWAY_PORT=4040
BRIDGE_GATEWAY_PUBLIC_BASE_URL=http://localhost:4040
AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT}
AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY}
AZURE_OPENAI_REALTIME_DEPLOYMENT=${AZURE_OPENAI_REALTIME_DEPLOYMENT}
AZURE_OPENAI_REASONING_DEPLOYMENT=${AZURE_OPENAI_REASONING_DEPLOYMENT}
AZURE_OPENAI_REALTIME_VOICE=ash
AZURE_OPENAI_REALTIME_TEMPERATURE=0.7
AZURE_OPENAI_REALTIME_MAX_OUTPUT_TOKENS=220
AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
AZURE_OPENAI_REALTIME_INPUT_TRANSCRIPTION_LANGUAGE=en
AZURE_OPENAI_REALTIME_TURN_DETECTION=semantic_vad
AZURE_OPENAI_REALTIME_VAD_EAGERNESS=low
AZURE_OPENAI_REALTIME_SERVER_VAD_THRESHOLD=0.55
AZURE_OPENAI_REALTIME_SERVER_VAD_PREFIX_PADDING_MS=300
AZURE_OPENAI_REALTIME_SERVER_VAD_SILENCE_MS=450
AZURE_OPENAI_REALTIME_INTERRUPT_RESPONSE=false
AZURE_OPENAI_REALTIME_CREATE_RESPONSE=true
AZURE_OPENAI_REALTIME_INPUT_FORMAT=pcm16
AZURE_OPENAI_REALTIME_OUTPUT_FORMAT=pcm16
AZURE_OPENAI_REALTIME_NOISE_REDUCTION=near_field
SONETEL_ENABLE_LIVE_OUTBOUND=false
SONETEL_AGENT_DESTINATION=sip:agent@localhost
DB_PROVIDER=memory
ENV

nohup npm run dev:bridge-gateway >/var/log/aiautosales-bridge.log 2>&1 &

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now freeswitch.service || true
fi

echo "bootstrap complete"
