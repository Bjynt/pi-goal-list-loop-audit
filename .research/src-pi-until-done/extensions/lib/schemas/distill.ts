import { Type } from "typebox";

export const DistillParams = Type.Object({
	prdMarkdown: Type.String({
		description:
			"PRD-shaped summary of the journey: problem statement, what shape the solution took (since exploratory goals discover this only by running), key learnings, gotchas to avoid on rebuild, surfaces that mattered, follow-up tasks. Pattern: turn the scrappy loop into a spec future Pi/humans can build cleanly from.",
	}),
});
