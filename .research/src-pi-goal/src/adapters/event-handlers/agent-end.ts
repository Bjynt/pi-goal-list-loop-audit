/**
 * 事件 6: agent_end（FR-8.7 + ESC 守卫 + 并发保护）。
 *
 * 关键约定：
 * - FR-8.2 G-021 防重入：session.isProcessing 入口加锁，finally 释放
 * - FR-8.2 G-020 stale 快照：入口 makeStaleChecker snapshot goalId，每个副作用前 checkStale
 * - FR-6.7 ESC 守卫（最关键）：ctx.signal?.aborted → 不发 continuation、不做 budget 检查、
 *   不做任何状态变更，goal 保持 active，等用户下次输入恢复
 *
 * #8 后流程：budget 预警/steering → continuation 去抖。
 * agent_end 只做提醒（warning + steering），不做终态转换。
 * 终态转换不在 agent_end——由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 *
 * 全解耦：不再做 allTasksDone followUp（原依赖 pi.__todoGetList，跨 ext 失效）。
 * todo 是否全完成由 AI 自行判断（prompt 软建议）。
 *
 * ESC 路径：aborted 时直接 return（goal 保持 active）。注意 ESC 守卫在终态/非 active
 * 检查之后——终态 goal 仍走终态 notify（不被 ESC 影响），非 active 状态直接返回。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";

import { checkBudgetOnTurnEnd } from "../../engine/budget";
import { isActiveStatus, isTerminalStatus } from "../../engine/goal";
import {
	budgetLimitPrompt,
	continuationPrompt,
} from "../../projection/prompts";
import { persistAndUpdate, tickState } from "../../service";
import type { GoalSession } from "../../session";
import { buildPorts } from "../ports";
import { makeStaleChecker } from "./shared";

export async function handleAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state || session.isProcessing) return;
	session.isProcessing = true;
	try {
		const checkStale = makeStaleChecker(session);
		if (checkStale()) return;

		// 终态处理（complete / blocked）
		if (session.state.status === "complete" || session.state.status === "blocked") {
			await handleTerminalStateAgentEnd(pi, session, ctx, checkStale);
			return;
		}
		if (!isActiveStatus(session.state.status)) return;

		// FR-6.7 ESC 守卫（最关键）：aborted 时 goal 保持 active，不做任何副作用
		if (ctx.signal?.aborted) {
			return;
		}

		// 预算检查（FR-6.2 维度独立）——先 tick 把当前运行段计入 timeUsedSeconds，
		// 否则时间预算检测会比实际晚一轮（回归修复）
		tickState(session.state);
		const budgetResult = checkBudgetOnTurnEnd(session.state, session.state.timeUsedSeconds);
		const budgetAction = await handleBudgetChecks(pi, session, ctx, budgetResult, checkStale);
		if (budgetAction !== "continue") return;

		// continuation 去抖（budget 预警未拦截时）
		await handleContinuation(pi, session, ctx, checkStale);
	} finally {
		session.isProcessing = false;
	}
}

/** 终态 agent_end：persist + notify（complete/blocked 各一条消息）。 */
async function handleTerminalStateAgentEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (persistAndUpdate(session, buildPorts(pi, ctx), checkStale)) return;
	if (state.status === "complete") {
		ctx.ui.notify(`Objective completed ✓ (${state.currentTurnIndex} turns)`, "info");
	} else {
		ctx.ui.notify(
			"Goal blocked. Use /goal resume to continue or /goal clear to reset.",
			"warning",
		);
	}
}

type BudgetAction = "continue" | "stop";

/**
 * FR-6.2 维度独立预算检查（#8 后只做提醒，不做终态）：
 * - 预警（warning70/warning90）：set flag + notify（不阻塞 continuation）
 * - 90% steering（shouldSendSteering）：set flag + 发 budgetLimitPrompt（收尾），返回 "stop" 中断 continuation
 *
 * 终态转换（budget 耗尽）不在 agent_end，由 persistAndUpdate 兜底（#5 范围，单一检查点）。
 */
async function handleBudgetChecks(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	budgetResult: ReturnType<typeof checkBudgetOnTurnEnd>,
	checkStale: () => boolean,
): Promise<BudgetAction> {
	const state = session.state!;

	// 发送预警（FR-6.2 维度独立：token/time 各有 70/90 flag）
	for (const w of budgetResult.warnings) {
		if (w.type === "warning90") {
			if (w.dimension === "token") state.tokenWarning90Sent = true;
			else state.timeWarning90Sent = true;
			ctx.ui.notify(
				`${w.dimension === "token" ? "Token" : "Time"} budget 90% used — start wrapping up.`,
				"warning",
			);
		} else if (w.type === "warning70") {
			if (w.dimension === "token") state.tokenWarning70Sent = true;
			else state.timeWarning70Sent = true;
			ctx.ui.notify(
				`${w.dimension === "token" ? "Token" : "Time"} budget 70% used — keep scope in check.`,
				"info",
			);
		}
	}

	// 90% steering → 收尾
	if (budgetResult.shouldSendSteering) {
		state.budgetLimitSteeringSent = true;
		if (persistAndUpdate(session, buildPorts(pi, ctx), checkStale)) return "stop";
		buildPorts(pi, ctx).messaging.sendContextMessage(
			budgetLimitPrompt(state, "token", state.timeUsedSeconds),
			"steer",
		);
		return "stop";
	}

	if (checkStale()) return "stop";
	return "continue";
}

/**
 * continuation 去抖（budget 预警未拦截时的尾部逻辑）。
 *
 * - continuation 去抖：tokenDelta=0（空 turn）不发，只 persist
 * - 否则 persist + 发 continuationPrompt
 *
 * 注：maxTurnsReached / stall 自动终态分支随 #6 删除；budget terminal 分支随 #8 删除。
 * 终态转换由 persistAndUpdate 兑底（#5 范围，单一检查点）。
 */
async function handleContinuation(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
	checkStale: () => boolean,
): Promise<void> {
	const state = session.state!;
	if (checkStale()) return;

	// FR-8.6: continuation 去抖（空 turn 不发）
	const tokenDelta = state.tokensUsed - state.lastTurnTokensUsed;
	state.lastTurnTokensUsed = state.tokensUsed;
	if (tokenDelta <= 0) {
		// 空 turn：只 persist，不发 continuation
		persistAndUpdate(session, buildPorts(pi, ctx));
		return;
	}
	persistAndUpdate(session, buildPorts(pi, ctx));
	// 终态守卫：persistAndUpdate 可能把 goal 转为 budget_limited/time_limited 终态。
	// 此时不应发 continuation（deliverAs:"followUp" 会触发新 turn，让已耗尽预算的 agent 再跑一轮）。
	if (isTerminalStatus(state.status)) return;
	// pending 守卫：有活跃 background subagent/workflow 时不发 continuation。
	// 靠 subagent/workflow 完成时 sendMessage({triggerTurn:true,deliverAs:"steer"}) 自然唤醒主 agent；
	// goal 抢先催会与异步任务完成通知叠加，形成“停不下来”的死循环——continuation 排入
	// _followUpMessages 队列 → _handlePostAgentRun 的 hasQueuedMessages() 返回 true → agent.continue()
	// 新 turn → 又 agent_end → 又 continuation。
	// 刻意不校验 expiresAt：长任务 subagent（>1h TTL）完成时仍 triggerTurn 唤醒主 agent，
	// 按 TTL 判非活跃会让死循环在长任务场景复现。
	const pendingOps = countActiveFromEntries(ctx.sessionManager.getEntries());
	if (pendingOps.count > 0) {
		pi.appendEntry("goal:log", {
			timestamp: Date.now(),
			level: "debug",
			component: "goal:agent-end",
			message: `continuation deferred: ${pendingOps.count} active pending operation(s)`,
			data: { activePending: pendingOps.count, ids: pendingOps.ids },
		});
		// 用户可见反馈：goal 在等待后台任务完成而非卡死（deferred 无反馈时用户只看到
		// goal active 但无产出，无法区分等待 vs 死循环）。
		ctx.ui.notify(
			`Goal waiting for ${pendingOps.count} background task(s) to complete.`,
			"info",
		);
		return;
	}
	// 发 continuation（FR-8.7: 去 debounce 后才发）
	buildPorts(pi, ctx).messaging.sendContextMessage(
		continuationPrompt(state, state.timeUsedSeconds),
		"followUp",
	);
}
