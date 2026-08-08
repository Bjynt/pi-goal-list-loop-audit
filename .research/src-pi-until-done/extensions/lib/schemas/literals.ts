import { Type } from "typebox";

export const PhaseLiteral = Type.Union(
	[
		Type.Literal("analysis"),
		Type.Literal("bootstrap"),
		Type.Literal("red"),
		Type.Literal("green"),
		Type.Literal("refactor"),
		Type.Literal("cleanup"),
		Type.Literal("none"),
	],
	{ description: "TDD phase" },
);

export const TaskStatusLiteral = Type.Union(
	[
		Type.Literal("pending"),
		Type.Literal("in_progress"),
		Type.Literal("done"),
		Type.Literal("blocked"),
		Type.Literal("skipped"),
	],
	{ description: "Task lifecycle status" },
);

export const ContextRefSchema = Type.Object({
	path: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	why: Type.String(),
});

export const PrerequisiteSchema = Type.Object({
	description: Type.String(),
	cleared: Type.Boolean(),
});
