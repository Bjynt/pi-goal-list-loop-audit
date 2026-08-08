/**
 * Structural constraints from pi-config that Pi must enforce on every line of
 * code it produces while pursuing a /until-done goal — regardless of the
 * programming language. These mirror the limits the extension itself adheres
 * to: ≤3 nesting depth, ≤30 LOC per construct, ≤200 LOC per file, single
 * responsibility per construct.
 *
 * The values here are exported as a single shared block so:
 *   • the `before_agent_start` system-prompt reminder injects them every turn,
 *   • the setup meta-prompt names them upfront,
 *   • the continuation tick repeats them so they never decay,
 *   • the `tool_call` policy gate can show them when it blocks an edit,
 * keeping the rules auditable and fixed at one source of truth.
 */

export const STRUCTURAL_CONSTRAINT_LIMITS = {
	maxNestingDepth: 3,
	maxLocPerConstruct: 30,
	maxLocPerFile: 200,
} as const;

const universalScopeLine =
	"These apply to EVERY programming language you write — TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Elixir, Erlang, Clojure, Scala, Haskell, OCaml, F#, Lua, R, Julia, Bash, Fish, PowerShell, SQL, HCL, YAML, JSON-with-logic, etc. No exceptions.";

const constructLine =
	"  • Each construct (function / method / class / module / block / closure / proc — whatever the language calls it) ≤ 30 LOC.";

const nestingLine =
	"  • Nesting depth ≤ 3 (counting any indented block: if / for / while / try / match / switch / with / nested function / lambda body / object-literal-with-logic).";

const fileLine = "  • Each file ≤ 200 LOC.";

const responsibilityLine =
	"  • Single responsibility per construct. Extract helpers when in doubt.";

const splitLine =
	"  • If a change would push a file or function past these limits, split it instead.";

export const STRUCTURAL_CONSTRAINTS_BLOCK = [
	"Structural constraints (HARD — apply to every file you write or edit, in every language):",
	universalScopeLine,
	nestingLine,
	constructLine,
	fileLine,
	responsibilityLine,
	splitLine,
].join("\n");
