import { Type } from "typebox";
import {
	TaskGraphFields,
	TaskIdentityFields,
	TaskJournalFields,
	TaskRulesFields,
} from "./task-fields";

export const TaskSchema = Type.Object({
	...TaskIdentityFields,
	...TaskGraphFields,
	...TaskRulesFields,
	...TaskJournalFields,
});
