import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const LUA: LanguageProfile = {
	id: "lua",
	markers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", "init.lua"],
	checks: [
		miseExec("lint", ["luacheck", "--no-color", "."]),
		miseExec("format", ["stylua", "--check", "."]),
		miseExec("test", ["busted"]),
		miseExec("typecheck", ["lua-language-server", "--check", "."]),
	],
};
