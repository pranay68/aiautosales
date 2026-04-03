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
  libspandsp-dev \
  libsofia-sip-ua-dev \
  libspeexdsp-dev \
  libldns-dev \
  liblua5.4-dev \
  libopus-dev \
  libsndfile1-dev \
  libpcre3-dev \
  libedit-dev \
  libsqlite3-dev \
  uuid-dev \
  libjpeg-dev \
  libcurl4-openssl-dev \
  yasm

mkdir -p /usr/src
if [[ ! -d /usr/src/freeswitch/.git ]]; then
  git clone --branch v1.10.12 --depth 1 https://github.com/signalwire/freeswitch.git /usr/src/freeswitch
fi

mkdir -p /usr/local/lib/pkgconfig
cat >/usr/local/lib/pkgconfig/spandsp.pc <<'PC'
prefix=/usr
exec_prefix=${prefix}
libdir=${prefix}/lib/x86_64-linux-gnu
includedir=${prefix}/include

Name: spandsp
Description: A DSP library for telephony.
Version: 3.0
Libs: -L${libdir} -lspandsp
Libs.private: -ltiff -lm
Cflags: -I${includedir}
PC

cat >/usr/local/lib/pkgconfig/sofia-sip-ua.pc <<'PC'
prefix=/usr
exec_prefix=${prefix}
libdir=${prefix}/lib/x86_64-linux-gnu
includedir=${prefix}/include/sofia-sip-1.12

Name: sofia-sip-ua
Description: Sofia-SIP library development files
Version: 1.13.17
Libs: -L${libdir} -lsofia-sip-ua
Cflags: -I${includedir}
PC

cd /usr/src/freeswitch
python3 - <<'PY'
from pathlib import Path

path = Path("/usr/src/freeswitch/src/switch_core_media.c")
text = path.read_text()
needle = '#include <sofia-sip/sdp.h>\n'
shim = '''#include <sofia-sip/sdp.h>
#ifndef sdp_proto_msrp
#define sdp_proto_msrp sdp_proto_tcp
#endif
#ifndef sdp_proto_msrps
#define sdp_proto_msrps sdp_proto_tls
#endif
#ifndef sdp_proto_extended_srtp
#define sdp_proto_extended_srtp sdp_proto_srtp
#endif
#ifndef sdp_proto_extended_rtp
#define sdp_proto_extended_rtp sdp_proto_rtp
#endif
#ifndef sdp_media_text
#define sdp_media_text sdp_media_message
#endif
#ifndef sdp_bw_tias
#define sdp_bw_tias sdp_bw_as
#endif
'''
if needle in text and shim not in text:
    text = text.replace(needle, shim, 1)
    path.write_text(text)

mod_sofia = Path("/usr/src/freeswitch/src/mod/endpoints/mod_sofia/mod_sofia.c")
text = mod_sofia.read_text()
needle = '#include "mod_sofia.h"\n'
shim = '''#include "mod_sofia.h"
#ifndef sip_cloned_parser_destroy
#define sip_cloned_parser_destroy() ((void)0)
#endif
'''
if needle in text and shim not in text:
    text = text.replace(needle, shim, 1)
    mod_sofia.write_text(text)
PY
cat > modules.conf <<'CONF'
applications/mod_commands
applications/mod_dptools
applications/mod_spandsp
codecs/mod_opus
dialplans/mod_dialplan_xml
endpoints/mod_sofia
event_handlers/mod_event_socket
formats/mod_native_file
formats/mod_sndfile
languages/mod_lua
loggers/mod_console
CONF

./bootstrap.sh -j
export PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}
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
