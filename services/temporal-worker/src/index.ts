import { NativeConnection, Worker } from "@temporalio/worker";
import { loadEnv } from "@aiautosales/config";
import type { DirectCallRequest } from "@aiautosales/domain-models";
import { runDirectLeadWorkflow } from "@aiautosales/orchestrator";

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
        return runDirectLeadWorkflow(input);
      }
    }
  });

  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
