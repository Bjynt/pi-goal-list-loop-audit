import { Type } from "typebox";
import {
	ContextRefSchema,
	PhaseLiteral,
	PrerequisiteSchema,
	TaskStatusLiteral,
} from "./literals";

export const TaskIdentityFields = {
	id: Type.String({ description: "Stable task id, e.g. T-001." }),
	title: Type.String({ description: "Imperative one-line description." }),
	phase: PhaseLiteral,
	status: TaskStatusLiteral,
};

export const TaskGraphFields = {
	dependencies: Type.Array(Type.String(), {
		description: "Task ids that must finish first.",
	}),
	blocks: Type.Array(Type.String(), {
		description: "Task ids that cannot start until this one finishes.",
	}),
	prerequisites: Type.Array(PrerequisiteSchema, {
		description: "Conditions that must be true before the task starts.",
	}),
};

export const TaskRulesFields = {
	validationSteps: Type.Array(Type.String(), {
		description: "Ordered steps that prove the task is complete.",
	}),
	ciCommands: Type.Array(Type.String(), {
		description:
			"CI/CD commands related to this task (lint, typecheck, test, build, deploy).",
	}),
	styleguideRules: Type.Array(Type.String(), {
		description:
			"Coding style rules applicable to this task (cite source if external).",
	}),
	guardrails: Type.Array(Type.String(), {
		description:
			"Boundaries that keep the task on track (max LOC, no new deps, etc.).",
	}),
};

export const TaskJournalFields = {
	learnings: Type.Array(Type.String(), {
		description:
			"What was learned while executing this task (filled in over time).",
	}),
	gotchas: Type.Array(Type.String(), {
		description:
			"Pitfalls / things to avoid if the task is restarted or rewound.",
	}),
	context: Type.Array(ContextRefSchema, {
		description: "Files and URLs that help implement this task.",
	}),
	notes: Type.Optional(Type.String()),
};
