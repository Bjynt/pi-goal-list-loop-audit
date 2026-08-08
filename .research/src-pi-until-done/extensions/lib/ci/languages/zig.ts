import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const ZIG: LanguageProfile = {
	id: "zig",
	markers: ["build.zig", "build.zig.zon"],
	checks: [
		miseExec("compile", ["zig", "build", "--summary", "all"]),
		miseExec("test", ["zig", "build", "test"]),
		miseExec("format", ["zig", "fmt", "--check", "."]),
	],
};
