import { CI_LABELS } from "../strings";
import type { CiResult, CiSummary } from "./types";

export const summarize = (results: CiResult[], totalMs: number): CiSummary => {
	const failed = results.filter((r) => !r.skipped && !r.ok);
	const skipped = results.filter((r) => r.skipped);
	return { results, failed, skipped, totalMs, hasFailure: failed.length > 0 };
};

const formatLine = (r: CiResult): string => {
	if (r.skipped) return CI_LABELS.skipped(r.verb);
	if (r.ok) return CI_LABELS.passed(r.verb, r.durationMs);
	return CI_LABELS.failed(r.verb, r.exitCode ?? "?", r.durationMs);
};

export const renderHeadline = (s: CiSummary): string => {
	const lines = s.results.map(formatLine);
	return [CI_LABELS.headline, ...lines, CI_LABELS.totalLine(s.totalMs)].join(
		"\n",
	);
};

export const renderFailureBlock = (s: CiSummary): string => {
	if (!s.hasFailure) return "";
	const blocks = s.failed.map((r) =>
		CI_LABELS.failureBlock(r.verb, r.command, r.durationMs, r.output),
	);
	return [renderHeadline(s), "", ...blocks].join("\n");
};
