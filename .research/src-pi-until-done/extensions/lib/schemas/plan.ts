import { Type } from "typebox";
import { TaskSchema } from "./task";

export const PlanParams = Type.Object({
	tasks: Type.Array(TaskSchema, {
		description:
			"Complete TDD-first task list. Tasks must be ordered such that dependencies appear before dependents.",
	}),
});

export const TaskOpSchema = Type.Union([
	Type.Object({
		op: Type.Literal("insert"),
		task: TaskSchema,
		insertAfter: Type.Optional(Type.String()),
	}),
	Type.Object({ op: Type.Literal("remove"), taskId: Type.String() }),
	Type.Object({
		op: Type.Literal("replace"),
		taskId: Type.String(),
		task: TaskSchema,
	}),
	Type.Object({
		op: Type.Literal("split"),
		taskId: Type.String(),
		into: Type.Array(TaskSchema),
	}),
	Type.Object({
		op: Type.Literal("merge"),
		taskIds: Type.Array(Type.String()),
		into: TaskSchema,
	}),
	Type.Object({
		op: Type.Literal("reorder"),
		taskId: Type.String(),
		dependencies: Type.Array(Type.String()),
	}),
]);

export const ReplanParams = Type.Object({
	operations: Type.Array(TaskOpSchema, {
		description:
			"Ordered list of operations to apply atomically. Validated as a batch; partial application is impossible.",
	}),
	reason: Type.String({
		description:
			"Non-empty reason. Appended to affected tasks' learnings as 'replan: <reason>'. Examples: 'discovered upstream bug requires its own RED', 'merging T-007 and T-008 — same scope', 'removing T-012 — covered by T-009 refactor'.",
	}),
});
