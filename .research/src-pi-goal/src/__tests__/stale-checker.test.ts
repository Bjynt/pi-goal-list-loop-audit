/**
 * event-adapter 并发保护辅助函数测试（TC-3）
 *
 * 直接测试 makeStaleChecker / acquireProcessing / releaseProcessing 的快照语义，
 * 非间接覆盖。重点：makeStaleChecker 在 state=null 时 snapshot=undefined，
 * 后续任何新 goal 均视为 stale。
 */
import { describe, expect, it } from "vitest";

import { acquireProcessing, makeStaleChecker, releaseProcessing } from "../adapters/event-handlers/shared";
import { createGoalState } from "../engine/goal";
import { createGoalSession } from "../session";

describe("makeStaleChecker", () => {
	it("snapshot 时 state=null → 后续新 goal 视为 stale", () => {
		const session = createGoalSession();
		// state 为 null 时 snapshot goalId = undefined
		const checkStale = makeStaleChecker(session);
		// 后续出现新 goal（goalId 有值）
		session.state = createGoalState("new goal");
		expect(checkStale()).toBe(true); // undefined !== "goal-xxx" → stale
	});

	it("snapshot 时有 goal → 同 goalId 返回 false（未 stale）", () => {
		const session = createGoalSession();
		session.state = createGoalState("current");
		const snapshotId = session.state.goalId;
		const checkStale = makeStaleChecker(session);
		// 后续 mutate 但 goalId 不变
		session.state.currentTurnIndex = 99;
		expect(checkStale()).toBe(false);
		expect(session.state.goalId).toBe(snapshotId); // 确认 goalId 未变
	});

	it("snapshot 时有 goal → goalId 变更后视为 stale（被新 goal 覆盖）", () => {
		const session = createGoalSession();
		session.state = createGoalState("old goal");
		const checkStale = makeStaleChecker(session);
		expect(checkStale()).toBe(false); // 初始未 stale
		// 模拟新 goal 覆盖（createGoalState 生成新 goalId）
		session.state = createGoalState("new goal overwrote");
		expect(checkStale()).toBe(true); // goalId 变了 → stale
	});

	it("state 被清空（null）后 → 视为 stale", () => {
		const session = createGoalSession();
		session.state = createGoalState("then cleared");
		const checkStale = makeStaleChecker(session);
		expect(checkStale()).toBe(false);
		session.state = null; // clearGoalSession 清空
		expect(checkStale()).toBe(true);
	});
});

describe("acquireProcessing / releaseProcessing", () => {
	it("首次 acquire → true 并设置 isProcessing", () => {
		const session = createGoalSession();
		expect(session.isProcessing).toBe(false);
		expect(acquireProcessing(session)).toBe(true);
		expect(session.isProcessing).toBe(true);
	});

	it("已占用时再 acquire → false（防重入）", () => {
		const session = createGoalSession();
		expect(acquireProcessing(session)).toBe(true); // 首次成功
		expect(acquireProcessing(session)).toBe(false); // 重入拒绝
		expect(acquireProcessing(session)).toBe(false); // 再入仍拒绝
	});

	it("release 后可再次 acquire", () => {
		const session = createGoalSession();
		acquireProcessing(session);
		expect(session.isProcessing).toBe(true);
		releaseProcessing(session);
		expect(session.isProcessing).toBe(false);
		expect(acquireProcessing(session)).toBe(true); // 释放后可重新获取
	});
});
