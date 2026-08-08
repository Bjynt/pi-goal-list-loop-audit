import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const ELIXIR: LanguageProfile = {
	id: "elixir",
	markers: ["mix.exs"],
	checks: [
		miseExec("typecheck", ["mix", "dialyzer", "--quiet"]),
		miseExec("lint", ["mix", "credo", "--strict"]),
		miseExec("format", ["mix", "format", "--check-formatted"]),
		miseExec("compile", ["mix", "compile", "--warnings-as-errors"]),
		miseExec("test", ["mix", "test"]),
	],
};

export const ERLANG: LanguageProfile = {
	id: "erlang",
	markers: ["rebar.config", "rebar.lock"],
	checks: [
		miseExec("compile", ["rebar3", "compile"]),
		miseExec("typecheck", ["rebar3", "dialyzer"]),
		miseExec("test", ["rebar3", "eunit"]),
	],
};
