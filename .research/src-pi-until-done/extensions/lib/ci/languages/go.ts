import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const GO: LanguageProfile = {
	id: "go",
	markers: ["go.mod"],
	checks: [
		miseExec("typecheck", ["go", "vet", "./..."]),
		miseExec("lint", ["golangci-lint", "run", "./..."]),
		miseExec("format", ["gofmt", "-l", "."]),
		miseExec("compile", ["go", "build", "-o", "/dev/null", "./..."]),
		miseExec("test", ["go", "test", "-count=1", "./..."]),
		miseExec("build", ["go", "build", "./..."]),
	],
};
