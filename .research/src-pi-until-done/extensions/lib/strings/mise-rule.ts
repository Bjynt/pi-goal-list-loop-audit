/**
 * Mise-first CLI policy. Every shell command Pi runs goes through mise so:
 *   • tool versions match across dev/CI/agent (pinned in mise.toml + mise.lock),
 *   • environment variables are loaded consistently from mise config,
 *   • the same task names work whether the developer or Pi invokes them.
 *
 * The block is injected into the per-turn system prompt and the setup prompt.
 */
export const MISE_CLI_BLOCK = [
	"Mise-first CLI policy (HARD):",
	"  • For every shell invocation, prefer mise. Use `mise run <task>` if a task is defined for it (`mise tasks ls --json` to discover); otherwise wrap binaries with `mise exec -- <cmd>` so the project-pinned tool version is used.",
	"  • Do NOT call raw binaries (`tsc`, `bun test`, `cargo check`, `swift build`, etc.) directly — mise wraps them so versions stay pinned to mise.toml + mise.lock.",
	"  • The verifyCommand has already been auto-wrapped with `mise exec --` if it was not already a mise command. Quote its real output as evidence.",
	"  • If a tool is missing, add it via `mise use <tool>@<version>` — do NOT install via brew/apt/curl-bash. Mise owns tool installs.",
	"  • Project automation goes in mise.toml as tasks. Do NOT add `package.json` `scripts`.",
	"  • For long-running watchers or repeat runs on file change, prefer `mise watch <task>` over hand-rolled loops.",
].join("\n");
