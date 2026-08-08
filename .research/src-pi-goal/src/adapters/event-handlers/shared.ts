/**
 * event-handlers 共享辅助（adapters/event-handlers 层）。
 *
 * - makeStaleChecker：FR-8.2 G-020 goalId snapshot，agent_end 入口构造、每个副作用前 checkStale
 * - acquireProcessing / releaseProcessing：FR-8.2 G-021 isProcessing 防重入的锁语义封装
 *
 * 当前 handleAgentEnd 直接操纵 session.isProcessing（历史实现），未调用 acquire/release；
 * 这两个封装保留供后续 handler 复用 + 被 stale-checker.test.ts 直接测试。
 */

import type { GoalSession } from "../../session";

/**
 * 构造 stale-check 闭包：入口快照 goalId，后续判断是否被新 goal 覆盖。
 *
 * 用法（agent_end）：
 * ```ts
 * const checkStale = makeStaleChecker(session);
 * // ... 长流程 ...
 * if (checkStale()) return; // goal 被覆盖，本次 agent_end 作废
 * ```
 *
 * 语义：snapshot 时 session.state 可能为 null（首次启动），此时 snapshotGoalId
 * 为 undefined；后续若有新 goal（goalId !== undefined）即视为 stale。
 */
export function makeStaleChecker(session: GoalSession): () => boolean {
	const snapshotGoalId = session.state?.goalId;
	return () => !session.state || session.state.goalId !== snapshotGoalId;
}

/**
 * FR-8.2 G-021：isProcessing 防重入。
 *
 * agent_end 可能并发触发（多 message），重入时直接返回（不重复预算检查/续跑）。
 * 通过 session.isProcessing flag 实现（定义在 session.ts）。
 * 本函数为 agent_end 提供「锁住 + 解锁」语义。
 */
export function acquireProcessing(session: GoalSession): boolean {
	if (session.isProcessing) return false; // 已被占用
	session.isProcessing = true;
	return true;
}

export function releaseProcessing(session: GoalSession): void {
	session.isProcessing = false;
}
