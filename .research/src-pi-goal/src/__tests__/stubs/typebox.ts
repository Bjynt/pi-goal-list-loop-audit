/**
 * typebox stub for vitest — 只需要 Type.Object/String/Array/Number/Optional/StringEnum 等
 * 被 tool-handler.ts import 链拉入，测试中不实际调用 schema 验证
 */
export const Type = {
	Object: (_schema: unknown) => ({}),
	String: (_opts?: unknown) => ({}),
	Number: (_opts?: unknown) => ({}),
	Array: (_item: unknown, _opts?: unknown) => ([]),
	Optional: (_item: unknown) => ({}),
	Boolean: (_opts?: unknown) => ({}),
	// 跨扩展依赖（@zhushanwen/pi-pending-notifications 的 registerTool schema）需要：
	// Literal/Union 返回可序列化的 schema 对象即可（测试不校验 schema 语义）。
	Literal: (_value: unknown) => ({ type: "literal" }),
	Union: (_items: unknown[]) => ({ type: "union" }),
};

export type Static<_T> = Record<string, unknown>;
