# Autonomous Sales Calling System Implementation Plan

## 1. Purpose

This document turns the architecture into an execution plan.

The goal is not to build the whole vision at once. The goal is to build the smallest version that can:

1. take in a product and a target company
2. research the company
3. generate a high-quality call brief
4. place a real phone call
5. run a realtime voice conversation
6. log transcript, outcome, and follow-up

That is the first real product milestone.

## 2. Delivery Strategy

Build in this order:

1. `Foundation`
2. `Direct mode MVP`
3. `Direct mode hardening`
4. `Campaign mode`
5. `Evaluation and optimization loop`
6. `Scale and specialization`

This is intentionally not a "full autonomous swarm first" plan.

## 3. Product Scope by Stage

### Stage A. Foundation

Ship the technical skeleton:

- monorepo
- shared types
- Postgres schema
- event model
- operator UI shell
- orchestration baseline
- Sonetel integration spike and sandbox wiring
- Azure OpenAI realtime and async worker wiring
- logging and trace correlation

### Stage B. Direct Mode MVP

Ship one-lead-at-a-time calling:

- user enters product and target number
- research worker builds company/contact packet
- strategy worker builds `call_brief`
- policy gate runs
- dialer places call
- voice gateway streams audio to realtime model
- live tools serve brief/product facts/meeting booking
- transcript and summary are stored
- follow-up task is created

### Stage C. Direct Mode Hardening

Make it production-safe:

- prompt versioning
- replay and transcript inspection
- failure handling
- latency dashboards
- human transfer / escalation
- better objection handling
- QA scoring

### Stage D. Campaign Mode

Add scale mechanics:

- campaign intake
- prospect import / enrichment
- scoring and prioritization
- scheduled dialing
- concurrent call management
- follow-up sequencing

### Stage E. Learning Loop

Add improvement systems:

- evaluator workers
- scorecards
- prompt experiments
- synthetic prospect simulation
- clustering of failed calls
- strategy auto-iteration

## 4. Working Assumptions

Lock these assumptions now to reduce churn:

- `Frontend`: Next.js
- `Backend services`: TypeScript / Node.js
- `Monorepo`: pnpm workspaces
- `DB`: Postgres
- `Workflow orchestration`: Temporal
- `Queue/cache`: Redis
- `Telephony`: Sonetel via an internal telephony adapter
- `Realtime voice`: Azure OpenAI GPT Realtime deployment
- `Async reasoning`: Azure OpenAI model deployments
- `Blob storage`: S3-compatible or cloud blob
- `Analytics`: Postgres first, warehouse later

If any of these are changed later, the first impact will be on delivery speed, not core product behavior.

## 5. Team-Normalized Build Plan

This plan assumes a small founding team, for example:

- 1 full-stack/product engineer
- 1 backend/realtime engineer
- 1 AI systems engineer

If the team is smaller, execute the same order more slowly.

## 6. Monorepo Setup

Create this structure first:

```text
apps/
  web/

services/
  app-api/
  orchestrator/
  research-worker/
  strategy-worker/
  dialer-service/
  voice-gateway/
  live-tool-service/
  evaluation-worker/

packages/
  config/
  db/
  domain-models/
  prompt-kits/
  shared-events/
  telemetry/
  sales-playbooks/

infra/
  local/
  cloud/

docs/
  autonomous-sales-calling-architecture.md
  implementation-plan.md
  product-requirements.md
  event-schema.md
  prompt-contracts.md
  call-state-machine.md
  evaluation-rubric.md
```

## 7. Phase 0: Foundation Sprint

### 7.1 Objective

Set up the repo, local dev environment, service skeletons, and cross-service contracts.

### 7.2 Deliverables

- monorepo initialized
- linting, formatting, and typecheck
- shared env config package
- Postgres migrations package
- service bootstraps for all core services
- local Docker compose for Postgres + Redis + Temporal + tunnel tooling
- initial Sonetel adapter endpoints
- initial Azure OpenAI client wrappers
- structured logging with correlation IDs

### 7.3 Sonetel Capability Spike

Before building deeply into the realtime plane, validate these Sonetel capabilities:

- outbound call initiation
- webhook/event delivery
- audio/media streaming or SIP/RTP bridge path
- call state transitions
- call recording and metadata availability

If Sonetel does not expose the exact transport needed by `voice-gateway`, keep Sonetel as the telephony provider and introduce a bridge component rather than leaking provider constraints across the system.

### 7.4 Required Documents

Before coding too far, write these:

- `product-requirements.md`
- `event-schema.md`
- `call-state-machine.md`
- `prompt-contracts.md`
- `evaluation-rubric.md`

### 7.5 Exit Criteria

- every service starts locally
- DB migrations run
- a fake lead can move through the orchestration state machine without calling providers
- logs can trace one request across services
- Sonetel transport assumptions are either validated or isolated behind a bridge plan

## 8. Phase 1: Core Domain and Data Model

### 8.1 Objective

Implement the system-of-record model and event contracts before business logic spreads.

### 8.2 Database Work

Create migrations for:

- `workspaces`
- `users`
- `products`
- `campaigns`
- `companies`
- `contacts`
- `prospects`
- `call_briefs`
- `call_sessions`
- `call_turns`
- `transcripts`
- `followups`
- `prompt_versions`
- `policy_flags`
- `events_outbox`

### 8.3 Event Contracts

Define versioned schemas for:

- `campaign.created`
- `prospect.created`
- `prospect.research.requested`
- `prospect.researched`
- `strategy.requested`
- `strategy.generated`
- `policy.checked`
- `call.requested`
- `call.started`
- `call.turn.logged`
- `call.ended`
- `followup.created`
- `evaluation.completed`

### 8.4 Exit Criteria

- migrations are stable
- all services share the same event types
- test fixtures can create a full direct-mode lead and `call_brief`

## 9. Phase 2: Operator App and App API

### 9.1 Objective

Build the first operator-facing control surface.

### 9.2 MVP Screens

- login or local dev bypass
- product intake form
- direct mode call form
- lead detail page
- call brief review page
- live call monitor page
- transcript page
- follow-up page

### 9.3 MVP App API Endpoints

- `POST /products`
- `POST /direct-calls`
- `GET /prospects/:id`
- `GET /call-briefs/:id`
- `POST /call-briefs/:id/approve`
- `POST /calls/:id/start`
- `GET /calls/:id`
- `GET /calls/:id/transcript`
- `POST /calls/:id/escalate`
- `POST /followups/:id/complete`

### 9.4 Exit Criteria

- an operator can create a direct-mode request end to end from UI
- all downstream work is triggered from the API and visible in status views

## 10. Phase 3: Orchestrator and State Machine

### 10.1 Objective

Implement the master workflow control plane.

### 10.2 Work

Create Temporal workflows for:

- `DirectLeadWorkflow`
- `ResearchWorkflow`
- `StrategyWorkflow`
- `PolicyWorkflow`
- `CallExecutionWorkflow`
- `PostCallWorkflow`

### 10.3 Responsibilities

The orchestrator must own:

- retries
- timeouts
- dead-letter behavior
- idempotency
- state transitions
- provider error mapping
- audit trail

### 10.4 Important Rule

Only the orchestrator can move a lead between major states.

No worker should directly mutate lead state in ad hoc ways.

### 10.5 Exit Criteria

- a direct lead can move from intake to `READY_TO_CALL`
- workflow retries do not duplicate records
- failed jobs can be replayed safely

## 11. Phase 4: Research Worker

### 11.1 Objective

Generate a strong research packet for one target company/contact.

### 11.2 Inputs

- company name
- website if known
- phone number if known
- contact name/title if known
- product context

### 11.3 Outputs

- normalized company profile
- contact hypothesis
- likely role and buying authority
- top pains
- relevant hooks
- source citations

### 11.4 Worker Responsibilities

- resolve company identity
- gather and summarize company info
- infer persona
- store structured findings
- generate compact research packet for strategy worker

### 11.5 Initial Constraint

Do not overbuild prospect discovery yet.

In the MVP, support:

- user-supplied company
- user-supplied number
- optional CSV import later

### 11.6 Exit Criteria

- the worker produces a usable research packet for at least 80 percent of clean direct-mode inputs
- sources and confidence scores are stored

## 12. Phase 5: Strategy Worker

### 12.1 Objective

Turn research into a compact, high-signal `call_brief`.

### 12.2 Outputs

The `call_brief` must include:

- company summary
- persona summary
- top pains
- top value props
- recommended opening lines
- qualification questions
- objection tree
- CTA choices
- risk flags
- forbidden claims

### 12.3 Additional Work

Build a `sales-playbooks` package with:

- sales stages
- persuasion frames
- objection patterns
- CTA templates
- industry-specific message kits

### 12.4 Prompt Versioning

Every generated brief must store:

- strategy prompt version
- playbook version
- model used
- generation timestamp

### 12.5 Exit Criteria

- the brief is compact enough for realtime use
- the operator can review it before calling
- the brief version is immutable

## 13. Phase 6: Policy Gate

### 13.1 Objective

Add a deterministic control layer before any call starts.

### 13.2 Work

Implement a policy service that evaluates:

- missing required fields
- blocked lead statuses
- forbidden claims in generated brief
- restricted personas or account types
- unsupported booking or transfer conditions

### 13.3 Decision Model

The output must be one of:

- `allowed`
- `blocked`
- `review_required`

### 13.4 Exit Criteria

- no call can start without a policy decision
- blocked and review-required outcomes are visible in the UI

## 14. Phase 7: Dialer Service

### 14.1 Objective

Own call initiation and telephony provider integration.

### 14.2 Responsibilities

- start outbound calls
- attach call metadata
- receive webhook status changes
- connect Sonetel session/media bridge to voice gateway
- normalize provider events

### 14.3 Core Endpoints

- `POST /dialer/calls`
- `POST /dialer/webhooks/status`
- `POST /dialer/webhooks/answer`
- `POST /dialer/webhooks/session`

### 14.4 Exit Criteria

- the system can place a real outbound test call
- call states are synchronized into Postgres
- Sonetel events are normalized into the internal call event model

## 15. Phase 8: Voice Gateway

### 15.1 Objective

Build the low-latency bridge between telephony and the realtime model.

### 15.2 Responsibilities

- media stream session setup
- Sonetel media/session bridge handling
- audio normalization
- duplex streaming
- interruption detection
- partial transcript buffering
- session state cache
- safe function/tool wrappers
- latency tracking
- fail-fast recovery behavior

### 15.3 Session Inputs

When a call begins, load:

- prompt contract version
- `call_brief`
- current lead state
- product facts summary
- live tool permissions
- Azure OpenAI deployment configuration

### 15.4 Voice Gateway Non-Goals

Do not put these inside the gateway:

- heavy research
- CRM sync logic
- prompt optimization
- broad database access

### 15.5 Exit Criteria

- one call can sustain a two-way realtime conversation
- interruption handling works
- transcript chunks are persisted
- latency metrics are emitted for each turn

## 16. Phase 9: Live Tool Service

### 16.1 Objective

Expose a small, safe tool surface to the realtime call brain.

### 16.2 Tool Set

- `get_call_brief`
- `lookup_product_fact`
- `lookup_case_study`
- `lookup_pricing_guardrails`
- `update_call_stage`
- `log_objection`
- `create_followup_task`
- `book_meeting`
- `escalate_to_human`
- `end_call_with_disposition`

### 16.3 Design Rules

- each tool is deterministic
- each tool enforces auth by session ID
- each tool has strict request/response schemas
- each tool has timeout budgets

### 16.4 Exit Criteria

- the voice model can retrieve context and perform minimal actions without broad internal access

## 17. Phase 10: Realtime Prompt System

### 17.1 Objective

Create the initial prompt contracts for the speaking agent.

### 17.2 Prompt Layers

Implement reusable prompt builders for:

- global behavior
- sales methodology
- campaign strategy
- lead brief
- live state

### 17.3 First Prompt Rules

The first call brain should:

- sound concise and natural
- avoid long monologues
- ask one question at a time
- map each turn to a stage
- avoid making unsupported claims
- prefer micro-commitments over hard closes

### 17.4 Exit Criteria

- prompt contracts are versioned in code and database
- a call can be replayed against a known prompt version

## 18. Phase 11: Post-Call Pipeline

### 18.1 Objective

Close the loop after the call ends.

### 18.2 Work

Build workers for:

- transcript assembly
- structured summary
- disposition extraction
- objection extraction
- follow-up draft generation
- CRM writeback

### 18.3 Outputs

Store:

- final transcript
- structured summary
- call outcome
- next best action
- follow-up task or message draft

### 18.4 Exit Criteria

- every completed call produces a summary and disposition
- the operator can inspect the transcript and next action in the UI

## 19. Phase 12: Evaluation Layer

### 19.1 Objective

Start measuring quality from the first calls instead of waiting for scale.

### 19.2 Minimum Evaluation Metrics

- pickup rate
- human talk ratio
- model talk ratio
- time to first response
- interruption count
- objection count
- CTA attempt rate
- meeting-booked rate
- hallucination flags
- tool timeout count

### 19.3 Evaluation Outputs

Per call:

- stage quality score
- factuality score
- objection handling score
- CTA timing score
- overall call quality score

### 19.4 Exit Criteria

- every call has a machine-generated scorecard
- the team can review worst calls by failure type

## 20. Phase 13: Human Escalation and Review

### 20.1 Objective

Prevent the system from being trapped in bad calls.

### 20.2 Work

Add:

- manual call takeover
- escalation queue
- review-required queue
- manager note support
- replay tooling

### 20.3 Exit Criteria

- an operator can review flagged calls
- bad calls can be ended or transferred cleanly

## 21. Phase 14: Campaign Mode

### 21.1 Objective

Expand from one-off calling to list-driven outbound.

### 21.2 Features

- campaign intake
- CSV lead import
- company/contact dedupe
- batch research scheduling
- lead scoring
- call scheduling windows
- concurrency controls
- retry and cooldown policies

### 21.3 Campaign Services

Extend with:

- `campaign planner`
- `prospect import worker`
- `lead scoring worker`
- `sequence worker`

### 21.4 Exit Criteria

- a user can create a campaign, upload leads, and launch a controlled outbound run

## 22. Phase 15: Optimization Loop

### 22.1 Objective

Turn data into conversion improvements.

### 22.2 Work

Build:

- prompt experiments
- strategy variant experiments
- simulation harness with synthetic prospects
- failure clustering
- playbook updates

### 22.3 Rules

- no prompt change ships without versioning
- no prompt change becomes default without measured results

### 22.4 Exit Criteria

- the system can A/B test prompt variants on bounded traffic
- the team can measure conversion deltas by prompt version

## 23. First 8-Week Execution Plan

This is the shortest realistic route to a working alpha.

### Week 1

- initialize monorepo
- set up local infra
- add service shells
- add lint/typecheck/test baseline
- create DB package and first migrations
- draft PRD, event schema, and prompt contracts

### Week 2

- implement app API
- build direct mode intake UI
- implement Temporal workflows
- add shared event contracts
- add structured logs and correlation IDs

### Week 3

- build research worker
- implement company/contact normalization
- store research packets
- build strategy worker
- generate first `call_brief`

### Week 4

- implement policy gate
- implement dialer service
- connect outbound Sonetel test call flow
- persist call session lifecycle

### Week 5

- implement voice gateway
- connect Sonetel media/session bridge to Azure OpenAI realtime
- persist partial transcript and turn logs
- build live tool service with read-mostly tools

### Week 6

- harden prompt contracts
- add stage tracking
- add meeting booking and disposition tools
- ship post-call summary and follow-up generation

### Week 7

- add evaluation worker
- add transcript review UI
- add latency and tool metrics dashboard
- add replay and debug utilities

### Week 8

- run internal alpha
- review failed calls
- fix top latency and prompt issues
- add human escalation controls
- declare `Direct Mode Alpha`

## 24. Alpha Acceptance Criteria

The system is alpha-ready when all of these are true:

- an operator can submit a direct-mode lead in the UI
- the system generates a reviewable `call_brief`
- the system can place a real outbound call
- the realtime agent can hold a coherent conversation for at least 60 seconds
- transcript and summary are stored for every completed call
- follow-up tasks are created automatically
- latency and failure metrics are visible
- prompt and brief versions are traceable per call

## 25. Beta Acceptance Criteria

The system is beta-ready when:

- direct mode works reliably across repeated calls
- the system survives provider and tool failures gracefully
- review queues and escalation paths exist
- evaluation scorecards are available for all calls
- operators can inspect call replays
- campaign mode can process bounded batches

## 26. Technical Risks and Mitigations

### Risk 1. Live latency is too high

Mitigation:

- keep the voice path thin
- cache brief data in memory
- minimize live tool calls
- cap tool latency budgets

### Risk 2. Research quality is too weak

Mitigation:

- store source evidence
- add confidence scoring
- keep operator review in direct mode
- iterate research prompts separately from call prompts

### Risk 3. The voice model rambles or overtalks

Mitigation:

- short prompt rules
- turn-stage enforcement
- evaluator scoring on verbosity
- use examples of concise turns

### Risk 4. Calls become nondeterministic and hard to debug

Mitigation:

- version every prompt
- version every brief
- log every tool call
- persist turn-level state snapshots

### Risk 5. Workers mutate state inconsistently

Mitigation:

- orchestrator owns state transitions
- use outbox/event patterns
- enforce idempotent activities

## 27. Coding Priorities

When implementation starts, code in this order:

1. shared contracts
2. database schema
3. orchestrator workflows
4. direct mode UI + API
5. research worker
6. strategy worker
7. dialer service
8. voice gateway
9. live tool service
10. post-call pipeline
11. evaluation worker
12. campaign features

## 28. What Not to Build Yet

Delay these until after alpha:

- custom model fine-tuning
- autonomous prospect discovery from the whole web
- heavy multi-agent debate loops in live calls
- multilingual support
- advanced CRM integrations beyond one basic path
- complex role/permission systems
- warehouse-first analytics stack
- full inbound support beyond the provider adapter boundary

## 29. Immediate Next Deliverables

These are the next documents and artifacts to create in this repo:

1. `docs/product-requirements.md`
2. `docs/event-schema.md`
3. `docs/prompt-contracts.md`
4. `docs/call-state-machine.md`
5. `docs/evaluation-rubric.md`
6. monorepo scaffold
7. Postgres schema and migrations
8. Temporal workflow skeleton
9. direct mode intake UI
10. research and strategy worker stubs

## 30. Final Recommendation

Treat `direct mode` as the real wedge.

If direct mode works, you will have:

- the data model
- the call loop
- the prompt system
- the voice gateway
- the post-call analytics
- the evaluation layer

Once those exist, campaign mode is an expansion problem.

Without those, campaign mode is just a way to fail faster at scale.
