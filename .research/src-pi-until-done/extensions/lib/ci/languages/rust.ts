import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const RUST: LanguageProfile = {
	id: "rust",
	markers: ["Cargo.toml"],
	checks: [
		miseExec("typecheck", ["cargo", "check", "--quiet", "--all-targets"]),
		miseExec("lint", [
			"cargo",
			"clippy",
			"--quiet",
			"--all-targets",
			"--",
			"-D",
			"warnings",
		]),
		miseExec("format", ["cargo", "fmt", "--check"]),
		miseExec("compile", ["cargo", "check", "--quiet"]),
		miseExec("test", ["cargo", "test", "--quiet"]),
		miseExec("build", ["cargo", "build", "--quiet", "--release"]),
	],
};
