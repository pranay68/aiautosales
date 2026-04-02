import { proxyActivities } from "@temporalio/workflow";
import type { DirectCallRequest } from "@aiautosales/domain-models";

type DirectWorkflowActivities = {
  runDirectLead(input: DirectCallRequest): Promise<unknown>;
};

const activities = proxyActivities<DirectWorkflowActivities>({
  startToCloseTimeout: "5 minutes"
});

export async function directLeadWorkflow(input: DirectCallRequest) {
  return activities.runDirectLead(input);
}

