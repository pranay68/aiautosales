import { db } from "@aiautosales/db";
import type { FollowupTask, SequencePlan } from "@aiautosales/domain-models";
import { createFollowupTask } from "@aiautosales/live-tool-service";
import { createEvent } from "@aiautosales/shared-events";

export type SequenceOutcome =
  | "booked_meeting"
  | "meeting_booked"
  | "callback_requested"
  | "no_answer"
  | "not_interested"
  | "nurture"
  | "blocked"
  | "other";

export type SequencePlanResult = {
  plan: SequencePlan;
  followup?: FollowupTask;
};

export async function planNextSequence(input: {
  prospectId: string;
  callSessionId: string;
  outcome: SequenceOutcome;
  followupSummary?: string;
  correlationId: string;
}): Promise<SequencePlanResult> {
  const prospect = await db.getProspect(input.prospectId);
  if (!prospect) {
    throw new Error(`Unknown prospect ${input.prospectId}`);
  }

  const now = new Date();
  const current = now.toISOString();
  const channel = deriveChannel(input.outcome);
  const nextState = deriveNextState(input.outcome, channel);
  const summary =
    input.followupSummary ?? deriveSummary(input.outcome, channel);
  const nextTouchAt = deriveNextTouchAt(input.outcome, now).toISOString();

  const plan: SequencePlan = {
    id: crypto.randomUUID(),
    workspaceId: prospect.workspaceId,
    prospectId: input.prospectId,
    callSessionId: input.callSessionId,
    outcome: input.outcome,
    recommendedChannel: channel,
    nextState,
    summary,
    nextTouchAt,
    createdAt: current
  };

  await db.putSequencePlan(plan);
  await db.appendEvent(createEvent("sequence.planned", input.prospectId, plan, input.correlationId));
  await db.updateProspect(input.prospectId, (prospect) => ({
    ...prospect,
    state: nextState,
    updatedAt: current
  }));

  const followup = await createFollowupTask({
    prospectId: input.prospectId,
    callSessionId: input.callSessionId,
    channel,
    summary
  });
  await db.appendEvent(createEvent("followup.created", input.prospectId, followup, input.correlationId));
  return { plan, followup };
}

export function determineSequenceChannel(outcome: SequenceOutcome): FollowupTask["channel"] {
  return deriveChannel(outcome);
}

function deriveChannel(outcome: SequenceOutcome): FollowupTask["channel"] {
  if (outcome === "booked_meeting" || outcome === "meeting_booked") {
    return "meeting";
  }

  if (outcome === "callback_requested") {
    return "callback";
  }

  if (outcome === "no_answer") {
    return "sms";
  }

  return "email";
}

function deriveNextState(outcome: SequenceOutcome, channel: FollowupTask["channel"]): SequencePlan["nextState"] {
  if (outcome === "booked_meeting" || outcome === "meeting_booked") {
    return "SEQUENCE_SCHEDULED";
  }

  if (outcome === "blocked" || outcome === "not_interested") {
    return "NURTURE";
  }

  if (channel === "callback" || channel === "sms" || channel === "email") {
    return "FOLLOWUP_GENERATED";
  }

  return "FOLLOWUP_GENERATED";
}

function deriveSummary(outcome: SequenceOutcome, channel: FollowupTask["channel"]): string {
  if (channel === "meeting") {
    return "Meeting booked on the call. Confirm calendar details and send a recap.";
  }

  if (channel === "callback") {
    return "Callback requested. Follow up at the agreed time with a tighter agenda.";
  }

  if (outcome === "no_answer") {
    return "No answer. Retry once during a more favorable time window, then fall back to email.";
  }

  if (channel === "sms") {
    return "Send a short text follow-up that references the call attempt and offers an easy reply path.";
  }

  if (channel === "email") {
    return "Send a concise follow-up email that restates relevance, gives one proof point, and offers a short meeting.";
  }

  if (outcome === "blocked" || outcome === "not_interested") {
    return "Prospect is not ready. Move to nurture with a lower-friction follow-up sequence.";
  }

  return "Create a follow-up sequence based on the call outcome.";
}

function deriveNextTouchAt(outcome: SequenceOutcome, now: Date): Date {
  if (outcome === "booked_meeting" || outcome === "meeting_booked") {
    return new Date(now.getTime() + 15 * 60 * 1000);
  }

  if (outcome === "callback_requested") {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }

  if (outcome === "no_answer") {
    return new Date(now.getTime() + 4 * 60 * 60 * 1000);
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}
