CREATE TABLE IF NOT EXISTS app_records (
  kind TEXT NOT NULL,
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_records_kind ON app_records(kind);

CREATE TABLE IF NOT EXISTS events_outbox (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  correlation_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_outbox_aggregate_id ON events_outbox(aggregate_id);
CREATE INDEX IF NOT EXISTS idx_events_outbox_name ON events_outbox(name);
