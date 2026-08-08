import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const DOTNET: LanguageProfile = {
	id: "dotnet",
	markers: ["global.json", "Directory.Build.props"],
	checks: [
		miseExec("compile", [
			"dotnet",
			"build",
			"--no-restore",
			"--nologo",
			"-v",
			"quiet",
		]),
		miseExec("format", [
			"dotnet",
			"format",
			"--verify-no-changes",
			"--no-restore",
		]),
		miseExec("test", [
			"dotnet",
			"test",
			"--no-build",
			"--nologo",
			"-v",
			"quiet",
		]),
		miseExec("build", ["dotnet", "build", "--nologo", "-v", "quiet"]),
	],
};
