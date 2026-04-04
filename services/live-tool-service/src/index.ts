import { db } from "@aiautosales/db";
import type { FollowupTask } from "@aiautosales/domain-models";

export function getCallBrief(callBriefId: string) {
  return db.getCallBrief(callBriefId);
}

export async function lookupProductFact(productId: string): Promise<string[]> {
  const product = await db.getProduct(productId);
  if (!product) {
    return [];
  }

  return [product.offerSummary, product.description, `Primary ICP: ${product.icpSummary}`];
}

export async function createFollowupTask(input: {
  prospectId: string;
  callSessionId: string;
  channel: FollowupTask["channel"];
  summary: string;
}): Promise<FollowupTask> {
  const prospect = await db.getProspect(input.prospectId);
  if (!prospect) {
    throw new Error(`Unknown prospect ${input.prospectId}`);
  }

  const task: FollowupTask = {
    id: crypto.randomUUID(),
    workspaceId: prospect.workspaceId,
    prospectId: input.prospectId,
    callSessionId: input.callSessionId,
    channel: input.channel,
    summary: input.summary,
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "open",
    createdAt: new Date().toISOString()
  };

  await db.putFollowup(task);
  return task;
}

export function endCallWithDisposition(callSessionId: string, outcome: string) {
  return db.updateCallSession(callSessionId, (current) => ({
    ...current,
    status: "completed",
    outcome,
    endedAt: new Date().toISOString()
  }));
}
