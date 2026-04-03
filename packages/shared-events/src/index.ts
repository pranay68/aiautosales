export type EventName =
  | "product.created"
  | "prospect.created"
  | "prospect.research.requested"
  | "prospect.researched"
  | "strategy.requested"
  | "strategy.generated"
  | "policy.checked"
  | "call.requested"
  | "call.bridge.created"
  | "call.bridge.updated"
  | "call.started"
  | "call.turn.logged"
  | "call.ended"
  | "followup.created"
  | "sequence.planned"
  | "evaluation.completed";

export type DomainEvent<TPayload = unknown> = {
  id: string;
  name: EventName;
  aggregateId: string;
  payload: TPayload;
  occurredAt: string;
  correlationId: string;
};

export function createEvent<TPayload>(
  name: EventName,
  aggregateId: string,
  payload: TPayload,
  correlationId: string
): DomainEvent<TPayload> {
  return {
    id: crypto.randomUUID(),
    name,
    aggregateId,
    payload,
    occurredAt: new Date().toISOString(),
    correlationId
  };
}
