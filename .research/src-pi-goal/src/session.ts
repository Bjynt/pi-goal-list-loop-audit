/**
 * Session 层 — 运行时句柄 + 状态重建 + entry GC
 *
 * GoalSession 是进程内瞬态句柄（不持久化）。
 * reconstructGoalState 从 entry 恢复状态（session_start 时调）。
 *
 * FR-6.4: 删除 hasPendingInjection（僵尸字段）
 * FR-6.7: 删除 pendingPause（ESC 改用 aborted 守卫）
 * FR-8.1 G-006: session append-only——entry GC 不生效（生产），history 显示侧截断
 * FR-3: 崩溃后保持原状态（active 重启计时；paused/blocked 保持；终态保持）
 */

import type { GoalRuntimeState } from "./engine/types";
import { deserializeState, ENTRY_TYPE } from "./persistence";
import type { SessionEntryLike, SessionPort, UiPort } from "./ports";

// ── 运行时句柄 ────────────────────────────────────────

export interface GoalSession {
	state: GoalRuntimeState | null;
	/** 防重入标志：agent_end / before_agent_start 等事件处理器入口检查 */
	isProcessing: boolean;
}

export function createGoalSession(): GoalSession {
	return {
		state: null,
		isProcessing: false,
	};
}

// ── Stale Context 检测（FR-8.2 G-010）─────────────────

export const STALE_CONTEXT_PATTERNS = [
	"aborted",
	"context canceled",
	"stale context",
	"stalecontext",
	"extension context no longer active",
] as const;

export function isStaleContextError(error: Error | unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	const lower = msg.toLowerCase();
	return STALE_CONTEXT_PATTERNS.some((p) => lower.includes(p));
}

// ── reconstructGoalState（session_start 时调）──────────

/**
 * 从 session entries 恢复 goal state。
 *
 * Pi SDK 的 session 是 append-only，getEntries() 返回 filter-copy——splice
 * 无法修改真实 entries。Entry GC（goal-state 留 1、goal-history 留 20）在生产
 * 不生效：本函数只读最新一条 goal-state，不删旧 entry；history 显示侧用
 * .slice(-MAX_HISTORY_ENTRIES) 截断（handleHistory）。长期需 compaction API。
 * FR-3: 崩溃后状态保持原状——active 重启计时（timeStartedAt = now），
 *   paused/blocked 保持（用户/agent 主动叫停不被抹除），终态保持。
 * FR-8.1 G-024: deserialize throw → state=null（部分损坏全丢）
 */
export function reconstructGoalState(session: GoalSession, sessionPort: SessionPort): void {
	session.state = null;
	const entries = sessionPort.getEntries();

	// 找到最新的 goal-state entry（从后往前）
	let latestStateIdx = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isGoalStateEntry(entries[i]!)) {
			latestStateIdx = i;
			break;
		}
	}

	if (latestStateIdx >= 0) {
		const data = entries[latestStateIdx]!.data as Record<string, unknown> | undefined;
		if (data) {
			try {
				session.state = deserializeState(data);
			} catch {
				// FR-8.1 G-024: 部分损坏全丢
				session.state = null;
			}
		}
	}

	// FR-8.1 G-006: session append-only，splice GC 在生产不生效（见上方函数注释）。
	// 不在此处删旧 entry；history 显示侧截断。

	if (!session.state) return;

	// FR-3: 崩溃后状态保持。
	// - active：重启计时（timeStartedAt = now，开启新运行段）
	// - paused/blocked：保持原状（对称设计——用户/agent 主动叫停的状态不被崩溃抹除）
	// - 终态：保持终态（不会被强制激活）
	if (session.state.status === "active") {
		session.state.timeStartedAt = Date.now();
	}
}

function isGoalStateEntry(entry: SessionEntryLike): boolean {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

// ── clearGoalSession ──────────────────────────────────

export function clearGoalSession(session: GoalSession, uiPort: UiPort): void {
	session.state = null;
	session.isProcessing = false;
	// FR-6.6: hasUI 守卫
	if (uiPort.hasUI) {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
	}
}
