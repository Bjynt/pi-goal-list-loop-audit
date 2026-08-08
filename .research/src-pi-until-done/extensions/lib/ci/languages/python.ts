import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const PYTHON: LanguageProfile = {
	id: "python",
	markers: [
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"Pipfile",
		"requirements.txt",
	],
	checks: [
		miseExec("typecheck", ["mypy", "--pretty", "."]),
		miseExec("lint", ["ruff", "check", "."]),
		miseExec("format", ["ruff", "format", "--check", "."]),
		miseExec("test", ["pytest", "-q"]),
	],
};

export const PYTHON_UV: LanguageProfile = {
	id: "python-uv",
	markers: ["uv.lock"],
	checks: [
		miseExec("typecheck", ["uv", "run", "mypy", "."]),
		miseExec("lint", ["uv", "run", "ruff", "check", "."]),
		miseExec("format", ["uv", "run", "ruff", "format", "--check", "."]),
		miseExec("test", ["uv", "run", "pytest", "-q"]),
	],
};
