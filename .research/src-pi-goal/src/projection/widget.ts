/**
 * Widget 渲染逻辑（projection 层）— 状态栏和侧边栏面板
 *
 * 设计要点：
 * - 不 import Pi 类型（ThemeColor → ThemeLike，fg 接收 string）
 * - 类型 import 自 engine/types.ts
 * - 工具函数 import 自 engine/budget.ts
 * - 时间计算基于 state.timeUsedSeconds（不含 Date.now() 副作用段）
 * - updateWidget(session, uiPort) 含 FR-6.6 hasUI 守卫
 *
 * slug 精简（widget 显示优化）：
 * - 状态栏/侧边栏标题用 slug（AI 生成），无 slug fallback objective 截断。
 * - 完整 objective 仍注入 prompt（不在此显示），用户要看全文用 /goal status。
 * - budget 显示：配了预算显示 used/budget；没配显示已消耗绝对值（D-widget-3）。
 */

import {
	OBJECTIVE_DISPLAY_LIMIT,
	OBJECTIVE_TRUNCATE_KEEP,
	PERCENT_FACTOR,
	PROGRESS_BAR_DEFAULT_WIDTH,
	SECONDS_PER_MINUTE,
	TOKEN_K_THRESHOLD,
} from "../constants";
import { getBudgetColor, getTimeUsagePercent, getTokenUsagePercent } from "../engine/budget";
import { isTerminalStatus } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import type { UiPort } from "../ports";
import type { GoalSession } from "../session";

/**
 * projection 层的 Theme 抽象。不 import Pi 的 ThemeColor。
 * adapter 层负责把 Pi 的 theme（fg 接收 ThemeColor）适配到此签名（fg 接收 string）。
 */
export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * 将多行文本压缩为单行，用于 widget 渲染。
 * 多行 content 泄漏到 widget 会导致 markdown 表格/标题等破坏布局。
 */
export function toSingleLine(text: string): string {
	return text.replace(/\r?\n/g, " ").trim();
}

// ── token 缩写格式化（GAP-7）──────────────────────────

/**
 * 把 token 数缩写为紧凑形式：≥1000 用 k 单位（12000 → "12k"，1500 → "1.5k"）。
 * 用于 widget 状态栏，避免长数字挤占空间。
 */
export function formatTokens(n: number): string {
	if (n >= TOKEN_K_THRESHOLD) {
		const k = n / TOKEN_K_THRESHOLD;
		// 整数 k 不带小数（12k），非整数保留一位小数（1.5k）
		return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
	}
	return String(n);
}

// ── slug 标题（fallback objective 截断，GAP-8）─────────

/**
 * 返回 widget 标题：优先 slug，无 slug fallback objective 截断（单行）。
 */
export function getTitle(state: GoalRuntimeState): string {
	if (state.slug) return state.slug;
	const objSingleLine = toSingleLine(state.objective);
	return objSingleLine.length > OBJECTIVE_DISPLAY_LIMIT
		? `${objSingleLine.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
		: objSingleLine;
}

function renderProgressBar(pct: number, width: number = PROGRESS_BAR_DEFAULT_WIDTH): string {
	const clamped = Math.min(Math.max(pct, 0), 1);
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * 返回累计耗时秒数（仅基于 state 内字段，不含 Date.now() 副作用）。
 * 终态 / blocked 状态下停止累计，直接返回已记录值。
 * adapter/service 在调用 projection 前已通过 budget.tick() 把当前活跃段计入
 * state.timeUsedSeconds，因此此处直接读取即可。
 */
function getElapsedSeconds(state: GoalRuntimeState): number {
	return state.timeUsedSeconds;
}

function formatMinutes(seconds: number): string {
	const mins = Math.floor(seconds / SECONDS_PER_MINUTE);
	const secs = Math.floor(seconds % SECONDS_PER_MINUTE);
	return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

export function renderStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	let text = th.fg("accent", `◆ ${getTitle(state)}`) + th.fg("muted", ` Turn ${state.currentTurnIndex}`);

	// Budget indicators：配了预算显示百分比，没配显示已消耗绝对值（D-widget-3）
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	} else {
		text += th.fg("dim", ` | ${formatTokens(state.tokensUsed)} tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state, getElapsedSeconds(state)));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	} else {
		text += th.fg("dim", ` | ${formatMinutes(getElapsedSeconds(state))}`);
	}

	// Status suffix：非终态（paused = 用户暂停等待 resume / blocked = agent 报告卡住）
	// + 终态（complete/budget_limited/time_limited）。paused 非终态，走 renderStatusLine。
	switch (state.status) {
		case "paused":
			text += th.fg("warning", " | ⏸ Paused");
			break;
		case "blocked":
			text += th.fg("error", " | ⊘ Blocked");
			break;
		case "complete":
			text += th.fg("success", " | ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " | ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " | ⏱ Time budget exhausted");
			break;
	}

	return text;
}

export function renderTerminalStatusLine(state: GoalRuntimeState, th: ThemeLike): string {
	if (state.status === "cancelled") return "";

	// GAP-12: 终态行维持现状——只显示状态后缀 + 有预算的维度百分比。
	// 终态 goal 已结束，显示「used (no budget)」绝对值意义不大。
	let text = th.fg("accent", "◆ Goal");

	// 状态后缀
	switch (state.status) {
		case "complete":
			text += th.fg("success", " ✓ Completed");
			break;
		case "budget_limited":
			text += th.fg("error", " ⊗ Token budget exhausted");
			break;
		case "time_limited":
			text += th.fg("error", " ⏱ Time budget exhausted");
			break;
		default:
			break;
	}

	// 预算摘要（仅有预算的维度）
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = Math.round(getTokenUsagePercent(state));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% tokens`);
	}
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const pct = Math.round(getTimeUsagePercent(state, getElapsedSeconds(state)));
		text += th.fg(getBudgetColor(pct), ` | ${pct}% time`);
	}

	return text;
}

export function renderWidgetLines(state: GoalRuntimeState, th: ThemeLike): string[] {
	if (state.status === "cancelled") return [];

	const header = renderStatusLine(state, th);
	const lines: string[] = [header];

	// successCriteria 摘要行（与 objective 成对展示；截断避免挤占 widget）
	if (state.successCriteria) {
		const criteria = toSingleLine(state.successCriteria);
		const trimmed =
			criteria.length > OBJECTIVE_DISPLAY_LIMIT
				? `${criteria.slice(0, OBJECTIVE_TRUNCATE_KEEP)}...`
				: criteria;
		lines.push(th.fg("dim", `  ✓ ${trimmed}`));
	}

	// GAP-8: 精简——移除 Objective 全文行（slug 已作标题；完整 objective 注入 prompt，用户看全文用 /goal status）

	// Token 行：配预算显示 used/budget 进度条；没配显示已消耗绝对值
	if (state.budget.tokenBudget && state.budget.tokenBudget > 0) {
		const pct = getTokenUsagePercent(state) / PERCENT_FACTOR;
		const used = formatTokens(state.tokensUsed);
		const total = formatTokens(state.budget.tokenBudget);
		lines.push(`  Token: ${renderProgressBar(pct)} ${used}/${total}`);
	} else {
		lines.push(th.fg("dim", `  Token: ${formatTokens(state.tokensUsed)} used (no budget)`));
	}
	// Time 行：配预算显示 Xm/Ymin 进度条；没配显示已耗时绝对值
	if (state.budget.timeBudgetMinutes && state.budget.timeBudgetMinutes > 0) {
		const elapsed = getElapsedSeconds(state);
		const pct = getTimeUsagePercent(state, elapsed) / PERCENT_FACTOR;
		lines.push(`  Time: ${renderProgressBar(pct)} ${formatMinutes(elapsed)}/${state.budget.timeBudgetMinutes}min`);
	} else {
		lines.push(th.fg("dim", `  Time: ${formatMinutes(getElapsedSeconds(state))} elapsed (no budget)`));
	}

	return lines;
}

// ── updateWidget（FR-6.6 hasUI 守卫）──

/**
 * 从 UiPort 取出 ThemeLike。
 *
 * ports.ts 的 UiPort 故意不暴露 theme（保持抽象最小）。adapter 层在
 * 构造 UiPort 实现时，把 Pi 的 ctx.ui.theme 的 fg/bold 方法挂到对象上，
 * 使该实现同时满足 UiPort 与 ThemeLike 形状。projection 层通过此单步断言取出。
 */
function asTheme(uiPort: UiPort): ThemeLike {
	// UiPort 刻意不声明 fg/bold（D-22：只声明机器可检查的能力边界），与 ThemeLike 无类型重叠，
	// 必须 unknown 中转——这是架构契约断言：ports.ts 构造 UiPort 实现时已把 ctx.ui.theme 的
	// fg/bold 挂到对象上（buildPorts 的 uiPort 对象含全部字段），运行时必然存在。
	// eslint-disable-next-line taste/no-unsafe-cast
	return uiPort as unknown as ThemeLike;
}

/**
 * 导出 asTheme：单一 theme 提取断言点（TS-1）。
 *
 * adapter 层（event-adapter handleTerminalStateBeforeAgent）复用本函数，
 * 避免重复 `ctx.ui.theme as unknown as ThemeLike` 断言。
 */
export { asTheme };

/**
 * 刷新 widget + status bar。
 *
 * FR-6.6：`uiPort.hasUI === false`（headless / RPC mode）时直接 return，
 * 不调 setWidget / setStatus，避免无 UI 环境崩溃或无意义写入。
 *
 * 终态折叠为单行 status bar；cancelled / 无 state 时清除 widget + status。
 */
export function updateWidget(session: GoalSession, uiPort: UiPort): void {
	if (!uiPort.hasUI) return;

	if (!session.state || session.state.status === "cancelled") {
		uiPort.setWidget("goal", undefined);
		uiPort.setStatus("goal", undefined);
		return;
	}

	// 终态折叠为单行 status bar
	if (isTerminalStatus(session.state.status)) {
		const statusText = renderTerminalStatusLine(session.state, asTheme(uiPort));
		if (statusText) {
			uiPort.setStatus("goal", statusText);
		}
		uiPort.setWidget("goal", undefined);
		return;
	}

	uiPort.setStatus("goal", renderStatusLine(session.state, asTheme(uiPort)));
	uiPort.setWidget("goal", renderWidgetLines(session.state, asTheme(uiPort)));
}
