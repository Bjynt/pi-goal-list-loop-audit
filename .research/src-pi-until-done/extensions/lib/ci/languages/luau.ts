import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const LUAU: LanguageProfile = {
	id: "luau",
	markers: [".luaurc", "luau.toml"],
	checks: [
		miseExec("typecheck", ["luau-analyze", "--quiet", "."]),
		miseExec("lint", ["selene", "--quiet", "."]),
		miseExec("format", ["stylua", "--check", "."]),
	],
};

export const ROBLOX: LanguageProfile = {
	id: "roblox-luau",
	markers: ["default.project.json", "rojo.json", "wally.toml"],
	checks: [
		miseExec("build", [
			"rojo",
			"build",
			"default.project.json",
			"-o",
			"build.rbxlx",
		]),
		miseExec("typecheck", ["luau-analyze", "--quiet", "."]),
		miseExec("test", ["lune", "run", "tests"]),
	],
};
