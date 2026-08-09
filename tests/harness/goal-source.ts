import fs from "node:fs";
import path from "node:path";

const GOAL_RUNTIME_SOURCE_FILES = [
  "extensions/loops/goal.ts",
  "extensions/loops/goal-session.ts",
  "extensions/loops/goal-ui.ts",
  "extensions/loops/goal-orchestrator.ts",
  "extensions/loops/goal-auditor-hooks.ts",
  "extensions/loops/goal-list-queue.ts",
  "extensions/loops/goal-tools.ts",
  "extensions/loops/goal-settings-ui.ts",
  "extensions/loops/goal-activation.ts",
];

export function readGoalRuntimeSource(): string {
  return GOAL_RUNTIME_SOURCE_FILES
    .map((file) => `\n/* ${file} */\n` + fs.readFileSync(path.resolve(file), "utf-8"))
    .join("\n");
}
