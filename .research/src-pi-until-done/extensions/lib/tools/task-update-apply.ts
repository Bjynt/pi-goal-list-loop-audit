import type { Static } from "typebox";
import type { TaskUpdateParams } from "../schemas/task-update";
import type { Task } from "../types";

type Patch = Static<typeof TaskUpdateParams>["patch"];

const replaceFields = (next: Task, p: Patch): Task => {
	if (p.status) next.status = p.status;
	if (p.phase) next.phase = p.phase;
	if (p.prerequisites) next.prerequisites = p.prerequisites;
	if (p.validationSteps) next.validationSteps = p.validationSteps;
	if (p.ciCommands) next.ciCommands = p.ciCommands;
	if (p.styleguideRules) next.styleguideRules = p.styleguideRules;
	if (p.guardrails) next.guardrails = p.guardrails;
	if (p.notes !== undefined) next.notes = p.notes;
	return next;
};

const appendFields = (next: Task, p: Patch): Task => {
	if (p.addLearning) next.learnings = [...next.learnings, p.addLearning];
	if (p.addGotcha) next.gotchas = [...next.gotchas, p.addGotcha];
	if (p.addContext) next.context = [...next.context, p.addContext];
	return next;
};

export const applyTaskPatch = (original: Task, p: Patch): Task =>
	appendFields(replaceFields({ ...original }, p), p);
