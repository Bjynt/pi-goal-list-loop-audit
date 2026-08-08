interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

export const ok = (
	text: string,
	details: Record<string, unknown> = {},
): ToolResult => ({
	content: [{ type: "text", text }],
	details: { ok: true, ...details },
});

export const refused = (text: string, reason: string): ToolResult => ({
	content: [{ type: "text", text: `Refused: ${text}` }],
	details: { ok: false, reason },
	isError: true,
});

export const failed = (text: string, reason: string): ToolResult => ({
	content: [{ type: "text", text }],
	details: { ok: false, reason },
	isError: true,
});
