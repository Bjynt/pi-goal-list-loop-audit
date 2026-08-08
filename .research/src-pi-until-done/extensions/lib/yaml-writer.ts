import * as fs from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { GoalState } from "./types";

const buildYaml = (s: GoalState) => ({
	generated: new Date().toISOString(),
	goalId: s.id,
	goal: s.goal,
	doneCriteria: s.doneCriteria,
	verifyCommand: s.verifyCommand,
	phase: s.phase,
	askBefore: s.askBefore,
	decisionStyle: s.decisionStyle,
	budget: { used: s.turnsUsed, max: s.maxTurns },
	currentTaskId: s.currentTaskId,
	tasks: s.tasks,
});

export const writeTasksYaml = (cwd: string, s: GoalState): void => {
	try {
		const dir = path.join(cwd, ".until-done");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "tasks.yaml"), yamlStringify(buildYaml(s)));
	} catch {
		// best-effort; never fail the goal because of disk issues
	}
};
