# AI Auto Sales

Initial implementation scaffold for an autonomous sales calling system using Azure OpenAI and Sonetel.

Start here if you are new to the repo:

- `docs/agent-handoff.md`

## Current state

- npm workspaces monorepo
- direct-mode backend flow
- in-memory persistence for local development
- service shells for orchestration, research, strategy, dialer, voice gateway, sequence, live tools, and evaluation
- bridge gateway for the AI-side telephony ingress boundary
- live Azure OpenAI Realtime speaking-agent runtime
- optional Postgres-backed repository mode
- Temporal workflow skeleton and worker service
- Azure OpenAI client package for reasoning and realtime session config

## Run

```bash
npm install
npm run dev:api
npm run dev:web
```

The API starts on `http://localhost:4000`.
The operator console starts on `http://localhost:3000`.

Set `OPERATOR_API_KEY` in `.env` and use that same value in the web console or as the `x-api-key` header for API calls. Set `DEFAULT_WORKSPACE_ID` for the default tenant boundary, or override it per request with `x-workspace-id`. `GET /health` can remain unauthenticated when `ALLOW_UNAUTHENTICATED_HEALTH=true`.

Operator auth:

- bootstrap the first workspace/operator with `POST /auth/bootstrap` using `x-api-key: $OPERATOR_API_KEY`
- log in with `POST /auth/login`
- use `Authorization: Bearer <token>` for workspace-scoped operator access
- legacy `x-api-key` access still works for admin/bootstrap and local ops, but bearer auth is now the intended path

Telemetry:

- set `APPLICATIONINSIGHTS_CONNECTION_STRING` to enable Azure Monitor export from the API, bridge gateway, and Temporal worker
- request completion telemetry is emitted for the operator API and bridge gateway
- direct-call and bridge-session creation paths now emit traced spans when Azure Monitor is configured

Useful validation commands:

```bash
npm run validate:azure-realtime
npm run validate:bridge-config
npm run validate:sonetel-config
npm run refresh:sonetel-token
npm run smoke:workspace-isolation
npm run smoke:auth-idempotency
npm run smoke:bridge-realtime
```

Telephony safety:

- `SONETEL_ENABLE_LIVE_OUTBOUND=false` keeps outbound call execution in dry-run mode
- set it to `true` only when you are ready to let the adapter submit real outbound calls
- live Sonetel outbound now uses the callback API, so `SONETEL_AGENT_DESTINATION` is required for the AI-side call leg
- `SONETEL_OUTGOING_CALLER_ID` controls the number shown to the prospect leg

Useful provider endpoints:

- `GET /providers/sonetel/validate`
- `GET /providers/bridge/validate`
- `POST /providers/sonetel/webhooks`
- `GET /dashboard`
- `GET /workflow-runs`
- `GET /audit-entries`
- `GET /diagnostics/summary`
- `GET /diagnostics/failures`
- `GET /me`

FreeSWITCH ingress:

- Azure VM scaffold: `infra/azure/freeswitch/`
- goal: provide the callable SIP destination for `SONETEL_AGENT_DESTINATION`
- the VM runs FreeSWITCH and streams audio into `bridge-gateway`

## Production-leaning local stack

```bash
docker compose -f infra/local/docker-compose.yml up -d
```

Then switch `.env` toward:

```bash
DB_PROVIDER=postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiautosales
TEMPORAL_ADDRESS=localhost:7233
```

## Current reality

Real foundations now exist for:

- Postgres persistence
- Temporal workflows
- Azure OpenAI client wiring
- persisted bridge sessions and event-driven call completion
- post-call sequence planning
- booked-meeting and callback follow-up handling

Still stubbed:

- Azure VM deployment has not been executed yet
- Sonetel live outbound is still blocked until the Azure SIP ingress exists and is pointed at `SONETEL_AGENT_DESTINATION`
- some production auth features still need more depth, such as password reset, MFA, and richer RBAC policy
