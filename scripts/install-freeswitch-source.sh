#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
  git \
  build-essential \
  autoconf \
  automake \
  libtool \
  pkg-config \
  cmake \
  libssl-dev \
  zlib1g-dev \
  libevent-dev \
  libspeexdsp-dev \
  libldns-dev \
  liblua5.4-dev \
  libopus-dev \
  libsndfile1-dev \
  libpcre3-dev \
  libedit-dev \
  libsqlite3-dev \
  libjpeg-dev \
  libcurl4-openssl-dev \
  yasm

mkdir -p /usr/src
if [[ ! -d /usr/src/freeswitch/.git ]]; then
  git clone --branch v1.10.12 --depth 1 https://github.com/signalwire/freeswitch.git /usr/src/freeswitch
fi

cd /usr/src/freeswitch
./bootstrap.sh -j
./configure --prefix=/usr/local/freeswitch
make -j"$(nproc)"
make install

if [[ ! -d /usr/src/mod_audio_stream/.git ]]; then
  git clone https://github.com/amigniter/mod_audio_stream.git /usr/src/mod_audio_stream
fi

cd /usr/src/mod_audio_stream
git submodule init
git submodule update
export PKG_CONFIG_PATH=/usr/local/freeswitch/lib/pkgconfig
mkdir -p build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j"$(nproc)"
make install

install -d /usr/local/freeswitch/conf/dialplan/public
if ! grep -q 'mod_audio_stream' /usr/local/freeswitch/conf/autoload_configs/modules.conf.xml; then
  sed -i '/<\/modules>/i \    <load module="mod_audio_stream"/>' /usr/local/freeswitch/conf/autoload_configs/modules.conf.xml
fi

install -d /usr/local/freeswitch/scripts
cat >/usr/local/freeswitch/scripts/claim-bridge-session.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

uuid="${1:-}"
if [[ -z "$uuid" ]]; then
  echo "missing uuid" >&2
  exit 1
fi

response="$(curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Correlation-Id: ${uuid}" \
  -d "{\"callUuid\":\"${uuid}\"}" \
  "http://127.0.0.1:4040/bridge-sessions/claim-next")"

media_ws_url="$(printf '%s' "$response" | jq -r '.mediaWebsocketUrl // empty')"
bridge_session_id="$(printf '%s' "$response" | jq -r '.bridgeSession.id // empty')"
call_session_id="$(printf '%s' "$response" | jq -r '.bridgeSession.callSessionId // empty')"
prospect_id="$(printf '%s' "$response" | jq -r '.bridgeSession.prospectId // empty')"

if [[ -z "$media_ws_url" || -z "$bridge_session_id" ]]; then
  echo "bridge claim failed: $response" >&2
  exit 1
fi

meta="$(jq -nc \
  --arg bridgeSessionId "$bridge_session_id" \
  --arg callSessionId "$call_session_id" \
  --arg prospectId "$prospect_id" \
  '{bridgeSessionId:$bridgeSessionId, callSessionId:$callSessionId, prospectId:$prospectId}')"

fs_cli -x "uuid_audio_stream ${uuid} start ${media_ws_url} mono 8000 '${meta}'"
SH
chmod +x /usr/local/freeswitch/scripts/claim-bridge-session.sh

cat >/usr/local/freeswitch/conf/dialplan/public/ai-bridge.xml <<'XML'
<include>
  <extension name="ai-bridge">
    <condition field="destination_number" expression="^agent$">
      <action application="answer"/>
      <action application="system" data="/usr/local/freeswitch/scripts/claim-bridge-session.sh ${uuid}"/>
      <action application="hangup"/>
    </condition>
  </extension>
</include>
XML

nohup /usr/local/freeswitch/bin/freeswitch -nonat -nc -nf >/var/log/freeswitch.log 2>&1 &

echo "freeswitch install complete"
