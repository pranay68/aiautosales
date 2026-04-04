import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";

export type LogLevel = "info" | "warn" | "error";

let initialized = false;
let currentServiceName = "unknown";

export function initializeTelemetry(serviceName: string, serviceVersion = "0.1.0"): void {
  currentServiceName = serviceName;

  if (initialized) {
    return;
  }

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (connectionString) {
    useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString
      },
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_NAMESPACE]: "aiautosales",
        [ATTR_SERVICE_VERSION]: serviceVersion
      })
    });
  }

  initialized = true;
}

export function createCorrelationId(): string {
  return crypto.randomUUID();
}

export function log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();
  const line = {
    level,
    message,
    service: currentServiceName,
    timestamp: new Date().toISOString(),
    traceId: spanContext?.traceId,
    spanId: spanContext?.spanId,
    ...context
  };

  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  work: () => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer("aiautosales");

  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        span.setAttribute(key, value);
      }
    }

    try {
      const result = await work();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
