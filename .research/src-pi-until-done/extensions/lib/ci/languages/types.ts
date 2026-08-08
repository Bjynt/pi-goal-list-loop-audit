import type { CiCheck } from "../types";

export interface LanguageProfile {
	id: string;
	markers: readonly string[];
	/**
	 * If set, profile matches only when at least one marker file's contents
	 * match the pattern. Used to disambiguate shared-marker languages
	 * (e.g. Kotlin vs Java on `build.gradle*` or `pom.xml`).
	 */
	markerContentPattern?: RegExp;
	checks: readonly CiCheck[];
}
