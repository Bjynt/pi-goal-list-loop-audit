/**
 * Helpers for routing every CLI invocation through mise.
 *
 * Pi philosophy: deterministic, inspectable. Mise gives us pinned tool
 * versions and idempotent task names — so every shell command Pi runs
 * (verifyCommand, ad-hoc bash, future hook execution) prefers `mise run`
 * for known tasks and falls back to `mise exec --` for raw binaries.
 */

const MISE_PREFIXES = ["mise ", "mise\t"] as const;

const startsWithMise = (cmd: string): boolean =>
	MISE_PREFIXES.some((p) => cmd.trimStart().toLowerCase().startsWith(p));

/**
 * Wrap a user-supplied shell command so it executes inside mise's managed
 * environment. If the command already begins with `mise …` we leave it alone
 * so users who already wrote `mise run X` or `mise exec -- X` don't get
 * double-wrapped. Otherwise we prepend `mise exec --` which loads the
 * project's mise.toml tools onto PATH for the duration of the command.
 */
export const routeThroughMise = (
	cmd: string | undefined,
): string | undefined => {
	if (!cmd) return cmd;
	if (startsWithMise(cmd)) return cmd;
	return `mise exec -- ${cmd}`;
};

export const isMiseCommand = (cmd: string | undefined): boolean =>
	cmd ? startsWithMise(cmd) : false;
