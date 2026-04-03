# Sonetel Bridge

Sonetel outbound calling uses a callback-style flow with two destinations:

- `call1`: the AI-side leg
- `call2`: the prospect-side leg

The missing blocker in this repo is `call1`.

## What `SONETEL_AGENT_DESTINATION` Must Be

`SONETEL_AGENT_DESTINATION` should point to a real telephony ingress that can accept the first leg of the call and forward audio into the AI runtime. In practice this means:

- a SIP URI on a PBX/SBC you control
- or another telephony endpoint that terminates into the bridge gateway

It should not be a plain HTTP URL.
Valid examples:

- `sip:agent@pbx.example.com`
- `tel:+12025550123`
- `+12025550123`

## Repo Boundary

This repo now includes a `bridge-gateway` service that owns the AI-side session boundary:

- hydrates call context from the database
- creates the realtime voice session scaffold
- stores bridge session state
- accepts websocket events from an upstream telephony ingress

The `voice-gateway` service now owns the live Azure OpenAI Realtime websocket session and emits transcript and playback events from real response events.

The SIP/SBC front-end does not talk to `voice-gateway` directly. It talks to `bridge-gateway`, which in turn forwards audio and playback through the realtime stack.

## Current Production Path

The live ingress flow is:

1. Sonetel calls the AI-side destination.
2. FreeSWITCH answers on the Azure VM.
3. FreeSWITCH asks `bridge-gateway` for the next pending bridge session.
4. `bridge-gateway` returns a session ID and a websocket media URL.
5. FreeSWITCH starts `uuid_audio_stream` to that websocket URL.
6. `bridge-gateway` forwards incoming audio into `voice-gateway`.
7. `voice-gateway` sends Azure Realtime output back to `bridge-gateway`.
8. `bridge-gateway` relays the audio back to FreeSWITCH as `streamAudio`.

The Azure VM therefore becomes the callable SIP ingress that Sonetel can use as `call1`.

## Local Validation

Use these checks:

```bash
npm run validate:sonetel-config
npm run validate:bridge-config
```

The system is not live-ready until:

- `SONETEL_AGENT_DESTINATION` is set
- the target actually routes into the FreeSWITCH ingress on Azure
- FreeSWITCH can claim a pending bridge session
- the bridge gateway can carry audio into Azure OpenAI Realtime
- model audio can be played back through `streamAudio`

## Azure VM

The recommended ingress host is:

- Ubuntu 22.04 LTS
- `Standard_B1ms`
- FreeSWITCH with `mod_audio_stream`

The repo now includes an Azure Bicep scaffold under `infra/azure/freeswitch/`.
