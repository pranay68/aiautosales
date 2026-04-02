export type LogLevel = "info" | "warn" | "error";

export function createCorrelationId(): string {
  return crypto.randomUUID();
}

export function log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
  const line = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context
  };

  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

