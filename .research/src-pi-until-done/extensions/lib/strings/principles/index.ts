import { BOOTSTRAP_MANDATE_BLOCK } from "./bootstrap";
import { CAPABILITY_INJECTION_BLOCK } from "./capabilities";
import { DEFINITION_OF_DONE_BLOCK } from "./definition-of-done";
import { PERFORMANCE_MANDATE_BLOCK } from "./performance";
import { WORKING_STYLE_BLOCK } from "./working-style";

export {
	BOOTSTRAP_MANDATE_BLOCK,
	CAPABILITY_INJECTION_BLOCK,
	DEFINITION_OF_DONE_BLOCK,
	PERFORMANCE_MANDATE_BLOCK,
	WORKING_STYLE_BLOCK,
};

/**
 * Composite: every pi-config principle, ordered for prompt injection.
 * Bootstrap first (gate), then performance (always-on), then capabilities
 * (architectural), then DoD (terminal check), then working style (process).
 */
export const PI_CONFIG_PRINCIPLES = [
	BOOTSTRAP_MANDATE_BLOCK,
	"",
	PERFORMANCE_MANDATE_BLOCK,
	"",
	CAPABILITY_INJECTION_BLOCK,
	"",
	DEFINITION_OF_DONE_BLOCK,
	"",
	WORKING_STYLE_BLOCK,
].join("\n");
