import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, State } from "./goal-loop-core.js";
import { state } from "./goal-state.js";

/** The three user-facing long-running surfaces. */
export type ObjectiveKind = "goal" | "list" | "loop";
export type ObjectiveConflictChoice = "update" | "replace" | "cancel";

export interface LiveObjective {
  kind: ObjectiveKind;
  id: string;
  objective: string;
  status: string;
}

function liveGoal(goal: Goal | null | undefined): LiveObjective | null {
  if (!goal || !["active", "paused", "auditing"].includes(goal.status)) return null;
  return {
    kind: goal.policy === "list" ? "list" : "goal",
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
  };
}

/** Return every live slot, including a dirty pre-arbitration stacked state. */
export function liveObjectives(state: State): LiveObjective[] {
  const out: LiveObjective[] = [];
  const goal = liveGoal(state.goal);
  if (goal) out.push(goal);
  if (state.loop?.active) {
    out.push({
      kind: "loop",
      id: "loop",
      objective: state.loop.target,
      status: "active",
    });
  }
  return out;
}

function label(kind: ObjectiveKind): string {
  return kind === "loop" ? "/loop" : kind === "list" ? "/list" : "/goal";
}

/**
 * Ask before a new active surface can replace an existing one. A same-mode
 * start offers an in-place update because the user may have meant to tweak
 * the current objective. Cross-mode starts offer replacement/cancellation;
 * silently converting a goal into a loop (or vice versa) is never safe.
 *
 * Headless contexts cannot obtain consent, so they fail closed rather than
 * silently overwriting a live objective.
 */
export async function chooseObjectiveConflict(
  ctx: ExtensionContext,
  incoming: ObjectiveKind,
  objective: string,
  current: LiveObjective[] = liveObjectives(state),
): Promise<ObjectiveConflictChoice> {
  if (current.length === 0) return "replace";
  const currentText = current
    .map((item) => `${label(item.kind)} [${item.status}]: ${item.objective}`)
    .join("\n");
  const sameMode = current.length === 1 && current[0]!.kind === incoming;
  const updateOption = "Update current objective";
  const replaceOption = "Replace current objective";
  const cancelOption = "Cancel new objective";
  const options = sameMode ? [updateOption, replaceOption, cancelOption] : [replaceOption, cancelOption];
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Cannot start ${label(incoming)} while another objective is live:\n${currentText}\nUse the existing ${label(current[0]!.kind)} edit command, or explicitly cancel/replace it first.`,
      "warning",
    );
    return "cancel";
  }
  try {
    const selected = await ctx.ui.select(
      `An objective is already active:\n${currentText}\n\nNew ${label(incoming)}: ${objective.slice(0, 180)}\nChoose how to proceed:`,
      options,
    );
    if (selected === updateOption) return "update";
    if (selected === replaceOption) return "replace";
  } catch {
    // A stale/replaced UI is not consent to overwrite durable work.
  }
  return "cancel";
}
EOF