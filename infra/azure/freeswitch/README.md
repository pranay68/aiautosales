# FreeSWITCH Azure Ingress

This folder provisions the SIP ingress VM that Sonetel should call as `SONETEL_AGENT_DESTINATION`.

## What It Creates

- Ubuntu 22.04 VM
- FreeSWITCH
- `mod_audio_stream`
- a public SIP endpoint named `agent`
- a claim script that asks `bridge-gateway` for the next pending bridge session

## Expected Flow

1. Sonetel dials `sip:agent@<vm-fqdn>`
2. FreeSWITCH answers the call
3. FreeSWITCH asks `bridge-gateway` for the next pending session
4. FreeSWITCH starts `uuid_audio_stream` to the returned websocket URL
5. `bridge-gateway` forwards audio into `voice-gateway`
6. `voice-gateway` returns Azure Realtime audio to FreeSWITCH

## Deployment Notes

- Use a small Linux VM for the first version.
- Open SIP/RTP ports in the NSG.
- Set `BRIDGE_GATEWAY_PUBLIC_BASE_URL` in the VM bootstrap environment so the Lua claim script can reach the bridge.
- After deployment, set `SONETEL_AGENT_DESTINATION` to the output `sipUri`.

## Important Caveat

The bootstrap script assumes the FreeSWITCH package repository is reachable for Ubuntu Jammy. If the package repo changes, update the install block in `cloud-init.yml` or switch to a source build.
