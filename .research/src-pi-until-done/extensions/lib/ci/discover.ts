import * as fs from "node:fs";
import * as path from "node:path";
import { miseRun } from "./factories";
import { LANGUAGE_PROFILES, type LanguageProfile } from "./languages";
import { fetchMiseTaskNames, matchedVerbs } from "./mise-tasks";
import type { CiCheck, CiVerb } from "./types";

interface DiscoveryCache {
	cwd: string;
	at: number;
	checks: readonly CiCheck[];
}

const CACHE_TTL_MS = 5_000;
let cache: DiscoveryCache | undefined;

const matchedMarkerPaths = (cwd: string, profile: LanguageProfile): string[] =>
	profile.markers.map((m) => path.join(cwd, m)).filter((p) => fs.existsSync(p));

const anyMarkerContentMatches = (paths: string[], pattern: RegExp): boolean => {
	for (const p of paths) {
		try {
			const content = fs.readFileSync(p, "utf8");
			if (pattern.test(content)) return true;
		} catch {
			// unreadable files don't satisfy the pattern
		}
	}
	return false;
};

const profileMatches = (cwd: string, profile: LanguageProfile): boolean => {
	const matched = matchedMarkerPaths(cwd, profile);
	if (matched.length === 0) return false;
	if (!profile.markerContentPattern) return true;
	return anyMarkerContentMatches(matched, profile.markerContentPattern);
};

const detectProfiles = (cwd: string): LanguageProfile[] =>
	LANGUAGE_PROFILES.filter((p) => profileMatches(cwd, p));

const addMiseTaskChecks = (
	byVerb: Map<CiVerb, CiCheck>,
	verbs: CiVerb[],
): void => {
	for (const verb of verbs) {
		if (!byVerb.has(verb)) byVerb.set(verb, miseRun(verb));
	}
};

const addProfileChecks = (
	byVerb: Map<CiVerb, CiCheck>,
	profiles: LanguageProfile[],
): void => {
	for (const profile of profiles) {
		for (const c of profile.checks) {
			if (!byVerb.has(c.verb)) byVerb.set(c.verb, c);
		}
	}
};

const buildChecks = async (cwd: string): Promise<readonly CiCheck[]> => {
	const byVerb = new Map<CiVerb, CiCheck>();
	const taskNames = await fetchMiseTaskNames(cwd);
	addMiseTaskChecks(byVerb, matchedVerbs(taskNames));
	addProfileChecks(byVerb, detectProfiles(cwd));
	return [...byVerb.values()];
};

export const discoverChecks = async (
	cwd: string,
): Promise<readonly CiCheck[]> => {
	if (cache && cache.cwd === cwd && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.checks;
	}
	const checks = await buildChecks(cwd);
	cache = { cwd, at: Date.now(), checks };
	return checks;
};

export const invalidateDiscoveryCache = (): void => {
	cache = undefined;
};
