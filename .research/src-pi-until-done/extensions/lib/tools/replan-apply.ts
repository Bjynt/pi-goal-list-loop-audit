import type { Static } from "typebox";
import type { TaskOpSchema } from "../schemas/plan";
import type { Task } from "../types";
import {
	insertOp,
	mergeOp,
	type OpsCtx,
	removeOp,
	reorderOp,
	replaceOp,
	splitOp,
} from "./replan-ops";

type Op = Static<typeof TaskOpSchema>;

export const applyOp = (c: OpsCtx, op: Op): string | undefined => {
	if (op.op === "insert") return insertOp(c, op.task, op.insertAfter);
	if (op.op === "remove") return removeOp(c, op.taskId);
	if (op.op === "replace") return replaceOp(c, op.taskId, op.task);
	if (op.op === "split") return splitOp(c, op.taskId, op.into);
	if (op.op === "merge") return mergeOp(c, op.taskIds, op.into);
	if (op.op === "reorder") return reorderOp(c, op.taskId, op.dependencies);
	return "unknown op";
};

export const applyAll = (c: OpsCtx, ops: Op[]): string | undefined => {
	for (const op of ops) {
		const err = applyOp(c, op);
		if (err) return err;
	}
	return undefined;
};

export const tagAffected = (
	prev: Task[],
	next: Task[],
	reason: string,
): Task[] =>
	next.map((t) => {
		const wasUnchangedAndExisting = prev.some(
			(o) => o.id === t.id && o.status === "done",
		);
		if (wasUnchangedAndExisting) return t;
		if (t.learnings.some((l) => l.startsWith("replan:"))) return t;
		return { ...t, learnings: [...t.learnings, `replan: ${reason}`] };
	});
