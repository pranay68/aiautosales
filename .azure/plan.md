# Azure Plan: Sonetel FreeSWITCH SIP Ingress

## Goal

Provision a minimal Azure-hosted telephony ingress that Sonetel can call as the AI-side leg of a callback outbound flow, then bridge that live SIP audio into the existing `bridge-gateway` and `voice-gateway` realtime stack.

## Why This Exists

`SONETEL_AGENT_DESTINATION` must point to a callable telephony ingress. An HTTP endpoint is not enough. The missing production blocker is a real SIP endpoint that:

- accepts Sonetel's first call leg
- streams caller audio into the bridge
- accepts model audio back from Azure Realtime
- keeps the call lifecycle tied to the existing call/bridge/session records

## Chosen Stack

- Azure VM: `Standard_B1ms`
- OS: Ubuntu 22.04 LTS
- Telephony runtime: FreeSWITCH
- Media stream bridge: `mod_audio_stream`
- Bridge control plane: existing Node services in this repo
- Deployment style: Azure CLI + Bicep

## VM Recommendation

Use `Standard_B1ms` for the first production-shaped ingress VM.

Reasons:

- 1 vCPU and 2 GiB RAM is enough for a single FreeSWITCH ingress node
- lower cost than larger SKUs
- still leaves enough headroom for SIP signaling, RTP handling, and the websocket media bridge

Trade-off:

- this is a single ingress node, not a scalable cluster
- if call volume increases, move to a larger VM or a replicated SIP front end later

## Resources To Create

- resource group for telephony ingress
- virtual network and subnet
- network security group
- public IP with DNS label
- network interface
- Ubuntu 22.04 VM
- cloud-init bootstrap for FreeSWITCH and the bridge media module

## Repository Changes

### Infrastructure

- `infra/azure/freeswitch/main.bicep`
- `infra/azure/freeswitch/cloud-init.yml`
- `infra/azure/freeswitch/README.md`

### Runtime

- bridge-gateway media websocket endpoint
- bridge session claim endpoint
- voice-gateway playback subscription surface
- FreeSWITCH-compatible stream audio response handling

### Documentation

- update Sonetel bridge docs with the FreeSWITCH SIP ingress path
- update README with deployment and validation steps

## Runtime Flow

1. Orchestrator creates prospect, research packet, call brief, call session, and bridge session.
2. Dialer submits the Sonetel outbound callback with `call1` pointing to the FreeSWITCH SIP URI.
3. Sonetel calls the Azure VM SIP endpoint.
4. FreeSWITCH answers the call.
5. FreeSWITCH asks `bridge-gateway` for the next pending bridge session.
6. FreeSWITCH starts `uuid_audio_stream` to the bridge websocket URL.
7. `bridge-gateway` marks the session connected and forwards incoming audio to `voice-gateway`.
8. `voice-gateway` opens Azure Realtime, sends audio, and emits playback deltas.
9. `bridge-gateway` forwards model audio back to FreeSWITCH as `streamAudio`.
10. On hangup, bridge completion triggers sequence planning and evaluation.

## Validation Plan

- validate the Azure deployment template
- deploy the VM
- verify the FreeSWITCH SIP listener is up
- verify the bridge claim endpoint returns a pending session
- simulate a media websocket connection
- run a synthetic call through the full path

## Status

Draft. Ready for execution after implementation review.
