/**
 * 事件 2: turn_end（FR-6.7 ESC 守卫 + 递增）。
 *
 * FR-6.7 ESC 守卫：ctx.signal.aborted 时跳过递增（ESC 不算 goal turn）。
 * 正常路径：currentTurnIndex++ + updateWidget。
 *
 * 委托 service.applyEvent("turn_end")——它递增 currentTurnIndex 并返回
 * EventEffect[{kind:"updateWidget"}]。adapter 执行该 effect。
 *
 * 不 persist（与旧 index.ts 行为对齐——turn_end 只内存变更 + widget）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { updateWidget } from "../../projection/widget";
import { applyEvent } from "../../service";
import type { GoalSession } from "../../session";
import { buildPorts } from "../ports";

export async function handleTurnEnd(
	pi: ExtensionAPI,
	session: GoalSession,
	ctx: ExtensionContext,
): Promise<void> {
	if (!session.state) return;
	// FR-6.7 ESC 守卫
	if (ctx.signal?.aborted) return;

	const ports = buildPorts(pi, ctx);
	const effects = applyEvent(session, "turn_end", undefined, ports);
	// 执行 effects（updateWidget 等）
	for (const effect of effects) {
		if (effect.kind === "updateWidget") {
			updateWidget(session, ports.ui);
		}
	}
}
