import type { State } from "./goal-loop-core.js";

/** GLLA-owned work planes covered by the single continuous checker. */
export type SupervisionPlane =
  | "goal"
  | "list"
  | "loop"
  | "auditor"
  | "subagent"
  | "provider-recovery"
  | "queue";

export type SupervisionSignalKind = "start" | "progress" | "complete" | "recover" | "block";

export interface SupervisionSignal {
  plane: SupervisionPlane;
  kind: SupervisionSignalKind;
  source: string;
}

export const SUPERVISION_MIN_POLL_MS = 250;
export const SUPERVISION_MAX_POLL_MS = 15_000;

/**
 * Derive the work planes that need supervision from durable state. This is a
 * projection only: it does not infer completion from elapsed time and it does
 * not treat a queued list item as an active goal.
 */
export function activeSupervisionPlanes(state: State, liveSubagentCount = 0): SupervisionPlane[] {
  const planes: SupervisionPlane[] = [];
  const goal = state.goal;
  if (goal) {
    if (goal.policy === "list" && (goal.status === "active" || goal.status === "auditing")) planes.push("list");
    if (goal.policy === "goal" && (goal.status === "active" || goal.status === "auditing")) planes.push("goal");
    if (goal.status === "auditing" || !!goal.pendingCompletion) planes.push("auditor");
  }
  if (state.loop?.active) planes.push("loop");
  if ((state.list?.length ?? 0) > 0) planes.push("queue");
  if (state.mainModelRecovery) planes.push("provider-recovery");
  if (liveSubagentCount > 0) planes.push("subagent");
  return planes;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Small stateful policy core for the production heartbeat. A real lifecycle
 * or durable-state signal resets the fallback poll backoff; absent signals
 * back off from 250ms to the 15s safety cadence. The caller still decides
 * which safe recovery action each signal permits.
 */
export class ContinuousSupervisor {
  private pollAttempt = 0;
  private lastStateSignature = "";
  private planes: SupervisionPlane[] = [];
  private readonly lastSignals = new Map<SupervisionPlane, SupervisionSignal>();

  signal(signal: SupervisionSignal): void {
    this.lastSignals.set(signal.plane, signal);
    this.pollAttempt = 0;
  }

  observeState(state: State, liveSubagentCount = 0): SupervisionPlane[] {
    const planes = activeSupervisionPlanes(state, liveSubagentCount);
    const signature = planes.join(",");
    if (signature !== this.lastStateSignature) {
      this.lastStateSignature = signature;
      for (const plane of planes) this.signal({ plane, kind: "progress", source: "durable-state" });
    }
    this.planes = planes;
    return planes;
  }

  /** Advance the fallback poll schedule after a check with no new signal. */
  nextPollMs(active = this.planes.length > 0): number {
    if (!active) {
      this.pollAttempt = 0;
      return SUPERVISION_MAX_POLL_MS;
    }
    const delay = Math.min(
      SUPERVISION_MAX_POLL_MS,
      SUPERVISION_MIN_POLL_MS * (2 ** Math.min(this.pollAttempt, 6)),
    );
    this.pollAttempt = Math.min(this.pollAttempt + 1, 6);
    return delay;
  }

  snapshot(): {
    planes: SupervisionPlane[];
    pollAttempt: number;
    lastSignals: Partial<Record<SupervisionPlane, SupervisionSignal>>;
  } {
    return {
      planes: [...this.planes],
      pollAttempt: this.pollAttempt,
      lastSignals: Object.fromEntries(this.lastSignals.entries()),
    };
  }
}

/** Stable list helper for tests and status projections. */
export function uniqueSupervisionPlanes(planes: SupervisionPlane[]): SupervisionPlane[] {
  return unique(planes);
}
