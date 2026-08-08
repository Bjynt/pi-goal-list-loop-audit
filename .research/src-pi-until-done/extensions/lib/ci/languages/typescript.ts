import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const TYPESCRIPT_BUN: LanguageProfile = {
	id: "typescript-bun",
	markers: ["bun.lock", "bun.lockb"],
	checks: [
		miseExec("typecheck", ["bun", "x", "tsc", "--noEmit"]),
		miseExec("lint", ["bun", "x", "biome", "check", "--reporter=summary"]),
		miseExec("format", ["bun", "x", "biome", "format", "--reporter=summary"]),
		miseExec("test", ["bun", "test"]),
		miseExec("build", ["bun", "x", "tsc", "--noEmit", "--pretty"]),
	],
};

export const NODE_PNPM: LanguageProfile = {
	id: "node-pnpm",
	markers: ["pnpm-lock.yaml"],
	checks: [
		miseExec("typecheck", ["pnpm", "exec", "tsc", "--noEmit"]),
		miseExec("lint", ["pnpm", "exec", "biome", "check", "--reporter=summary"]),
		miseExec("format", [
			"pnpm",
			"exec",
			"biome",
			"format",
			"--reporter=summary",
		]),
		miseExec("test", ["pnpm", "test"]),
		miseExec("build", ["pnpm", "run", "build"]),
	],
};

export const NODE_NPM: LanguageProfile = {
	id: "node-npm",
	markers: ["package-lock.json"],
	checks: [
		miseExec("typecheck", ["npx", "--no-install", "tsc", "--noEmit"]),
		miseExec("lint", [
			"npx",
			"--no-install",
			"biome",
			"check",
			"--reporter=summary",
		]),
		miseExec("format", [
			"npx",
			"--no-install",
			"biome",
			"format",
			"--reporter=summary",
		]),
		miseExec("test", ["npm", "test", "--silent"]),
		miseExec("build", ["npm", "run", "build", "--silent"]),
	],
};

export const NODE_YARN: LanguageProfile = {
	id: "node-yarn",
	markers: ["yarn.lock"],
	checks: [
		miseExec("typecheck", ["yarn", "exec", "--silent", "tsc", "--noEmit"]),
		miseExec("lint", [
			"yarn",
			"exec",
			"--silent",
			"biome",
			"check",
			"--reporter=summary",
		]),
		miseExec("format", [
			"yarn",
			"exec",
			"--silent",
			"biome",
			"format",
			"--reporter=summary",
		]),
		miseExec("test", ["yarn", "test", "--silent"]),
		miseExec("build", ["yarn", "build"]),
	],
};

export const DENO: LanguageProfile = {
	id: "deno",
	markers: ["deno.json", "deno.jsonc", "deno.lock"],
	checks: [
		miseExec("typecheck", ["deno", "check", "**/*.ts"]),
		miseExec("lint", ["deno", "lint"]),
		miseExec("format", ["deno", "fmt", "--check"]),
		miseExec("test", ["deno", "test", "--quiet"]),
	],
};
