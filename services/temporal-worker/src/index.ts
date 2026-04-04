import { NativeConnection, Worker } from "@temporalio/worker";
import { loadEnv } from "@aiautosales/config";
import type { DirectCallRequest } from "@aiautosales/domain-models";
import { runDirectLeadWorkflow } from "@aiautosales/orchestrator";
import { initializeTelemetry, log, withSpan } from "@aiautosales/telemetry";

initializeTelemetry("temporal-worker");

async function main() {
  const env = loadEnv();
  const connection = await NativeConnection.connect({
    address: env.temporalAddress
  });

  const worker = await Worker.create({
    connection,
    taskQueue: env.temporalTaskQueue,
    workflowsPath: new URL("../../../packages/temporal-workflows/dist/index.js", import.meta.url).pathname,
    activities: {
      runDirectLead(input: DirectCallRequest) {
        return withSpan(
          "temporal-worker.run-direct-lead",
          {
            "aiautosales.workspace_id": input.workspaceId,
            "aiautosales.product_id": input.productId
          },
          () => runDirectLeadWorkflow(input)
        );
      }
    }
  });

  log("info", "temporal-worker.started", {
    temporalAddress: env.temporalAddress,
    namespace: env.temporalNamespace,
    taskQueue: env.temporalTaskQueue
  });
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
