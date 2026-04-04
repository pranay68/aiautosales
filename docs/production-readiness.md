# Production Readiness Backlog

## Goal

Move `aiautosales` from a strong internal alpha into a reliable production system for controlled outbound sales operations.

This document is the current gap list. It is not architecture theory. It is the remaining work needed before the system should be trusted as a real revenue machine.

## Current Status

The system already has:

- direct-mode workflow
- Azure OpenAI reasoning path
- Azure Realtime voice path
- Sonetel adapter path
- bridge/session lifecycle
- follow-up and sequence planning
- operator API auth
- workspace isolation
- build/typecheck coverage
- workspace isolation smoke coverage

The system is therefore:

- ready for internal alpha
- ready for controlled live verification
- not yet ready for unsupervised high-volume production outbound

## Remaining Production Gaps

### 1. Real Authentication And RBAC

Current state:

- one shared operator API key
- no user identities
- no role model

Needed:

- real operator login
- workspace membership model
- role-based access control
- separate permissions for admin, operator, reviewer, and analyst
- session management and token expiry
- audit trail for privileged actions

Why it matters:

- one shared key is not a production auth system
- you cannot safely operate multiple users or teams without identity and access boundaries

### 2. Production Deployment And Runtime Supervision

Current state:

- services build and run locally
- some external infra exists
- runtime assumptions are still partially manual

Needed:

- production deployment topology for API, bridge, workers, and web
- process supervision / container orchestration
- environment separation for dev, staging, prod
- startup ordering and dependency checks
- health probes and restart policies
- secret management through Azure-native secret storage

Why it matters:

- a production calling system cannot depend on manual shell launches and implicit runtime state

### 3. Observability, Alerting, And Replay

Current state:

- structured logs exist
- basic validation scripts exist

Needed:

- centralized logs
- distributed tracing across API, orchestrator, bridge, dialer, and voice gateway
- metrics for call lifecycle, latency, failures, and provider health
- alerts for failed workflows, bridge failures, telephony failures, and Azure Realtime issues
- operator-visible replay surfaces for calls, bridge sessions, and workflow steps

Why it matters:

- production failures will happen
- without observability, you cannot debug revenue-impacting failures quickly

### 4. Workflow Reliability Hardening

Current state:

- core workflow exists
- Temporal skeleton exists
- some durable storage exists

Needed:

- full idempotency across external operations
- retry policies per provider edge
- dead-letter handling for failed jobs/events
- compensation logic for partially failed workflows
- deterministic workflow ownership of state transitions
- stronger timeout handling for every external dependency

Why it matters:

- duplicate calls, duplicate follow-ups, or orphaned sessions are unacceptable in production outbound

### 5. Full Live Outbound Verification

Current state:

- Sonetel path exists
- FreeSWITCH / bridge path exists
- Azure Realtime path exists
- controlled pieces have been validated

Needed:

- repeatable real outbound call test under production-style runtime
- proof that Sonetel -> SIP ingress -> bridge -> Azure Realtime -> transcript -> sequence completion works reliably
- repeated run verification, not one-off success
- real latency measurements under live conditions

Why it matters:

- the system is only production-ready after the full voice loop is reliable on real calls

### 6. Durable Event And Audit Fidelity

Current state:

- events exist
- workspace filtering exists
- some event payloads are still best-effort for workspace scoping

Needed:

- explicit workspace-aware event persistence
- immutable audit log for major actions
- consistent event schemas across all producers
- replay-safe event storage

Why it matters:

- production systems need traceability for debugging, compliance, and operator accountability

### 7. Compliance And Policy Hardening

Current state:

- policy gate exists
- call strategy constraints exist

Needed:

- stronger deterministic compliance checks
- region/time-window calling restrictions
- disclosure policy enforcement
- forbidden-claim enforcement
- call recording and consent policy handling
- escalation path for policy violations

Why it matters:

- outbound voice sales touches legal and compliance risk directly

### 8. CRM And Scheduling Integrations

Current state:

- internal follow-up and sequence planning exist
- no hardened downstream system-of-record sync

Needed:

- CRM sync with retries and reconciliation
- meeting booking integration
- calendar sync
- delivery guarantees for follow-up actions
- operator review for high-value opportunities

Why it matters:

- booked meetings and follow-ups only matter if they land in the systems the sales team actually uses

### 9. Campaign Mode At Real Scale

Current state:

- direct mode is the current wedge
- campaign architecture exists, but scale execution is not fully hardened

Needed:

- lead import and dedupe
- lead prioritization
- calling windows and concurrency controls
- batch scheduling
- throttling and backpressure
- retry and stop conditions at campaign scale
- reporting for pickup rate, meeting rate, and failure clusters

Why it matters:

- production outbound volume needs operational controls, not just the direct-mode call path

### 10. Evaluation And Continuous Improvement Loop

Current state:

- evaluation exists
- strategy and follow-up generation exist

Needed:

- stable evaluation datasets
- scoring dashboards
- prompt/version experiment tracking
- regression detection
- failure clustering
- promotion rules for prompt/playbook changes

Why it matters:

- the product needs a controlled learning loop, not ad hoc prompt drift

## Recommended Execution Order

### Phase 1. Controlled Live Reliability

Do first:

- full live outbound verification
- workflow reliability hardening
- observability and alerting

Success condition:

- repeated live calls complete end to end with transcripts, dispositions, and follow-ups

### Phase 2. Production Access And Governance

Do next:

- real auth and RBAC
- durable audit/event fidelity
- compliance hardening

Success condition:

- multiple operators can use the platform safely with traceable actions and policy controls

### Phase 3. Sales System Integration

Do next:

- CRM sync
- scheduling and booking integration
- operator review flows

Success condition:

- successful calls turn into reliable downstream sales actions

### Phase 4. Scale-Out Outbound

Do last:

- campaign mode hardening
- concurrency controls
- evaluation and optimization loop

Success condition:

- the system can run repeated outbound campaigns with measurable performance and operational safety

## Immediate Next Step

The next concrete milestone should be:

- run a fully live controlled outbound call under one workspace
- record the exact failure points, latencies, and transcript quality
- fix the gaps found there before expanding scope

That is the shortest path from internal alpha to a real production lane.
