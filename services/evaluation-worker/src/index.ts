import { db } from "@aiautosales/db";

export function evaluateCall(callSessionId: string) {
  return db.listTranscriptTurns(callSessionId).then((turns) => {
  const agentTurns = turns.filter((turn) => turn.speaker === "agent").length;
  const prospectTurns = turns.filter((turn) => turn.speaker === "prospect").length;

  return {
    callSessionId,
    stageQualityScore: 0.72,
    factualityScore: 0.9,
    objectionHandlingScore: 0.68,
    ctaTimingScore: 0.75,
    overallCallQualityScore: 0.76,
    turnCount: turns.length,
    talkBalance: {
      agentTurns,
      prospectTurns
    }
  };
  });
}
