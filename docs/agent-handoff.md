# Agent Handoff

This document is for a new engineer or autonomous agent starting from the GitHub repo only, with no local context and no prior conversation history.

The job is not to re-architect the project. The job is to finish it correctly from the current base.

## 1. What This Project Is

This repo is an early-stage monorepo for an autonomous B2B outbound sales calling system.

The intended product flow is:

1. Operator enters product + direct target or campaign input
2. System researches the prospect/company
3. System generates a structured sales call brief
4. System places an outbound call through Sonetel
5. Azure OpenAI Realtime handles the live speaking agent
6. Transcript, disposition, follow-up, and evaluation are stored

Current focus is `direct mode`, not campaign scale.

## 2. What Stack Is Actually Chosen

Do not re-decide the stack unless there is a hard blocker.

- `Monorepo`: npm workspaces
- `Language`: TypeScript / Node.js
- `Async model calls`: Azure OpenAI
- `Realtime voice model`: Azure OpenAI GPT Realtime
- `Telephony`: Sonetel
- `Workflow engine`: Temporal
- `Primary DB`: Postgres
- `Local fallback DB mode`: in-memory store
- `Transport bridge boundary`: custom `bridge-gateway`

Important correction:

- some planning docs still mention `pnpm`, but the repo is implemented with `npm workspaces`

## 3. What Exists Right Now

This repo is not empty and not toy-level in structure. It has real service boundaries, model adapters, validations, and a direct-mode flow.

### Services

- `services/app-api`
- `services/orchestrator`
- `services/research-worker`
- `services/strategy-worker`
- `services/dialer-service`
- `services/voice-gateway`
- `services/bridge-gateway`
- `services/sequence-worker`
- `services/live-tool-service`
- `services/evaluation-worker`
- `services/temporal-worker`

### Packages

- `packages/config`
- `packages/db`
- `packages/domain-models`
- `packages/azure-openai-client`
- `packages/prompt-kits`
- `packages/shared-events`
- `packages/telemetry`
- `packages/sales-playbooks`
- `packages/temporal-workflows`

### Docs

- architecture
- implementation plan
- product requirements
- event schema
- prompt contracts
- call state machine
- evaluation rubric
- Sonetel bridge notes

## 4. What Is Already Working

These are the capabilities that are already implemented and were previously validated:

- repo builds with targeted TypeScript compilation
- `.env` loading is wired from repo root
- Azure OpenAI reasoning deployment wiring is implemented
- Azure OpenAI realtime session config is implemented
- Sonetel auth/token/account wiring is implemented
- Sonetel callback API request shape is implemented
- direct-mode orchestration exists end-to-end in code
- bridge service boundary exists for the AI-side leg
- sequence planning exists for post-call next steps
- call/session/transcript/follow-up/evaluation domain objects exist
- API endpoints exist for product creation, direct calls, snapshots, transcripts, and provider validation

## 5. What Is Not Finished

These are the real gaps. Do not lie to yourself about them.

- no external Sonetel/SIP ingress has been provisioned yet
- `SONETEL_AGENT_DESTINATION` still depends on external telephony ingress
- live duplex audio to Azure Realtime is implemented in `voice-gateway`, but it still needs a real telephony ingress to feed it
- call turns are now bridge-driven, but the external telephony ingress still needs to be provisioned
- no production auth or tenancy model
- no CRM integration
- no campaign mode
- no inbound mode
- no hardened production observability beyond structured logs
- no end-to-end deployable cloud infra

## 6. Current Core Constraint

The system uses Sonetel callback-style outbound calling with two legs:

- `call1`: the AI-side leg
- `call2`: the prospect leg

The main blocker to real live calls is `call1`.

`SONETEL_AGENT_DESTINATION` must point to a real telephony endpoint that can terminate into the AI runtime. It must not be an HTTP URL.

Valid formats:

- `sip:agent@pbx.example.com`
- `tel:+12025550123`
- `+12025550123`

This project already exposes the AI-side software boundary through `bridge-gateway` and a live Azure Realtime speaking runtime through `voice-gateway`, but the external telephony ingress still has to be provisioned or integrated.

## 7. Where To Read First

Start in this order:

1. `README.md`
2. `docs/agent-handoff.md`
3. `docs/autonomous-sales-calling-architecture.md`
4. `docs/implementation-plan.md`
5. `docs/sonetel-bridge.md`
6. `services/orchestrator/src/index.ts`
7. `services/dialer-service/src/sonetel-adapter.ts`
8. `services/bridge-gateway/src/index.ts`
9. `services/voice-gateway/src/index.ts`
10. `packages/azure-openai-client/src/index.ts`
11. `packages/db/src/index.ts`

## 8. How The Current Direct Workflow Works

The current direct workflow is implemented in `services/orchestrator/src/index.ts`.

High-level flow:

1. operator submits a direct call request
2. product is loaded
3. company/contact/prospect records are created
4. research worker generates a research packet
5. strategy worker generates a `call_brief`
6. policy gate evaluates whether the call is allowed
7. dialer service prepares Sonetel outbound call submission
8. bridge-gateway creates a persisted bridge session and realtime session scaffold
9. live telephony ingress drives transcript events into the bridge
10. call start/end transitions happen from bridge events
11. sequence planning chooses the next step, creates follow-up if needed, and updates lead state
12. evaluation runs from the completed bridge/session data

The live media transport is still the remaining external piece, but the call lifecycle is now event-driven instead of hardcoded transcript playback.

Default success metric:

- book a meeting or callback, not just a generic "call completed" record

## 9. Important Service Responsibilities

### `app-api`

Operator-facing API surface.

Responsibilities:

- intake products
- intake direct call requests
- expose validation endpoints
- expose call/prospect/snapshot reads

### `orchestrator`

Owns the business workflow.

Responsibilities:

- create prospect state
- trigger research
- trigger strategy
- apply policy
- trigger call execution
- create follow-up
- trigger evaluation

### `research-worker`

Produces structured company/persona context.

### `strategy-worker`

Turns research into a compact `call_brief`.

### `dialer-service`

Owns Sonetel call initiation and webhook normalization.

Current important file:

- `services/dialer-service/src/sonetel-adapter.ts`

### `voice-gateway`

Owns the realtime speaking-agent session boundary and transcript turn storage.

### `bridge-gateway`

Owns the AI-side call ingress boundary that a SIP/SBC or telephony edge should terminate into.

This service is a crucial addition. It exists so the repo has a real place for `call1` to land.

### `sequence-worker`

Owns the post-call next-step planner.

Responsibilities:

- convert call outcomes into a next action
- choose meeting vs callback vs nurture
- create follow-up tasks
- advance lead state after a live call

## 10. Validation Commands

From repo root:

```bash
npm install
npm run validate:azure-realtime
npm run validate:bridge-config
npm run validate:sonetel-config
npm run refresh:sonetel-token
```

These mean:

- `validate:azure-realtime`
  - confirms Azure OpenAI Realtime deployment/session config path is usable
- `validate:bridge-config`
  - confirms bridge config, especially whether `SONETEL_AGENT_DESTINATION` is present and sane
- `validate:sonetel-config`
  - confirms Sonetel auth/account/caller config and callback endpoint assumptions
- `refresh:sonetel-token`
  - refreshes Sonetel token/account wiring into `.env`

Do not enable live outbound until validation is clean.

## 11. Environment Expectations

The repo uses `.env` locally and `.env.example` as the template.

Expected important envs:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_REASONING_DEPLOYMENT`
- `AZURE_OPENAI_REALTIME_DEPLOYMENT`
- `AZURE_OPENAI_REALTIME_VOICE`
- `SONETEL_EMAIL`
- `SONETEL_PASSWORD`
- `SONETEL_ACCESS_TOKEN`
- `SONETEL_ACCOUNT_ID`
- `SONETEL_OUTGOING_CALLER_ID`
- `SONETEL_AGENT_DESTINATION`
- `SONETEL_ENABLE_LIVE_OUTBOUND`
- `BRIDGE_GATEWAY_PORT`
- `BRIDGE_GATEWAY_PUBLIC_BASE_URL`
- `DB_PROVIDER`
- `DATABASE_URL`
- `TEMPORAL_ADDRESS`

Rules:

- never commit `.env`
- keep `.env.example` generic
- do not put actual secrets into docs

## 12. What Must Not Be Changed Lightly

These are now foundational assumptions:

- only one agent speaks live
- async agents do research and strategy
- realtime voice path must stay thin
- Sonetel remains the telephony provider unless truly impossible
- Azure OpenAI remains the model provider
- live tool access must stay narrow and deterministic
- `direct mode` is the wedge product

If you change any of those, you are changing product architecture, not just implementation.

## 13. Priority Order To Finish The System

If you are the next agent, build in this order.

### Priority 1. Make telephony ingress real

Goal:

- provide a real endpoint for `SONETEL_AGENT_DESTINATION`

What to do:

- choose a telephony ingress pattern:
  - SIP SBC / PBX
  - SIP provider bridge
  - controlled telephony app that can forward audio/events into `bridge-gateway`
- wire that ingress to the `bridge-gateway`
- define exact ingress-to-bridge payloads/events
- make the bridge capable of representing one live call leg lifecycle from connect to close

Success condition:

- Sonetel can place `call1` to a target that is actually your AI system

### Priority 2. Implement real media flow

Goal:

- move from simulated call turns to real audio streaming

What to do:

- accept upstream media chunks from the telephony ingress
- normalize audio format
- stream audio into Azure Realtime
- receive audio responses or response events
- return audio back through the telephony ingress
- persist transcript chunks and turn boundaries

Success condition:

- one live bidirectional call can happen between prospect and AI speaking agent

### Priority 3. Replace simulated call loop in orchestrator

Goal:

- stop simulating transcript turns after `startVoiceSession`

What to do:

- move call progression to event-driven updates from bridge/voice gateway
- let `markCallStarted` and `markCallEnded` follow real telephony lifecycle
- let follow-up and evaluation trigger from actual call completion

Success condition:

- live call lifecycle is driven by provider and gateway events, not hardcoded transcript strings

### Priority 4. Harden persistence and workflow execution

Goal:

- make system reliable under retries and restarts

What to do:

- switch local dev and main runtime toward Postgres-backed repository mode
- ensure idempotent updates for call sessions and provider webhooks
- move more orchestration responsibility into Temporal workflows

Success condition:

- the system can survive retries and partial failures without duplicate actions

### Priority 5. Add operator visibility

Goal:

- let users inspect what is happening live

What to do:

- improve the web app
- show lead status
- show call brief
- show live call session state
- show transcript stream
- show validation and provider status

Success condition:

- operator can actually supervise and debug a real call

## 14. The Most Likely Engineering Mistakes

Avoid these:

- adding more agents before finishing the realtime path
- pushing research logic into the live call loop
- giving the realtime model broad DB or search access
- pretending HTTP is a telephony destination
- treating Sonetel callback flow like a one-leg outbound dialer
- enabling live outbound before `SONETEL_AGENT_DESTINATION` is real
- adding fine-tuning before prompt/eval loops exist
- switching providers just because the bridge is unfinished

## 15. Exact Files That Matter Most

If you are debugging the live call path, these files matter first:

- `services/dialer-service/src/sonetel-adapter.ts`
- `services/dialer-service/src/index.ts`
- `services/bridge-gateway/src/index.ts`
- `services/voice-gateway/src/index.ts`
- `packages/azure-openai-client/src/index.ts`
- `services/orchestrator/src/index.ts`
- `packages/db/src/index.ts`
- `packages/domain-models/src/index.ts`

If you are debugging config/env:

- `packages/config/src/index.ts`
- `.env.example`
- `scripts/validate-bridge-config.ts`
- `scripts/validate-sonetel-config.ts`
- `scripts/validate-azure-realtime.ts`

## 16. How To Judge Whether You Are Making Progress

Progress is not “more code exists.”

Progress is:

1. Sonetel can call the AI-side leg
2. AI-side leg reaches the bridge
3. bridge can create and manage a realtime session
4. audio flows both directions
5. transcript persists from real events
6. call ends with real outcome
7. follow-up and evaluation use real call data

If you cannot point to movement on that chain, you are probably avoiding the hard problem.

## 17. Minimum Definition Of Done For Direct Mode Alpha

The system is meaningfully usable when:

- operator can create a product
- operator can submit a direct call target
- research packet is generated
- `call_brief` is generated
- policy gate approves
- Sonetel places real outbound call
- AI voice agent speaks in real time through Azure Realtime
- transcript is stored
- call disposition is stored
- follow-up is created automatically
- evaluation score exists

Until then, it is still an implementation scaffold.

## 18. Recommended Immediate Next Steps

If you are the next agent, do this in order:

1. inspect and run all validation commands
2. confirm Azure still works
3. confirm Sonetel auth still works
4. provision or integrate the real telephony ingress for `SONETEL_AGENT_DESTINATION`
5. wire ingress events/media into `bridge-gateway`
6. replace simulated transcript loop with real streaming
7. then harden persistence and Temporal

## 19. Final Instruction

Do not start over.

This repo already has the correct shape:

- async research brain
- async strategy brain
- bounded realtime speaking brain
- telephony adapter
- bridge boundary
- evaluation pipeline

Finish the transport path and harden the system. That is the actual work left.
