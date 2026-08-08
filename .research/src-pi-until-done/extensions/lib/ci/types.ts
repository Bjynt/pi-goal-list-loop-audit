export type CiVerb =
	| "typecheck"
	| "lint"
	| "format"
	| "compile"
	| "test"
	| "build";

export interface CiCheck {
	verb: CiVerb;
	argv: string[];
	timeoutMs: number;
}

export interface CiResult {
	verb: CiVerb;
	command: string;
	skipped: boolean;
	ok: boolean;
	exitCode: number | null;
	output: string;
	durationMs: number;
}

export interface CiSummary {
	results: CiResult[];
	failed: CiResult[];
	skipped: CiResult[];
	totalMs: number;
	hasFailure: boolean;
}
