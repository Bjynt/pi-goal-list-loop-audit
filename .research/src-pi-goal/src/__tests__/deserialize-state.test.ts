/**
 * FR-5/FR-7.3: deserializeState — 新格式严格解析（字段缺失 throw）
 *
 * #1 向后兼容：旧 entry 可能含 `tasks` 字段（task CRUD 删除前的格式），
 * 反序列化时忽略该字段不 throw。
 */
import { describe, expect, it } from "vitest";

import { deserializeState } from "../persistence";

const FULL_DATA = {
	goalId: "g1",
	objective: "test",
	status: "active",
	// tasks 字段保留以模拟旧 entry（#1 后被忽略，不 throw）
	tasks: [{
		id: 1,
		description: "task 1",
		status: "completed",
		lastUpdatedTurn: 5,
		verification: { method: "pnpm test", expected: "all pass", actual: "passed" },
	}],
	tokensUsed: 0,
	timeStartedAt: 1000,
	timeUsedSeconds: 0,
	budget: {},
	lastProgressTurn: 0,
	budgetLimitSteeringSent: false,
	objectiveUpdatedAt: 1000,
	lastBlockerReason: null,
	tokenWarning70Sent: false,
	tokenWarning90Sent: false,
	timeWarning70Sent: false,
	timeWarning90Sent: false,
	lastTurnTokensUsed: 0,
	currentTurnIndex: 0,
};

describe("deserializeState — 新格式严格解析", () => {
	it("完整数据（含旧 tasks 字段）→ 正确还原，tasks 被忽略", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.tokenWarning70Sent).toBe(false);
		expect(state.objective).toBe("test");
		// tasks 字段不还原到 state（GoalRuntimeState 已无 tasks 字段）
		expect((state as unknown as { tasks?: unknown }).tasks).toBeUndefined();
	});

	it("顶层缺 budget → throw（不再兜底默认值）", () => {
		const data = { goalId: "g1", objective: "test", status: "active" };
		expect(() => deserializeState(data)).toThrow();
	});

	it("缺 tokenWarning70Sent → throw（新格式必须包含 4 个独立 flag）", () => {
		const data = { ...FULL_DATA };
		delete (data as Record<string, unknown>).tokenWarning70Sent;
		expect(() => deserializeState(data)).toThrow();
	});

	it("completedAtTurnIndex 可选（缺失 → undefined）", () => {
		const state = deserializeState(FULL_DATA);
		expect(state.completedAtTurnIndex).toBeUndefined();
	});

	it("有 completedAtTurnIndex → 正确还原", () => {
		const data = { ...FULL_DATA, completedAtTurnIndex: 42 };
		expect(deserializeState(data).completedAtTurnIndex).toBe(42);
	});

	// GAP-4: slug 向后兼容——旧持久化数据无 slug 字段，deserialize 不能 throw
	// （误用 req() 会导致旧数据整个 state 丢失，G-024 部分损坏全丢）
	it("缺 slug → 不 throw，slug 为 undefined（GAP-4 旧数据兼容）", () => {
		const state = deserializeState(FULL_DATA); // FULL_DATA 无 slug
		expect(state.slug).toBeUndefined();
	});

	it("有 slug → 正确还原", () => {
		const data = { ...FULL_DATA, slug: "refactor-auth" };
		expect(deserializeState(data).slug).toBe("refactor-auth");
	});

	// successCriteria 向后兼容——与 slug 同模式（GAP-4），旧持久化数据无此字段不 throw
	it("缺 successCriteria → 不 throw，值为 undefined", () => {
		const state = deserializeState(FULL_DATA); // FULL_DATA 无 successCriteria
		expect(state.successCriteria).toBeUndefined();
	});

	it("有 successCriteria → 正确还原", () => {
		const data = { ...FULL_DATA, successCriteria: "pnpm test green; tsc clean" };
		expect(deserializeState(data).successCriteria).toBe("pnpm test green; tsc clean");
	});
});
