/**
 * Service 协调层 — 命令/事件入口（applyEvent）
 *
 * D-21: 不合并为单一 applyCommand。命令/事件路径在触发方/返回值/并发模型上全不同。
 * engine 层纯函数是真正共享层。
 *
 * D-16: service 不持有 ctx，通过 ports 参数接收能力。
 *
 * FR-3.1: createGoal 唯一创建入口（/goal set 与 __goalInit 都走它）
 * FR-3.3: finalizeAndPersist 唯一终态序列入口（tick → finalizeGoal → persist）
 *         finalizeGoal 只做 transitionStatus + writeHistory（纯）
 * FR-6.5: persist 前调 tick 累计时间
 */

import {
	accumulateTokens,
	checkBudgetOnResume,
	checkBudgetOnTurnEnd,
	tick,
} from "./engine/budget";
import { createGoalState, isActiveStatus, transitionStatus } from "./engine/goal";
import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "./engine/types";
import { makeHistoryEntry, serializeState } from "./persistence";
import type {
	GoalHistoryEntry,
	MessagingPort,
	PersistencePort,
	SessionPort,
	UiPort,
} from "./ports";
import { updateWidget } from "./projection/widget";
import type { GoalSession } from "./session";

// ── Ports 组合 ────────────────────────────────────────

export interface ServicePorts {
	persistence: PersistencePort;
	ui: UiPort;
	messaging: MessagingPort;
	session: SessionPort;
}

// ── Event 效果 ────────────────────────────────────────

export type EventEffect =
	| { kind: "sendContextMessage"; content: string; deliverAs: "steer" | "followUp"; customType?: string }
	| { kind: "sendUserMessage"; content: string; deliverAs: "steer" | "followUp" }
	| { kind: "notify"; text: string; level: "info" | "warning" | "error" }
	| { kind: "clearSession" }
	| { kind: "updateWidget" };

// ── 持久化辅助 ────────────────────────────────────────

/**
 * FR-6.5 tick 核心：按当前 status 累加运行时间（active 才累加），mutate state。
 *
 * 用于 active→非活跃转换前捕获最后一段运行时间——调用方在 `transitionStatus`
 * **之前**调本函数，使 tick 看到 active 状态并累加当前运行段。
 *
 * 导出供 `persistState`（service/command/tool 路径）、`persistAndUpdate`（event 路径）、
 * 以及各 transition 调用点共用——**单一 tick 定义点**（BL-3 DRY）。
 */
export function tickState(state: GoalRuntimeState): void {
	const isRunning = isActiveStatus(state.status);
	const ticked = tick(state.timeStartedAt, state.timeUsedSeconds, Date.now(), isRunning);
	state.timeUsedSeconds = ticked.timeUsedSeconds;
	state.timeStartedAt = ticked.timeStartedAt;
}

/**
 * FR-6.5: persist 前调 tick 累加时间，然后 serialize + appendState。
 *
 * tick 使用**当前 status** 判断是否累加（active 才累加）。因此对于 clear/abort/blocked
 * 这类「active → 非活跃」的转换，调用方必须在改 status **之前**先调本函数
 * （或先调 {@link tickState} 捕获最后运行段）。
 *
 * 导出供 command-adapter / event-adapter 复用（DRY：所有路径共用同一持久化语义）。
 */
export function persistState(session: GoalSession, ports: ServicePorts): void {
	if (!session.state) return;
	tickState(session.state);
	ports.persistence.appendState(serializeState(session.state));
}

/**
 * 事件路径 persist + updateWidget（FR-6.5 tick + appendState + updateWidget）。
 *
 * 与 {@link persistState}（command/tool 路径）的差异：事件路径多 updateWidget + 可选 checkStale
 * + **budget 终态检查（#5 单一检查点）**。两者都调 {@link tickState}（单一 tick 定义点，BL-3 DRY）。
 *
 * NFR F2：budget 终态检查在此函数内（事件路径单一检查点，对齐 Codex SQL CASE）。
 * 不在 {@link persistState}（command/tool 路径）—— 否则 token 累加后检查永不触发。
 * 仅 active 状态检查（paused/blocked/终态不重复触发；终态 goal 进不了此函数，event handler 入口已过滤）。
 *
 * @returns true 表示 state 已被新 goal 覆盖（checkStale 触发），调用方应中止后续副作用
 */
export function persistAndUpdate(
	session: GoalSession,
	ports: ServicePorts,
	checkStale?: (() => boolean) | undefined,
): boolean {
	if (!session.state) return false;
	tickState(session.state);

	// #5: budget 终态检查（事件路径单一检查点，NFR F2）。仅在 active 时检查，
	// 避免对 paused/blocked/终态重复触发。checkBudgetOnTurnEnd 是 engine 纯函数，
	// service 复用它不破坏纯 ports 设计（engine 是零 Pi 依赖纯函数层）。
	if (session.state.status === "active") {
		const budgetResult = checkBudgetOnTurnEnd(session.state, session.state.timeUsedSeconds);
		if (budgetResult.terminal) {
			const dim = budgetResult.terminal.dimension;
			// FR-3.3: 唯一终态序列入口（finalizeAndPersist 内部 tickState 是 no-op——
			// 上面已 tick，且状态此时仍 active——+ finalizeGoal + appendState）。
			// terminal 分支不再单独 appendState：finalizeAndPersist 已含终态 state 持久化。
			finalizeAndPersist(
				session.state,
				dim === "token" ? "budget_limited" : "time_limited",
				0,
				ports,
			);
			if (checkStale?.()) return true;
			updateWidget(session, ports.ui);
			return false; // 终态已处理
		}
	}

	// 非终态路径：正常 persist + updateWidget
	ports.persistence.appendState(serializeState(session.state));
	if (checkStale?.()) return true;
	updateWidget(session, ports.ui);
	return false;
}

// ── FR-3.1 唯一创建入口 ──────────────────────────────

/**
 * 唯一创建入口。两个调用源都走它：
 * - goal_control create（toolcall，AI 提供 slug + objective + successCriteria）
 * - __goalInit（index.ts，isExternalInit=true）
 *
 * 注：/goal <objective> 命令路径已改为提示词触发器——不直接调本函数，
 * 而是 sendUserMessage 让 AI 调 goal_control create（slug + successCriteria 由 AI 生成）。
 *
 * isExternalInit=true 时不触发 sendUserMessage（__goalInit 不触发 AI）。
 *
 * @param slug AI 生成的短标识（optional，仅 widget 标题 + history 用）
 * @param successCriteria 成功标准（optional，由 AI 推导或外部传入；注入 prompt 指导完成验证）
 * @returns true 如果创建成功，false 如果已有 active goal（拒绝创建）
 */
export function createGoal(
	session: GoalSession,
	objective: string,
	budget: Partial<BudgetConfig>,
	ports: ServicePorts,
	isExternalInit: boolean,
	slug?: string,
	successCriteria?: string,
): boolean {
	// 已有 active goal → 拒绝
	if (session.state && isActiveStatus(session.state.status)) {
		return false;
	}

	void isExternalInit; // 保留参数位以备 future use（外部 init 的差异化行为）
	session.state = createGoalState(objective, budget, slug, successCriteria);

	persistState(session, ports);
	return true;
}

// ── FR-3.3 唯一终态序列入口 ──────────────────────────

/**
 * 唯一终态序列入口（FR-3.3 / AC-3）。
 *
 * 收口所有 active→terminal 转换的完整副作用序列，消除此前散在 service /
 * command-adapter / event-adapter 的重复 `transitionStatus + completedAtTurnIndex +
 * writeHistory + appendState` 序列。
 *
 * 序列（严格顺序）：
 * 1. tickState(state)（FR-6.5：转 terminal 前累加当前运行段——此时 status 仍为 active）
 * 2. finalizeGoal(state, terminalStatus, ports, { completedTasks })
 *    — transitionStatus(终态守卫) + completedAtTurnIndex= + appendHistory（FR-8.7 矩阵）
 * 3. ports.persistence.appendState(serializeState(state))（持久化终态 state）
 *
 * @param state runtime state（mutate）
 * @param terminalStatus 目标终态（complete / cancelled / budget_limited / time_limited）
 * @param completedTasks 已完成任务数（写入 history entry）
 * @param ports ServicePorts（persistence.appendHistory + appendState）
 */
export function finalizeAndPersist(
	state: GoalRuntimeState,
	terminalStatus: GoalStatus,
	completedTasks: number,
	ports: ServicePorts,
): void {
	tickState(state);
	finalizeGoal(state, terminalStatus, ports, { completedTasks });
	ports.persistence.appendState(serializeState(state));
}

/**
 * 终态变更 + 写 history（纯状态变更，不含 tick / persist / clearSession）。
 *
 * 被 {@link finalizeAndPersist} 内部调用，也可单独调用（如仅需状态变更 + history）。
 * 按 FR-8.7 矩阵：所有终态都写 history（blocked 是中间态，不走此入口）。
 */
export function finalizeGoal(
	state: GoalRuntimeState,
	terminalStatus: GoalStatus,
	ports: ServicePorts,
	options: { completedTasks: number },
): void {
	state.status = transitionStatus(state.status, terminalStatus);
	state.completedAtTurnIndex = state.currentTurnIndex;

	// FR-8.7: 所有终态都写 history（blocked 是中间态，不走此入口）
	const entry: GoalHistoryEntry = makeHistoryEntry(state, options.completedTasks);
	ports.persistence.appendHistory(entry);
}

// ── 路径 B：applyEvent ────────────────────────────────

/** message_end 事件数据形状（运行时解析后的可信形状） */
interface MessageEndEventData {
	message?: {
		role?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
	};
}

/**
 * message_end 事件数据运行时解析（unknown → 可信形状）。
 * 替代全可选结构断言（taste/no-unsafe-cast）：逐字段校验类型后构造，非法输入返回 null。
 */
function toMessageEndData(eventData: unknown): MessageEndEventData | null {
	if (typeof eventData !== "object" || eventData === null) return null;
	const message = (eventData as Record<string, unknown>).message;
	if (typeof message !== "object" || message === null) return null;
	const raw = message as Record<string, unknown>;
	const rawUsage = raw.usage;
	let usage: NonNullable<MessageEndEventData["message"]>["usage"];
	if (typeof rawUsage === "object" && rawUsage !== null) {
		const u = rawUsage as Record<string, unknown>;
		usage = {
			input: typeof u.input === "number" ? u.input : undefined,
			output: typeof u.output === "number" ? u.output : undefined,
			cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : undefined,
			totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
		};
	}
	return {
		message: {
			role: typeof raw.role === "string" ? raw.role : undefined,
			usage,
		},
	};
}

/**
 * 路径 B 入口。异步事件，返回 EventEffect[]。
 * 并发保护（isProcessing / stale-check）在 event-adapter，不在此层。
 *
 * 本函数作为简单事件的统一入口（message_end / turn_end / agent_start）。
 * 复杂事件（before_agent_start / agent_end / session_start）由 event-adapter
 * 直接实现，调 engine 纯函数 + service 辅助函数。
 */
export function applyEvent(
	session: GoalSession,
	eventType: string,
	eventData: unknown,
	// TS-2: 参数未使用，放宽为 undefined 以消除调用方 `undefined as never` 断言。
	// 保留参数位以备未来 event 类型需要 ports（applyEvent 是统一事件入口）。
	_ports?: ServicePorts,
): EventEffect[] {
	const effects: EventEffect[] = [];
	if (!session.state) return effects;

	switch (eventType) {
		case "message_end": {
			// token 累加（FR-8.6 G-R2-001）—— 仅 active 时累加（回归修复：原缺 isActiveStatus 守卫，
			// blocked 等 non-active 状态会错误累加 token）。复用 engine 纯函数。
			if (!isActiveStatus(session.state.status)) break;
			// 运行时守卫解析事件数据（未知形状 → 可选字段），替代全可选结构断言
			const data = toMessageEndData(eventData);
			if (data?.message?.role !== "assistant") break;
			const usage = data.message.usage;
			if (!usage) break;
			session.state.tokensUsed = accumulateTokens(session.state.tokensUsed, usage);
			break;
		}
		case "turn_end":
			session.state.currentTurnIndex++;
			effects.push({ kind: "updateWidget" });
			break;
		case "agent_start":
			// task 已移除，agent_start 暂无副作用（#7 注入 todo 进度后可能重填）
			break;
	}

	return effects;
}

// ── resume 预算重检（供 command-adapter 调用）─────────

export function checkResumeBudget(
	state: GoalRuntimeState,
): { type: "exceeded"; dimension: "token" | "time" } | null {
	return checkBudgetOnResume(state);
}
