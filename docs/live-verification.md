# Live Verification

Use this to verify the deployed production-like path:

- public API reachable
- direct workflow runs
- Sonetel submits outbound call
- FreeSWITCH claims the bridge
- bridge reaches `connected` or `completed`
- transcript, sequence, and follow-up state are inspectable

Run:

```bash
node scripts/verify-live-vm-call.mjs +12025550123
```

Optional repeated attempts:

```bash
node scripts/verify-live-vm-call.mjs +12025550123 3
```

Environment overrides:

- `AIAUTOSALES_VERIFY_BASE_URL`
- `AIAUTOSALES_VERIFY_API_KEY`
- `AIAUTOSALES_VERIFY_WORKSPACE`
- `AIAUTOSALES_VERIFY_POLL_ATTEMPTS`
- `AIAUTOSALES_VERIFY_POLL_INTERVAL_MS`

The script reports:

- workflow run id
- prospect id
- call session id
- bridge session id
- provider status
- call status
- bridge status
- transcript turn count
- sequence plan presence
- follow-up count

Readiness interpretation:

- `submitted=true` means Sonetel accepted the outbound request
- `connected=true` means the SIP leg reached the live bridge
- `completed=true` means the bridge/call lifecycle closed
- `transcriptPresent=true` means a real transcript turn was persisted
- `sequenced=true` means follow-up planning executed
