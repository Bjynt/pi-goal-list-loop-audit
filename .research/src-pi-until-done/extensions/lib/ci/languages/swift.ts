import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const SWIFT: LanguageProfile = {
	id: "swift",
	markers: ["Package.swift"],
	checks: [
		miseExec("compile", ["swift", "build", "--quiet"]),
		miseExec("test", ["swift", "test", "--quiet"]),
		miseExec("format", ["swift-format", "lint", "--recursive", "."]),
		miseExec("lint", ["swiftlint", "lint", "--quiet"]),
	],
};
