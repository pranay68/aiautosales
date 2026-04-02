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

That service is the thing the SIP/SBC front-end should route into.

## Local Validation

Use these checks:

```bash
npm run validate:sonetel-config
npm run validate:bridge-config
```

The system is not live-ready until:

- `SONETEL_AGENT_DESTINATION` is set
- the target actually routes into the bridge gateway
- the bridge gateway can carry audio into Azure OpenAI Realtime
