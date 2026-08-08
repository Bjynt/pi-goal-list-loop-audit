import type { Task } from "../types";

export interface OpsCtx {
	tasks: Task[];
	reason: string;
}

export const findTask = (tasks: Task[], id: string): Task | undefined =>
	tasks.find((t) => t.id === id);

export const requireMutable = (
	tasks: Task[],
	id: string,
): string | undefined => {
	const t = findTask(tasks, id);
	if (!t) return `unknown taskId ${id}`;
	if (t.status === "done") return `cannot modify done task ${id}`;
	return undefined;
};

export const insertOp = (
	c: OpsCtx,
	task: Task,
	insertAfter: string | undefined,
): string | undefined => {
	if (findTask(c.tasks, task.id)) return `duplicate id ${task.id}`;
	if (!insertAfter) {
		c.tasks.push(task);
		return undefined;
	}
	const anchor = findTask(c.tasks, insertAfter);
	if (!anchor) return `unknown insertAfter ${insertAfter}`;
	c.tasks.splice(c.tasks.indexOf(anchor) + 1, 0, task);
	return undefined;
};

export const removeOp = (c: OpsCtx, taskId: string): string | undefined => {
	const e = requireMutable(c.tasks, taskId);
	if (e) return e;
	c.tasks = c.tasks.filter((t) => t.id !== taskId);
	c.tasks = c.tasks.map((t) => ({
		...t,
		dependencies: t.dependencies.filter((d) => d !== taskId),
		blocks: t.blocks.filter((b) => b !== taskId),
	}));
	return undefined;
};

export const replaceOp = (
	c: OpsCtx,
	taskId: string,
	task: Task,
): string | undefined => {
	const e = requireMutable(c.tasks, taskId);
	if (e) return e;
	if (taskId !== task.id) return `replace id mismatch ${taskId} vs ${task.id}`;
	const idx = c.tasks.findIndex((t) => t.id === taskId);
	const prev = findTask(c.tasks, taskId);
	c.tasks[idx] = {
		...task,
		learnings: [
			...(prev?.learnings ?? []),
			...task.learnings,
			`replan: ${c.reason}`,
		],
	};
	return undefined;
};

export const splitOp = (
	c: OpsCtx,
	taskId: string,
	into: Task[],
): string | undefined => {
	const e = requireMutable(c.tasks, taskId);
	if (e) return e;
	if (into.length < 2) return "split must produce ≥2 tasks";
	const idx = c.tasks.findIndex((t) => t.id === taskId);
	c.tasks.splice(idx, 1, ...into);
	return undefined;
};

export const mergeOp = (
	c: OpsCtx,
	taskIds: string[],
	into: Task,
): string | undefined => {
	for (const id of taskIds) {
		const e = requireMutable(c.tasks, id);
		if (e) return e;
	}
	if (findTask(c.tasks, into.id) && !taskIds.includes(into.id)) {
		return `merge target id ${into.id} collides with existing task`;
	}
	const firstIdx = c.tasks.findIndex((t) => taskIds.includes(t.id));
	c.tasks = c.tasks.filter((t) => !taskIds.includes(t.id));
	c.tasks.splice(firstIdx, 0, into);
	return undefined;
};

export const reorderOp = (
	c: OpsCtx,
	taskId: string,
	dependencies: string[],
): string | undefined => {
	const e = requireMutable(c.tasks, taskId);
	if (e) return e;
	const target = findTask(c.tasks, taskId);
	if (target) target.dependencies = dependencies;
	return undefined;
};
