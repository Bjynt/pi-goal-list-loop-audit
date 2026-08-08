/**
 * 事件 1: agent_start（adapters/event-handlers 层）。
 *
 * 委托 service.applyEvent("agent_start")。task 已移除，当前无副作用
 * （#7 注入 todo 进度后可能重填基线逻辑）。
 *
 * 无 ESC 守卫（agent_start 是 agent 开始时的信号，此时无 aborted 可能）。
 * 无 persist / updateWidget。
 */

import { applyEvent } from "../../service";
import type { GoalSession } from "../../session";

export async function handleAgentStart(session: GoalSession): Promise<void> {
	if (!session.state) return;
	applyEvent(session, "agent_start", undefined);
}
