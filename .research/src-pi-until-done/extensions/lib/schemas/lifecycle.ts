import { Type } from "typebox";
import { PhaseLiteral } from "./literals";
import { CoreSetFields, RuntimeSetFields, ShapeSetFields } from "./set-fields";

export { GoalTypeLiteral, SurfaceSchema } from "./set-fields";

export const SetParams = Type.Object({
	...CoreSetFields,
	...ShapeSetFields,
	...RuntimeSetFields,
});

export const CompleteParams = Type.Object({
	evidence: Type.String({
		description:
			"Concrete proof that done criteria are met. Reference files, commands, or quoted output.",
	}),
	summary: Type.Optional(
		Type.String({ description: "One-line summary the user will see." }),
	),
});

export const BlockParams = Type.Object({
	question: Type.String({
		description: "What you need from the user before continuing.",
	}),
	reason: Type.String({
		description: "Why you cannot make further progress autonomously.",
	}),
});

export const ProgressParams = Type.Object({
	note: Type.String({
		description:
			"One short sentence summarizing what just shipped this turn (e.g. 'auth tests now pass on Vitest').",
	}),
	phase: Type.Optional(PhaseLiteral),
});
