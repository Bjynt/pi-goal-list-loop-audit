/**
 * /goal 命令适配器 — 子命令 handler（adapters 层）
 *
 * 子命令：set / status / pause / resume / clear / update / history
 * （/goal abort 随 task CRUD 一并废弃）。
 *
 * FR-3: pause（active→paused）与 resume（paused/blocked→active）对称设计——
 *   两者都是非终态「停止」状态，用户控制续跑节奏。
 *
 * 状态变更调 service（createGoal / finalizeAndPersist）；
 * ports 桥接复用 adapters/ports.buildPorts（DRY：单一 ports 构造点）；
 * FR-8.12: set/resume 后 sendUserMessage 触发 AI。
 *
 * adapters 层可 import Pi 类型（桥接 Pi 和 service）。
 */

import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseGoalArgs } from "../commands";
import {
	MAX_HISTORY_ENTRIES,
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	SECONDS_PER_MINUTE,
} from "../constants";
import { checkBudgetOnResume } from "../engine/budget";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import type { BudgetConfig } from "../engine/types";
import { objectiveUpdatedPrompt } from "../projection/prompts";
import { updateWidget } from "../projection/widget";
import { finalizeAndPersist, persistState, tickState } from "../service";
import type { GoalSession } from "../session";
import { clearGoalSession } from "../session";
import { buildPorts } from "./ports";

// ── Orchestrator ──────────────────────────────────────

/**
 * /goal 命令分发器。按 parseGoalArgs 结果路由到子命令 handler。
 *
 * 调用方（index.ts 的 command handler）把原始 args 透传到这里。
 */
export async function handleGoalCommand(
	pi: ExtensionAPI,
	session: GoalSession,
	args: string | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const parsed = parseGoalArgs(args ?? "");
	switch (parsed.action) {
		case "status":
			return handleStatus(session, ctx);
		case "pause":
			return handlePause(pi, session, ctx);
		case "resume":
			return handleResume(pi, session, ctx);
		case "history":
			return handleHistory(ctx);
		case "clear":
			return handleClear(pi, session, ctx);
		case "update":
			return handleUpdate(pi, session, parsed.objective, parsed.criteria, ctx);
		case "set":
			return handleSet(pi, session, parsed.objective ?? "", parsed.budget, ctx);
	}
}

// ── /goal status ──────────────────────────────────────

function handleStatus(session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active. Use /goal <objective> to start.", "info");
		return;
	}
	const state = session.state;
	// 回归修复：active goal 显示实时耗时（tick 累加当前运行段后再读）
	if (isActiveStatus(state.status)) {
		tickState(state);
	}
	const timeMins = Math.floor(state.timeUsedSeconds / SECONDS_PER_MINUTE);
	const timeSecs = Math.floor(state.timeUsedSeconds % SECONDS_PER_MINUTE);
	const lines: Array<string | null> = [
		state.slug ? `Slug: ${state.slug}` : null,
		`Objective: ${state.objective}`,
		state.successCriteria ? `Success criteria: ${state.successCriteria}` : null,
		`Status: ${state.status}`,
		`Turn: ${state.currentTurnIndex}`,
		`Time elapsed: ${timeMins}m${timeSecs}s`,
		state.budget.tokenBudget ? `Token: ${state.tokensUsed}/${state.budget.tokenBudget}` : null,
		`Goal ID: ${state.goalId}`,
	];
	ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
}

// ── /goal pause（FR-3 用户暂停）──────────────────────

/**
 * FR-3: active → paused（用户叫停续跑）。
 *
 * 对称设计（与 blocked 行为对称）：两者都是非终态「停止」状态，区别只在触发主体
 * （paused = 用户，blocked = agent）。都不续跑、不 budget 检查、不注入 context。
 *
 * 先 tickState 捕获最后运行段（status 仍 active 才累加），再 transitionStatus。
 * 复用 handleReportBlocked 的 tick-before-transition 模式（见 goal-control-adapter.ts）。
 */
function handlePause(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "warning");
		return;
	}
	const state = session.state;
	if (!isActiveStatus(state.status)) {
		ctx.ui.notify(
			`Goal is not active (status: ${state.status}). Only an active goal can be paused.`,
			"warning",
		);
		return;
	}
	// 先 tickState 累加当前运行段（此时 status 仍为 active）
	tickState(state);
	state.status = transitionStatus(state.status, "paused");

	const ports = buildPorts(pi, ctx);
	persistState(session, ports);
	updateWidget(session, ports.ui);
	ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
}

// ── /goal resume ──────────────────────────────────────

function handleResume(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "warning");
		return;
	}
	const state = session.state;
	if (isTerminalStatus(state.status)) {
		ctx.ui.notify(`Goal is in terminal state (${state.status}), cannot resume.`, "warning");
		return;
	}
	// FR-3: resume 支持 paused→active 和 blocked→active（两者对称，都做 budget 重检 + 触发 AI）
	if (state.status !== "paused" && state.status !== "blocked") {
		ctx.ui.notify("Goal is not paused or blocked, no need to resume.", "info");
		return;
	}
	state.status = "active";
	state.timeStartedAt = Date.now();

	const ports = buildPorts(pi, ctx);

	// FR-8.3 G-014: resume 时 budget 重检
	const resumeCheck = checkBudgetOnResume(state);
	if (resumeCheck) {
		const dim = resumeCheck.dimension;
		// FR-8.7: 走 finalizeAndPersist 写 history（含 tick + transition + history + appendState），
		// 勿用 transitionStatus + persistState（不写 history，goal 会从 /goal history 凭空消失）
		finalizeAndPersist(state, dim === "token" ? "budget_limited" : "time_limited", 0, ports);
		updateWidget(session, ports.ui);
		ctx.ui.notify(
			`${dim === "token" ? "Token" : "Time"} budget exhausted, cannot resume. Use /goal clear to reset.`,
			"warning",
		);
		return;
	}
	persistState(session, ports);
	updateWidget(session, ports.ui);

	// FR-8.12 并行模式：resume 后触发 AI 继续
	const blockerNote = state.lastBlockerReason
		? `\n\nPrevious blocker: ${state.lastBlockerReason}. Try a different approach.`
		: "";
	pi.sendUserMessage(
		`Goal resumed. Continuing toward the objective.${blockerNote}\n\nObjective: ${state.objective}`,
		{ deliverAs: "followUp" },
	);
}

// ── /goal history ─────────────────────────────────────

interface GoalHistoryData {
	goalId: string;
	objective: string;
	/** widget/history 标题用（fallback objective 截断）。旧 entry 无此字段。 */
	slug?: string;
	status: string;
	completedTasks: number;
	totalTasks: number;
	elapsedSeconds: number;
	timestamp: number;
}

function handleHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const historyEntries = entries.filter(
		(e): e is CustomEntry<GoalHistoryData> =>
			e.type === "custom" && (e as CustomEntry).customType === "goal-history",
	);

	if (historyEntries.length === 0) {
		ctx.ui.notify("No goal history", "info");
		return;
	}
	// FR-8.1 G-006: session append-only（Pi getEntries 返回 filter-copy，无法 splice 旧 entry）。
	// 显示侧截断为最近 MAX_HISTORY_ENTRIES 条，避免历史无界增长刷屏。
	const recent = historyEntries.slice(-MAX_HISTORY_ENTRIES);
	const sorted = [...recent].reverse();
	const lines: string[] = ["Goal history:\n"];
	sorted.forEach((entry, i) => {
		const h = entry.data;
		if (!h) return;
		const icon =
			h.status === "complete"
				? "✓"
				: h.status === "cancelled"
					? "✗"
					: h.status === "budget_limited"
						? "⊗"
						: h.status === "time_limited"
							? "⏱"
							: "?";
		// GAP-5: 标题优先用 slug（紧凑），无 slug fallback objective 截断（旧 entry 兼容）
		const title = h.slug ?? (h.objective.length > OBJECTIVE_DISPLAY_LIMIT
			? `${h.objective.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
			: h.objective);
		const mins = Math.floor(h.elapsedSeconds / SECONDS_PER_MINUTE);
		const secs = Math.floor(h.elapsedSeconds % SECONDS_PER_MINUTE);
		lines.push(`${i + 1}. ${icon} ${title}`);
		lines.push(`   ${mins}m${secs}s | ${h.status}`);
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

// ── /goal clear（强制清）──────────────────────────────

/**
 * FR-6.3：强制清。直接 cancelled + clearSession。
 */
function handleClear(pi: ExtensionAPI, session: GoalSession, ctx: ExtensionContext): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "info");
		return;
	}
	const ports = buildPorts(pi, ctx);
	// transitionStatus 查表终态不可转（engine/goal.ts）：已终态 goal 直接 clearSession
	if (!isTerminalStatus(session.state.status)) {
		// FR-3.3: 唯一终态序列入口（tick + finalizeGoal + persist）
		finalizeAndPersist(session.state, "cancelled", 0, ports);
	}
	// FR-8.7: cancelled → 立即 clearSession
	clearGoalSession(session, ports.ui);
	ctx.ui.notify("Goal cleared.", "info");
}

// ── /goal update（重塑）──────────────────────────────

/**
 * FR-8.4 G-002：重塑（reset）。重置 objective/budget flags/
 * currentTurnIndex/lastProgressTurn，保留 goalId。
 * active 状态下向 AI 注入 objective-updated steering。
 */
function handleUpdate(
	pi: ExtensionAPI,
	session: GoalSession,
	newObjective: string | undefined,
	criteria: string | undefined,
	ctx: ExtensionContext,
): void {
	if (!session.state) {
		ctx.ui.notify("Goal mode not active.", "warning");
		return;
	}
	if (!newObjective) {
		ctx.ui.notify("Usage: /goal update <new-objective> [--criteria <text>]", "warning");
		return;
	}
	const state = session.state;
	const oldObjective = state.objective;
	// FR-8.4 G-002: 重塑（重置，保留 goalId）
	state.objective = newObjective;
	state.objectiveUpdatedAt = Date.now();
	state.currentTurnIndex = 0;
	state.lastProgressTurn = 0;
	state.budgetLimitSteeringSent = false;
	state.tokenWarning70Sent = false;
	state.tokenWarning90Sent = false;
	state.timeWarning70Sent = false;
	state.timeWarning90Sent = false;
	// GAP-6: update 是重塑，旧 slug 已不匹配新 objective → 置空（widget fallback objective 截断）
	state.slug = undefined;
	// update 重塑后旧 successCriteria 可能不再完全匹配新 objective，但语义内容仍可部分适用。
	// 显式传 --criteria 则替换；未传则保留旧值（修复：此前静默清空导致验证标准永久丢失，
	// 无恢复机制）。objectiveUpdatedPrompt 注入保留的 criteria 并声明按新 objective 判断完成。
	if (criteria !== undefined && criteria.trim()) {
		state.successCriteria = criteria.trim();
	}
	// FR-6.5: 持久化重塑后的状态（persistState 按当前 status tick 累加）+ FR-6.1 widget 刷新
	const updatePorts = buildPorts(pi, ctx);
	persistState(session, updatePorts);
	updateWidget(session, updatePorts.ui);
	ctx.ui.notify(`Objective updated:\nPrevious: ${oldObjective}\nNew: ${newObjective}`, "info");

	if (isActiveStatus(state.status)) {
		const ports = buildPorts(pi, ctx);
		ports.messaging.sendContextMessage(objectiveUpdatedPrompt(state, oldObjective), "steer");
	}
}

// ── /goal set（提示词触发器）─────────────────────────

/**
 * /goal <objective> 改为「提示词触发器」：不直接 createGoal，
 * 而是 sendUserMessage 引导 AI 调 goal_control create（slug 由 AI 生成）。
 *
 * 这样 goal 创建的唯一路径是 goal_control toolcall（统一入口），
 * slug/objective/budget 都由 AI 在 toolcall 时决定。
 *
 * D25 守卫仍在此处预检：非终态旧 goal（active/paused/blocked）→ 拒绝，
 * 提示 /goal resume 或 /goal clear（避免 AI 在已有未完成 goal 时重复创建）。
 *
 * budget flag（--tokens/--timeout）写入消息体，让 AI 原样传给 create。
 */
function handleSet(
	pi: ExtensionAPI,
	session: GoalSession,
	objective: string,
	budgetOverrides: Partial<BudgetConfig> | undefined,
	ctx: ExtensionContext,
): void {
	if (!objective || !objective.trim()) {
		ctx.ui.notify("Usage: /goal <objective> [--tokens N] [--timeout N]", "warning");
		return;
	}

	// #11 / D25: 非终态旧 goal（active/paused/blocked）→ 拒绝（不覆盖、不写 history）
	if (session.state && !isTerminalStatus(session.state.status)) {
		ctx.ui.notify(
			"Goal already active. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
		return;
	}

	// budget 校验（非法值在此拦截，不进入消息体）
	if (budgetOverrides?.tokenBudget !== undefined && budgetOverrides.tokenBudget <= 0) {
		ctx.ui.notify("Token budget must be greater than 0.", "warning");
		return;
	}
	if (budgetOverrides?.timeBudgetMinutes !== undefined && budgetOverrides.timeBudgetMinutes <= 0) {
		ctx.ui.notify("Time budget must be greater than 0.", "warning");
		return;
	}

	// 构造引导 AI 创建 goal 的消息（含 objective + 可选 budget）
	const budgetHints: string[] = [];
	if (budgetOverrides?.tokenBudget) budgetHints.push(`tokenBudget: ${budgetOverrides.tokenBudget}`);
	if (budgetOverrides?.timeBudgetMinutes)
		budgetHints.push(`timeBudgetMinutes: ${budgetOverrides.timeBudgetMinutes}`);
	const budgetLine = budgetHints.length > 0 ? `\nBudget: ${budgetHints.join(", ")}` : "";

	const message =
		`Start a new goal. Call goal_control(action="create") with:\n` +
		`- slug: a short kebab-case identifier you generate for this goal\n` +
		`- objective: restate the REAL objective in your own words — what actually needs to be achieved (think about the true intent, don't just echo the text below)\n` +
		`- successCriteria: concrete, checkable conditions that prove the objective is achieved (e.g. 'tests pass', 'file X exists', 'command Y outputs Z')\n` +
		(budgetHints.length > 0 ? `- pass through the budget values below as-is\n` : "") +
		`\nRaw objective from user: ${objective.trim()}${budgetLine}`;

	ctx.ui.notify(`Requesting goal start: ${objective.trim()}`, "info");
	// FR-8.12: 触发 AI（followUp）—— AI 消化后调 goal_control create
	pi.sendUserMessage(message, { deliverAs: "followUp" });
}
