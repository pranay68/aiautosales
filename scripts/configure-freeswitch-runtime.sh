#!/usr/bin/env bash
set -euo pipefail

if [[ ! -x /usr/local/freeswitch/bin/freeswitch ]]; then
  echo "FreeSWITCH is not installed at /usr/local/freeswitch" >&2
  exit 1
fi

private_ip="$(hostname -I | awk '{print $1}')"
if [[ -z "${private_ip}" ]]; then
  echo "Unable to determine VM private IP" >&2
  exit 1
fi

install -d /usr/local/freeswitch/conf /usr/local/freeswitch/var/run/freeswitch /usr/local/freeswitch/log /usr/local/freeswitch/db

cat >/usr/local/freeswitch/conf/vars.xml <<EOF
<include>
  <X-PRE-PROCESS cmd="set" data="global_codec_prefs=PCMU,PCMA"/>
  <X-PRE-PROCESS cmd="set" data="local_ip_v4=${private_ip}"/>
  <X-PRE-PROCESS cmd="set" data="xml_rpc_password=worksnot"/>
  <X-PRE-PROCESS cmd="set" data="external_sip_port=5060"/>
</include>
EOF

cat >/usr/local/freeswitch/conf/autoload_configs/sofia.conf.xml <<'EOF'
<configuration name="sofia.conf" description="sofia Endpoint">
  <global_settings>
    <param name="log-level" value="0"/>
    <param name="tracelevel" value="DEBUG"/>
  </global_settings>

  <profiles>
    <X-PRE-PROCESS cmd="include" data="../sip_profiles/external.xml"/>
  </profiles>
</configuration>
EOF

install -d /usr/local/freeswitch/conf/dialplan/public
cat >/usr/local/freeswitch/conf/dialplan/public/ai-bridge.xml <<'EOF'
<include>
  <extension name="ai-bridge">
    <condition field="destination_number" expression="^agent$">
      <action application="answer"/>
      <action application="system" data="/usr/local/freeswitch/scripts/claim-bridge-session.sh ${uuid}"/>
      <action application="park"/>
    </condition>
  </extension>
</include>
EOF

if ! grep -q 'mod_audio_stream' /usr/local/freeswitch/conf/autoload_configs/modules.conf.xml; then
  sed -i '/<\/modules>/i \    <load module="mod_audio_stream"/>' /usr/local/freeswitch/conf/autoload_configs/modules.conf.xml
fi

public_host="aiautosales-freeswitch.westus2.cloudapp.azure.com"
sed -i "s/auto-nat/host:${public_host}/g" /usr/local/freeswitch/conf/sip_profiles/internal.xml
sed -i "s/auto-nat/host:${public_host}/g" /usr/local/freeswitch/conf/sip_profiles/external.xml

pkill -f '^/usr/local/freeswitch/bin/freeswitch' || true
rm -f /usr/local/freeswitch/var/run/freeswitch/freeswitch.pid
sleep 2

nohup /usr/local/freeswitch/bin/freeswitch \
  -nonat -nc -nf \
  -conf /usr/local/freeswitch/conf \
  -log /usr/local/freeswitch/log \
  -run /usr/local/freeswitch/var/run/freeswitch \
  -db /usr/local/freeswitch/db \
  -mod /usr/local/freeswitch/lib/freeswitch/mod \
  >/var/log/freeswitch-startup.log 2>&1 &

sleep 10

echo "private_ip=${private_ip}"
pgrep -af '^/usr/local/freeswitch/bin/freeswitch' || true
echo "--- modules"
/usr/local/freeswitch/bin/fs_cli -x 'show modules' | grep -i 'sofia\|audio_stream' || true
echo "--- sofia"
/usr/local/freeswitch/bin/fs_cli -x 'sofia status' || true
