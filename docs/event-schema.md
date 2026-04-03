# Event Schema

## Envelope

```ts
type DomainEvent<TPayload> = {
  id: string;
  name: string;
  aggregateId: string;
  payload: TPayload;
  occurredAt: string;
  correlationId: string;
};
```

## Events

### `product.created`

Aggregate: `product.id`

Payload:

- product metadata

### `prospect.created`

Aggregate: `prospect.id`

Payload:

- productId
- companyId
- contactId
- sourceMode
- current state

### `prospect.research.requested`

Aggregate: `prospect.id`

Payload:

- direct call request or campaign request

### `prospect.researched`

Aggregate: `prospect.id`

Payload:

- company summary
- persona summary
- pains
- hooks
- source notes
- confidence

### `strategy.generated`

Aggregate: `prospect.id`

Payload:

- call brief
- prompt version
- playbook version

### `policy.checked`

Aggregate: `prospect.id`

Payload:

- status
- reasons

### `call.requested`

Aggregate: `prospect.id`

Payload:

- call session
- provider
- strategy version

### `call.started`

Aggregate: `prospect.id`

Payload:

- call session
- startedAt

### `call.turn.logged`

Aggregate: `prospect.id`

Payload:

- turn or session event
- speaker
- text
- timestamp

### `call.ended`

Aggregate: `prospect.id`

Payload:

- call session
- endedAt
- outcome
- latencyMsP95

### `followup.created`

Aggregate: `prospect.id`

Payload:

- channel
- summary
- dueAt

### `sequence.planned`

Aggregate: `prospect.id`

Payload:

- outcome
- recommended channel
- next state
- summary
- next touch time

### `evaluation.completed`

Aggregate: `callSession.id`

Payload:

- scorecard
- talk balance
- failure markers
