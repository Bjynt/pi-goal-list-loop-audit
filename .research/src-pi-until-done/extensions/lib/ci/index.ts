import { discoverChecks } from "./discover";
import { runAll } from "./runner";
import { summarize } from "./summarize";
import type { CiSummary } from "./types";

export { invalidateDiscoveryCache } from "./discover";
export { renderFailureBlock, renderHeadline } from "./summarize";
export type { CiResult, CiSummary, CiVerb } from "./types";

export const runCi = async (
	cwd: string,
	signal?: AbortSignal,
): Promise<CiSummary> => {
	const started = Date.now();
	const checks = await discoverChecks(cwd);
	if (checks.length === 0) return summarize([], Date.now() - started);
	const results = await runAll(checks, cwd, signal);
	return summarize(results, Date.now() - started);
};
