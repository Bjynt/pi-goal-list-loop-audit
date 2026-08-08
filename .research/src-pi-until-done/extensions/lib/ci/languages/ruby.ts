import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const RUBY: LanguageProfile = {
	id: "ruby",
	markers: ["Gemfile", ".ruby-version", "Rakefile"],
	checks: [
		miseExec("typecheck", ["srb", "tc"]),
		miseExec("lint", ["bundle", "exec", "rubocop", "--no-color"]),
		miseExec("format", ["bundle", "exec", "rubocop", "--no-color", "--lint"]),
		miseExec("test", ["bundle", "exec", "rake", "test"]),
	],
};
