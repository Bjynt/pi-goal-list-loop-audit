import type { Task } from "./types";

interface DfsState {
	byId: Map<string, Task>;
	visiting: Set<string>;
	visited: Set<string>;
}

const visitDeps = (deps: string[], st: DfsState): string | undefined => {
	for (const dep of deps) {
		const cyc = dfs(dep, st);
		if (cyc) return cyc;
	}
	return undefined;
};

const dfs = (id: string, st: DfsState): string | undefined => {
	if (st.visited.has(id)) return undefined;
	if (st.visiting.has(id)) return id;
	st.visiting.add(id);
	const t = st.byId.get(id);
	const cyc = t ? visitDeps(t.dependencies, st) : undefined;
	st.visiting.delete(id);
	st.visited.add(id);
	return cyc;
};

export const detectCycle = (tasks: Task[]): string | undefined => {
	const st: DfsState = {
		byId: new Map(tasks.map((t) => [t.id, t])),
		visiting: new Set(),
		visited: new Set(),
	};
	for (const t of tasks) {
		const cyc = dfs(t.id, st);
		if (cyc) return cyc;
	}
	return undefined;
};
