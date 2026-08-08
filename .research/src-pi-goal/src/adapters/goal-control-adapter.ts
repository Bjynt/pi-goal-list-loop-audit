/**
 * goal_control tool — agent 控制入口（create / complete / report_blocked）
 *
 * #3：替代已删除的 goal_manager tool。
 *
 * 职责分层：
 * - execute 层（adapter 职责）：signal 守卫
 * - handler 层（goal 业务，契约对齐 code-architecture §3 handleCreate/handleComplete/handleReportBlocked）：
 *   active 守卫 + evidence/reason 必填 + 状态转换
 *
 * 全解耦：goal 不再读 todo/plan 状态。complete 不做 todo 完成前置硬检查——
 * todo 是否全完成由 AI 自行判断，goal 仅通过 prompt 软建议（见 prompts.ts）。
 *
 * 复用 engine/service 既有函数，不重写：
 * - create: service.createGoal（FR-3.1 唯一创建入口；非终态旧 goal 拒绝，对齐 D25 / Codex create_goal）
 * - complete: finalizeAndPersist(state, "complete", ...)（内部已含 tickState → finalizeGoal → persist）
 * - report_blocked: 手动 tickState（status 仍 active 才累加当前运行段）→ transitionStatus(active→blocked) → persistState
 *
 * create 不调 sendUserMessage：toolcall 时 AI 已在 turn 中，返回结果后自行续跑
 * （与 /goal set 的 followUp 触发区分；对齐 Codex create_goal 不自动续跑）。
 *
 * executionMode: "sequential"——状态变更 tool，不可与同批其他 tool 并行执行。
 *
 * 错误处理：用 throw new Error（CLAUDE.md Tool 设计规范），不返回错误成功模式。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type GuiComponent, guiComponent, type GuiRenderResult,guiResult } from "@xyz-agent/extension-protocol";
import { type Static, Type } from "typebox";

import { BUDGET_RATIO_HIGH, BUDGET_RATIO_LOW, OBJECTIVE_DISPLAY_LIMIT, SECONDS_PER_MINUTE, SHORT_ID_LENGTH } from "../constants";
import { isActiveStatus, isTerminalStatus, transitionStatus } from "../engine/goal";
import type { BudgetConfig, GoalRuntimeState, GoalStatus } from "../engine/types";
import { toSingleLine, updateWidget } from "../projection/widget";
import { createGoal, finalizeAndPersist, persistState, type ServicePorts, tickState } from "../service";
import type { GoalSession } from "../session";
import { buildPorts } from "./ports";

// ── Params schema ────────────────────────────────────

const GoalControlParams = Type.Object({
	action: StringEnum(["create", "complete", "report_blocked"] as const),
	slug: Type.Optional(
		Type.String({
			description:
				"Required for 'create'. A short kebab-case identifier you generate to title this goal in the status bar (e.g. 'refactor-auth', 'fix-login-bug'). Keep it concise and descriptive.",
		}),
	),
	objective: Type.Optional(
		Type.String({
			description:
				"Required for 'create'. Restate the REAL objective in your own words — what the user actually wants achieved, not a literal echo of their request. If ambiguous, infer the most likely intent and state it explicitly.",
		}),
	),
	successCriteria: Type.Optional(
		Type.String({
			description:
				"Required for 'create'. Concrete, checkable conditions that prove the objective is achieved (e.g. 'tests pass', 'file X exists with content Y', 'command Z outputs W'). NOT aspirations or 'it should work'. This is the bar you must clear before calling complete — every condition here must be backed by evidence.",
		}),
	),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for 'complete'. Concrete completion evidence (files created/modified, tests passed, commands run). Do not mark complete on assumption, intent, or partial progress.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description:
				"Required for 'report_blocked'. The specific blocking condition and what was already tried (at least 3 approaches). Do NOT use for uncertainty, slow/hard work, or incomplete progress — keep working.",
		}),
	),
	tokenBudget: Type.Optional(
		Type.Number({
			description: "Optional, for 'create'. Positive token budget for the new goal. Omit unless the user specifies one.",
		}),
	),
	timeBudgetMinutes: Type.Optional(
		Type.Number({
			description: "Optional, for 'create'. Positive time budget in minutes for the new goal. Omit unless the user specifies one.",
		}),
	),
	completedTasks: Type.Optional(
		Type.Number({
			description: "Optional. Number of completed tasks, written into goal history on 'complete'. Defaults to 0.",
		}),
	),
});

export type GoalControlActionParams = Static<typeof GoalControlParams>;

// ── Details（renderResult 数据来源）──────────────────

export interface GoalControlDetails {
	action: "create" | "complete" | "report_blocked";
	goalId: string;
	status: GoalStatus;
	slug?: string;
	/** RPC 模式下的 GUI 渲染描述符（progress-bar 预算进度）。TUI 模式无此字段。 */
	__gui__?: GuiRenderResult;
}

// ── 业务 handler（契约对齐 §3，可测：fake ports）──────

/**
 * create 业务逻辑：slug + objective 均必填 + 非终态旧 goal 守卫 + service.createGoal。
 *
 * slug：AI 生成的短标识，仅 widget 标题 + history 用，不注入 prompt。
 * objective：完整描述，注入每轮 context prompt（保证方向感）。
 *
 * 全解耦：不读 todo/plan。toolcall 时 AI 已在 turn 中，**不**调 sendUserMessage
 * （AI 返回后自行续跑，对齐 Codex create_goal）。
 *
 * 守卫用 D25 严格语义：非终态 active/paused/blocked 全挡，提示用 /goal resume 或
 * /goal clear——防 AI 静默覆盖含未完成工作的 goal。
 * 终态旧 goal 走 createGoal 快速路径覆盖（createGoal 内部 active 守卫，终态可覆盖）。
 */
export function handleCreate(
	params: GoalControlActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new Error(
			"'objective' is required for create. Describe the concrete objective to pursue. Correct: {\"action\":\"create\",\"slug\":\"<kebab-case>\",\"objective\":\"<concrete objective>\"}",
		);
	}
	const slug = params.slug?.trim();
	if (!slug) {
		throw new Error(
			"'slug' is required for create. Provide a short kebab-case identifier (e.g. 'refactor-auth'). Correct: {\"action\":\"create\",\"slug\":\"refactor-auth\",\"objective\":\"<concrete objective>\"}",
		);
	}

	const successCriteria = params.successCriteria?.trim();
	if (!successCriteria) {
		throw new Error(
			"'successCriteria' is required for create. Define how you will verify the objective is achieved — concrete checkable conditions. Correct: {\"action\":\"create\",\"slug\":\"refactor-auth\",\"objective\":\"...\",\"successCriteria\":\"pnpm test passes; tsc --noEmit clean; src/auth.ts uses JWT\"}",
		);
	}

	// D25 严格守卫：非终态旧 goal（active/paused/blocked）→ 拒绝创建（防静默覆盖未完成工作）
	if (session.state && !isTerminalStatus(session.state.status)) {
		throw new Error(
			`Goal already active (status: ${session.state.status}). Use /goal resume to continue or /goal clear to reset before creating a new one.`,
		);
	}

	// budget 校验：非法预算直接拒绝，不静默截断
	const budget: Partial<BudgetConfig> = {};
	if (params.tokenBudget !== undefined) {
		if (params.tokenBudget <= 0) {
			throw new Error("'tokenBudget' must be greater than 0.");
		}
		budget.tokenBudget = params.tokenBudget;
	}
	if (params.timeBudgetMinutes !== undefined) {
		if (params.timeBudgetMinutes <= 0) {
			throw new Error("'timeBudgetMinutes' must be greater than 0.");
		}
		budget.timeBudgetMinutes = params.timeBudgetMinutes;
	}

	// FR-3.1: 唯一创建入口（isExternalInit=false）。终态旧 goal 走覆盖快速路径。
	const created = createGoal(session, objective, budget, ports, false, slug, successCriteria);
	if (!created) {
		// createGoal 内部 active 守卫兜底（理论上上面守卫已挡；防御性）
		throw new Error("Goal already active. Cannot create a new one.");
	}
	updateWidget(session, ports.ui);

	const state = session.state!;
	const budgetNotice: string[] = [];
	if (budget.tokenBudget) budgetNotice.push(`Token budget: ${budget.tokenBudget}`);
	if (budget.timeBudgetMinutes) budgetNotice.push(`Time budget: ${budget.timeBudgetMinutes} min`);
	ports.ui.notify([`Goal created [${slug}]: ${objective}`, ...budgetNotice].join("\n"), "info");

	return { action: "create", goalId: state.goalId, status: state.status, slug };
}

/**
 * complete 业务逻辑：active 守卫 + evidence 必填 + finalizeAndPersist。
 *
 * 全解耦后不再做 todo 完成前置检查——todo 是否全完成由 AI 自行判断（prompt 软建议）。
 */
export function handleComplete(
	params: GoalControlActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (!isActiveStatus(state.status)) {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can be completed.`);
	}
	const evidence = params.evidence?.trim();
	if (!evidence) {
		throw new Error(
			"'evidence' is required for complete. Provide concrete completion evidence. Correct: {\"action\":\"complete\",\"evidence\":\"Modified src/auth.ts; pnpm test auth passed (12/12); tsc --noEmit clean.\"}",
		);
	}

	// FR-3.3: 唯一终态序列入口（内部：tickState → finalizeGoal(transition+history) → persist）
	finalizeAndPersist(state, "complete", params.completedTasks ?? 0, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal completed: ${state.objective}`, "info");

	return { action: "complete", goalId: state.goalId, status: state.status };
}

/**
 * report_blocked 业务逻辑：active 守卫 + reason 必填 + tickState + transitionStatus + persistState。
 *
 * 必须在 transitionStatus **之前** tickState，使 tick 看到 active 状态并累加当前运行段；
 * 否则转 blocked 后 persistState 内部的 tick 因 status≠active 不累加，丢失最后一段运行时间。
 */
export function handleReportBlocked(
	params: GoalControlActionParams,
	session: GoalSession,
	ports: ServicePorts,
): GoalControlDetails {
	const state = session.state;
	if (!state) throw new Error("Goal mode not active.");
	if (state.status !== "active") {
		throw new Error(`Goal is not active (status: ${state.status}). Only an active goal can report_blocked.`);
	}
	const reason = params.reason?.trim();
	if (!reason) {
		throw new Error(
			"'reason' is required for report_blocked. Describe the blocking condition. Correct: {\"action\":\"report_blocked\",\"reason\":\"<blocker + what was tried (at least 3 approaches)>\"}",
		);
	}

	state.lastBlockerReason = reason;
	// 先 tickState 累加当前运行段（此时 status 仍为 active）
	tickState(state);
	state.status = transitionStatus(state.status, "blocked");

	persistState(session, ports);
	updateWidget(session, ports.ui);
	ports.ui.notify(`Goal blocked: ${reason}`, "warning");

	return { action: "report_blocked", goalId: state.goalId, status: state.status };
}

// ── GUI 渲染描述符构造 ───────────────────────────────

/**
 * 按 GoalStatus 映射 stats-line severity（S#2）。
 *
 *   active/complete → ok（正常运行/成功完成）
 *   paused          → warn（暂停可恢复）
 *   blocked         → danger（阻塞需干预）
 *   budget_limited/time_limited/cancelled → danger（预算耗尽/取消，错误终态）
 *
 * 对齐 projection/widget.ts 的 getBudgetColor 语义——终态预算耗尽渲染为 error。
 */
/** renderResult 的 result 是否含 details 字段（类型守卫，替代全可选结构断言 as {details?}）。
 * 收紧：除检查 "details" in r 外，还验证其值为 object 或 undefined（防 details 是 string/number
 * 时下游读 d.status 得到 undefined 却被类型系统当作 GoalControlDetails）。 */
function hasGoalDetails(r: unknown): r is { details?: GoalControlDetails } {
	if (typeof r !== "object" || r === null || !("details" in r)) return false;
	const d = (r as Record<string, unknown>).details;
	return d === undefined || typeof d === "object";
}

function goalStatusSeverity(status: GoalStatus): "ok" | "warn" | "danger" {
	switch (status) {
		case "active":
		case "complete":
			return "ok";
		case "paused":
			return "warn";
		case "blocked":
		case "budget_limited":
		case "time_limited":
		case "cancelled":
			return "danger";
	}
}

/**
 * 构造 goal 的 GUI 渲染描述符（RPC 模式下放进 details.__gui__）。
 *
 * 逻辑参考 projection/widget.ts 的 renderWidgetLines 预算计算，但此处只构造
 * 结构化数据（GuiComponent），不做 ANSI 渲染。
 *
 * - 有 tokenBudget 或 timeBudgetMinutes → card(progress-bar + stats-line) 展示预算消耗
 * - 无 budget → stats-line 展示状态摘要
 */
export function buildGoalGui(state: GoalRuntimeState): GuiRenderResult {
	const slug = state.slug ?? state.goalId.slice(0, SHORT_ID_LENGTH);
	// successCriteria 摘要（截断后进 stats-line；与 objective 成对展示）
	const criteriaSnippet = state.successCriteria
		? toSingleLine(state.successCriteria).slice(0, OBJECTIVE_DISPLAY_LIMIT)
		: undefined;
	// statusSeverity 按 GoalStatus 完整覆盖（S#2）：
	//   active/complete → ok；blocked → danger；paused → warn；
	//   budget_limited/time_limited/cancelled → danger（预算耗尽/取消是错误终态）
	const statusSeverity = goalStatusSeverity(state.status);

	// hasBudget 与进度条判定统一口径：用 > 0 而非 truthy（I#1：tokenBudget=0 不应触发 card 容器）
	const hasBudget = (state.budget.tokenBudget ?? 0) > 0 || (state.budget.timeBudgetMinutes ?? 0) > 0;

	if (hasBudget) {
		const body: GuiComponent[] = [];
		// token 进度条（>0 判定，与 hasBudget 口径一致）
		const tokenBudget = state.budget.tokenBudget;
		if ((tokenBudget ?? 0) > 0) {
			const tb = tokenBudget!;
			const tokenPct = state.tokensUsed / tb;
			body.push(
				guiComponent("progress-bar", {
					label: "tokens",
					current: state.tokensUsed,
					total: tb,
					unit: "tok",
					severity: tokenPct >= BUDGET_RATIO_HIGH ? "danger" : tokenPct >= BUDGET_RATIO_LOW ? "warn" : "ok",
				}),
			);
		}
		// time 进度条（>0 判定，与 hasBudget 口径一致）
		const timeBudgetMinutes = state.budget.timeBudgetMinutes;
		if ((timeBudgetMinutes ?? 0) > 0) {
			const timeBudgetSec = timeBudgetMinutes! * SECONDS_PER_MINUTE;
			const timePct = state.timeUsedSeconds / timeBudgetSec;
			body.push(
				guiComponent("progress-bar", {
					label: "time",
					current: state.timeUsedSeconds,
					total: timeBudgetSec,
					unit: "s",
					severity: timePct >= BUDGET_RATIO_HIGH ? "danger" : timePct >= BUDGET_RATIO_LOW ? "warn" : "ok",
				}),
			);
		}
		// 状态 + turn 统计行
		body.push(
			guiComponent("stats-line", {
				items: [
					{ label: "status", value: state.status, severity: statusSeverity },
					{ label: "turn", value: String(state.currentTurnIndex) },
				],
			}),
		);
		// successCriteria 摘要（与 objective 成对，让用户看到「怎么算完成」）
		if (criteriaSnippet) {
			body.push(
				guiComponent("stats-line", {
					items: [{ label: "done", value: criteriaSnippet }],
				}),
			);
		}
		return guiResult(
			guiComponent("card", {
				variant: state.status === "blocked" ? "danger" : state.status === "complete" ? "success" : "default",
				header: slug,
				body,
			}),
		);
	}

	// 无 budget：stats-line 摘要
	return guiResult(
		guiComponent("stats-line", {
			items: [
				{ label: "goal", value: slug },
				{ label: "status", value: state.status, severity: statusSeverity },
				{ label: "turn", value: String(state.currentTurnIndex) },
				{ label: "tokens", value: String(state.tokensUsed) },
				...(criteriaSnippet ? [{ label: "done", value: criteriaSnippet }] : []),
			],
		}),
	);
}

// ── Tool 注册 ────────────────────────────────────────

export function registerGoalControlTool(pi: ExtensionAPI, session: GoalSession): void {
	pi.registerTool({
		name: "goal_control",
		label: "Goal Control",
		description:
			`Manage the goal for this thread.

Actions:
- create: proactively start a goal for COMPLEX, multi-step work (3+ steps, multi-file changes, or work that needs completion verification). Restate the real objective and define checkable successCriteria. Skip for trivial single-step tasks, ordinary questions, or lookups. Fails if a goal is already active/paused/blocked (use /goal resume or /goal clear first).
- complete: mark the active goal complete. Requires 'evidence' with concrete proof (files/tests/commands) that meets EVERY successCriteria condition.
- report_blocked: mark the active goal blocked by a real blocker. Requires 'reason' describing the block and what was tried. Only after genuine exhaustion of alternatives.

Examples:
{"action":"create","slug":"refactor-auth","objective":"Refactor the auth module to use JWT and add integration tests","successCriteria":"src/auth.ts uses JWT; pnpm test auth green; tsc --noEmit clean"}
{"action":"complete","evidence":"Modified src/auth.ts; pnpm test auth passed (12/12); tsc --noEmit clean."}
{"action":"report_blocked","reason":"Blocked: DB migration API changed mid-task (tried: regenerate client, pin old version, rewrite queries)."}

Don't:
- create for trivial/ordinary tasks — reserve goals for complex multi-step work worth tracking.
- create without 'successCriteria': {"action":"create","objective":"..."} — you must define how completion is verified.
- complete without 'evidence': {"action":"complete"} — must provide concrete proof meeting every successCriteria condition.
- complete when no goal is active — create or resume one first (fails with 'Goal mode not active').`,
		promptSnippet:
			"Use goal_control to manage the thread goal: proactively create (with slug + objective + successCriteria) for complex multi-step work, complete (with evidence meeting every successCriteria), or report_blocked (with reason, after trying alternatives).",
		// promptGuidelines：进 system prompt guidelines 段（强信号位）。
		// 三个 action 的正向触发引导——create（复杂任务主动启动）、complete（对照 successCriteria 验证达成）、
		// report_blocked（穷尽替代方案后）。措辞主动，给 system prompt 层常驻强信号。
		promptGuidelines: [
			// create：主动用于复杂多步骤任务。翻转原「显式启动」策略——让 goal 真正可用。
			// 门槛：3+ 步骤 / 多文件 / 需完成验证，避免对琐碎任务滥建 goal 变噪音。
			"create: proactively start a goal for complex, multi-step work (3+ steps, multi-file, or needs completion verification) — restate the real objective and define checkable successCriteria. Do NOT create for trivial single-step tasks, ordinary lookups, or when a goal is already active. Test: 'is this worth tracking to completion with verification?' — if yes, create a goal.",
			// 全解耦下 todo 非硬前置——objective 实际达成才算（与 handleComplete「todo 由 AI 自判」一致）
			"complete: proactively call when the active goal's objective is actually achieved, not merely in progress. Evidence must be concrete artifacts (files changed, tests green, commands run) meeting every successCriteria condition. Finishing all todos (incl. verification todos) is the usual readiness signal, but the real bar is the objective being met — you decide.",
			// P3 数字阈值 ≥3，与 params.reason description 的 "at least 3 approaches" 双重冗余
			"report_blocked: proactively call when genuinely blocked after ≥3 distinct alternative approaches — not for hard/slow work or uncertainty. State the blocker and what you tried. Do NOT silently stop or leave the goal hanging.",
		],
		executionMode: "sequential",
		parameters: GoalControlParams,

		async execute(
			_toolCallId: string,
			params: GoalControlActionParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: GoalControlDetails }> {
			if (signal?.aborted) {
				throw new Error("goal_control aborted by signal.");
			}
			const ports = buildPorts(pi, ctx);

			let details: GoalControlDetails;
			if (params.action === "create") {
				details = handleCreate(params, session, ports);
			} else if (params.action === "complete") {
				// 全解耦：不再做 todo 完成前置硬检查。AI 自行判断 todo 是否全完成（prompt 软建议）。
				details = handleComplete(params, session, ports);
			} else {
				details = handleReportBlocked(params, session, ports);
			}

			const text =
				details.action === "create"
					? `Goal created.\nGoal ID: ${details.goalId}\nSlug: ${details.slug ?? ""}\nObjective: ${params.objective?.trim() ?? ""}`
					: details.action === "complete"
						? `Goal completed.\nGoal ID: ${details.goalId}`
						: `Goal reported blocked.\nGoal ID: ${details.goalId}\nReason: ${params.reason?.trim() ?? ""}`;

			// RPC 模式下附加 __gui__（用展开避免 details 来自 frozen 对象时加字段失败）
			if (ctx.mode === "rpc" && session.state) {
				return { content: [{ type: "text", text }], details: { ...details, __gui__: buildGoalGui(session.state) } };
			}
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args: Record<string, unknown>, theme: Theme): Text {
			const action = args.action as string;
			const slug = typeof args.slug === "string" ? args.slug : "";
			const actionLabel =
				action === "create"
					? theme.fg("accent", "create") + (slug ? theme.fg("dim", ` ${slug}`) : "")
					: action === "complete"
						? theme.fg("success", "complete")
						: theme.fg("error", "report_blocked");
			return new Text(theme.fg("toolTitle", theme.bold("goal_control ")) + actionLabel, 0, 0);
		},

		renderResult(result: unknown, _options: { expanded: boolean }, theme: Theme): Text {
			const d = hasGoalDetails(result) ? result.details : undefined;
			if (!d) return new Text(theme.fg("dim", "goal_control"), 0, 0);
			const statusColor =
				d.status === "active"
					? "accent"
					: d.status === "complete"
						? "success"
						: d.status === "blocked"
							? "error"
							: "muted";
			const label = d.action === "create" ? "Created" : d.action === "complete" ? "Completed" : "Blocked";
			const slugSuffix = d.slug ? theme.fg("dim", ` ${d.slug}`) : "";
			return new Text(theme.fg(statusColor, `◆ Goal ${label}`) + slugSuffix, 0, 0);
		},
	});
}
