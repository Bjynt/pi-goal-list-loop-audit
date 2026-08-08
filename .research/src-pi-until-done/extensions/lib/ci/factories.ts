import type { CiCheck, CiVerb } from "./types";

const SECOND = 1000;

export const TIMEOUTS: Record<CiVerb, number> = {
	typecheck: 30 * SECOND,
	lint: 20 * SECOND,
	format: 15 * SECOND,
	compile: 60 * SECOND,
	test: 120 * SECOND,
	build: 180 * SECOND,
};

export const miseRun = (verb: CiVerb): CiCheck => ({
	verb,
	argv: ["mise", "run", verb],
	timeoutMs: TIMEOUTS[verb],
});

export const miseExec = (verb: CiVerb, cmd: readonly string[]): CiCheck => ({
	verb,
	argv: ["mise", "exec", "--", ...cmd],
	timeoutMs: TIMEOUTS[verb],
});
