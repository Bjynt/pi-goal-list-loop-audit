/**
 * Ports — 能力抽象接口
 *
 * D-22: ports 的核心价值是机器可检查的边界（engine/ 禁止 import Pi），
 * 不是"可替换的 adapter"。service 层通过这些接口访问 Pi 能力，
 * adapter 层提供实现（包装 ctx / pi）。
 */

import type { GoalRuntimeState } from "./engine/types";

// ── GoalHistoryEntry（DTO，非 aggregate，D-09）─────────

export interface GoalHistoryEntry {
	goalId: string;
	objective: string;
	/** 成功标准（与 objective 成对存档）。旧 entry 无此字段，向后兼容。 */
	successCriteria?: string;
	/** widget/history 标题用（fallback objective 截断）。旧 entry 无此字段。 */
	slug?: string;
	status: string;
	completedTasks: number;
	totalTasks: number;
	elapsedSeconds: number;
	timestamp: number;
}

// ── PersistencePort ──────────────────────────────────

export interface PersistencePort {
	/** 写入 goal-state entry（最新 1 条，GC 由 session 层管） */
	appendState(state: GoalRuntimeState): void;
	/** 写入 goal-history 归档 entry */
	appendHistory(entry: GoalHistoryEntry): void;
}

// ── UiPort ───────────────────────────────────────────

export interface UiPort {
	/** 设置 widget（undefined = 清除）。hasUI=false 时 adapter 跳过（FR-6.6） */
	setWidget(name: string, content: string[] | string | undefined): void;
	/** 设置 status bar */
	setStatus(name: string, text: string | undefined): void;
	/** 弹通知 */
	notify(text: string, level: "info" | "warning" | "error"): void;
	/** 是否有 UI（headless/RPC mode 为 false） */
	readonly hasUI: boolean;
}

// ── MessagingPort ────────────────────────────────────

export interface MessagingPort {
	/** 发送 custom message（goal-context 等） */
	sendContextMessage(content: string, deliverAs: "steer" | "followUp", customType?: string): void;
	/** 发送 user message（触发 AI 开始工作，FR-8.12） */
	sendUserMessage(content: string, deliverAs: "steer" | "followUp"): void;
}

// ── SessionPort ──────────────────────────────────────

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface SessionPort {
	getEntries(): SessionEntryLike[];
	// tokens 与 Pi SDK 的 ContextUsage.tokens 对齐：number | null（null = 未知，如压缩后未到下次 LLM 响应）。
	getContextUsage(): { tokens: number | null; contextWindow: number } | null;
	readonly signal: AbortSignal | undefined;
}
