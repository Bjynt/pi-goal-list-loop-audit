import { Type } from "typebox";
import {
	ContextRefSchema,
	PhaseLiteral,
	PrerequisiteSchema,
	TaskStatusLiteral,
} from "./literals";

const PatchSchema = Type.Object(
	{
		status: Type.Optional(TaskStatusLiteral),
		phase: Type.Optional(PhaseLiteral),
		prerequisites: Type.Optional(Type.Array(PrerequisiteSchema)),
		validationSteps: Type.Optional(Type.Array(Type.String())),
		ciCommands: Type.Optional(Type.Array(Type.String())),
		styleguideRules: Type.Optional(Type.Array(Type.String())),
		guardrails: Type.Optional(Type.Array(Type.String())),
		addLearning: Type.Optional(Type.String()),
		addGotcha: Type.Optional(Type.String()),
		addContext: Type.Optional(ContextRefSchema),
		notes: Type.Optional(Type.String()),
	},
	{
		description:
			"Partial update. Only fields you provide are touched. addLearning/addGotcha append; the array fields fully replace.",
	},
);

export const TaskUpdateParams = Type.Object({
	id: Type.String(),
	patch: PatchSchema,
});
