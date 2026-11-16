/**
 * learn-events.ts — process-local listeners for RC-18 learn.* facts (rulings 450–452).
 *
 * Offline grow/eval paths notify here; Runtime (when live) projects into the
 * session log. Listeners must never throw into curate/eval.
 */

export type LearnProposalCreatedInfo = {
  proposalId: string;
  kind: string;
  title: string;
  status: "proposed";
};

export type LearnEvalCompletedInfo = {
  evalId: string;
  caseCount: number;
  passed: number;
  failed: number;
  gate: "pass" | "fail";
};

export type LearnTrajectoryRecordedInfo = {
  trajectoryId: string;
  rootSessionId: string;
  eventCount: number;
};

type Listener<T> = (info: T) => void;

const proposalListeners = new Set<Listener<LearnProposalCreatedInfo>>();
const evalListeners = new Set<Listener<LearnEvalCompletedInfo>>();
const trajectoryListeners = new Set<Listener<LearnTrajectoryRecordedInfo>>();

function notify<T>(listeners: Set<Listener<T>>, info: T): void {
  for (const listener of listeners) {
    try {
      listener(info);
    } catch {
      /* ignore */
    }
  }
}

export function onLearnProposalCreated(listener: Listener<LearnProposalCreatedInfo>): () => void {
  proposalListeners.add(listener);
  return () => {
    proposalListeners.delete(listener);
  };
}

export function notifyLearnProposalCreated(info: LearnProposalCreatedInfo): void {
  notify(proposalListeners, info);
}

export function onLearnEvalCompleted(listener: Listener<LearnEvalCompletedInfo>): () => void {
  evalListeners.add(listener);
  return () => {
    evalListeners.delete(listener);
  };
}

export function notifyLearnEvalCompleted(info: LearnEvalCompletedInfo): void {
  notify(evalListeners, info);
}

export function onLearnTrajectoryRecorded(listener: Listener<LearnTrajectoryRecordedInfo>): () => void {
  trajectoryListeners.add(listener);
  return () => {
    trajectoryListeners.delete(listener);
  };
}

export function notifyLearnTrajectoryRecorded(info: LearnTrajectoryRecordedInfo): void {
  notify(trajectoryListeners, info);
}
