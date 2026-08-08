/**
 * Goal 运行时组合状态类型 — engine 层共享类型定义
 *
 * 零 Pi 依赖。
 *
 * FR-6.2 修复：预警 flag 按 token/time 维度独立（4 个独立 flag），
 * 取代旧版 budgetWarning70Sent/budgetWarning90Sent 共享 flag。
 */

// ── Goal 状态枚举 ────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "time_limited"
	| "cancelled";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"time_limited",
	"cancelled",
]);

/**
 * 显式状态转换表（system-architecture §5）。终态映射空数组——不可逆。
 * transitionStatus 据此查表，非法转换 throw。新增状态时必须更新此表（forcing function）。
 */
export const VALID_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
	active: ["paused", "blocked", "complete", "budget_limited", "time_limited", "cancelled"],
	paused: ["active", "cancelled"],
	blocked: ["active", "cancelled"],
	complete: [],
	budget_limited: [],
	time_limited: [],
	cancelled: [],
};

// ── 预算配置 ────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number;
	timeBudgetMinutes?: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {};

// ── 运行时状态（也是持久化格式）─────────────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	/**
	 * 成功标准——如何验证 objective 已达成。与 objective 成对存储、注入、展示。
	 *
	 * 由 goal_control create 时 AI 自行推导（思考真实目标后定义可检查的完成条件），
	 * 非用户手写。complete 的 evidence 必须对照本字段验证。
	 *
	 * optional：旧持久化数据无此字段，向后兼容（deserialize 可选解析，prompt 缺失时省略段）。
	 */
	successCriteria?: string;
	/**
	 * AI 生成的短标识（kebab-case 风格），仅用于 widget 状态栏标题与 history。
	 * 不注入 prompt（prompt 仍读 objective，保证方向感）。
	 * 由 goal_control create 时 AI 提供；/goal 命令路径走提示词触发器由 AI toolcall 生成。
	 * optional：旧持久化数据无此字段，widget fallback 到 objective 截断。
	 */
	slug?: string;
	status: GoalStatus;
	tokensUsed: number;
	timeStartedAt: number;
	timeUsedSeconds: number;
	budget: BudgetConfig;
	lastProgressTurn: number;
	budgetLimitSteeringSent: boolean;
	objectiveUpdatedAt: number;
	lastBlockerReason: string | null;
	// FR-6.2: 4 个独立预警 flag
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	timeWarning70Sent: boolean;
	timeWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	completedAtTurnIndex?: number;
}
