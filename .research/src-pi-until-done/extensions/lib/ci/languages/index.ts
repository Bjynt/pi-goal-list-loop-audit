import { CPP_CMAKE, CPP_MAKE, CPP_MESON } from "./cpp";
import { DOTNET } from "./dotnet";
import { ELIXIR, ERLANG } from "./elixir";
import { GO } from "./go";
import { JAVA_GRADLE, JAVA_MAVEN } from "./java";
import { KOTLIN_GRADLE, KOTLIN_MAVEN } from "./kotlin";
import { LUA } from "./lua";
import { LUAU, ROBLOX } from "./luau";
import { PYTHON, PYTHON_UV } from "./python";
import { RUBY } from "./ruby";
import { RUST } from "./rust";
import { SWIFT } from "./swift";
import type { LanguageProfile } from "./types";
import {
	DENO,
	NODE_NPM,
	NODE_PNPM,
	NODE_YARN,
	TYPESCRIPT_BUN,
} from "./typescript";
import { ZIG } from "./zig";

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [
	SWIFT,
	CPP_CMAKE,
	CPP_MAKE,
	CPP_MESON,
	KOTLIN_GRADLE,
	JAVA_GRADLE,
	KOTLIN_MAVEN,
	JAVA_MAVEN,
	LUA,
	ROBLOX,
	LUAU,
	PYTHON_UV,
	PYTHON,
	GO,
	RUST,
	RUBY,
	ELIXIR,
	ERLANG,
	ZIG,
	TYPESCRIPT_BUN,
	NODE_PNPM,
	NODE_NPM,
	NODE_YARN,
	DENO,
	DOTNET,
];

export type { LanguageProfile } from "./types";
