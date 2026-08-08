import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const CPP_CMAKE: LanguageProfile = {
	id: "cpp-cmake",
	markers: ["CMakeLists.txt"],
	checks: [
		miseExec("build", ["cmake", "--build", "build"]),
		miseExec("test", ["ctest", "--test-dir", "build", "--output-on-failure"]),
		miseExec("format", [
			"clang-format",
			"--dry-run",
			"--Werror",
			"--style=file",
		]),
		miseExec("lint", ["clang-tidy", "--quiet"]),
	],
};

export const CPP_MAKE: LanguageProfile = {
	id: "cpp-make",
	markers: ["Makefile", "GNUmakefile"],
	checks: [miseExec("build", ["make"]), miseExec("test", ["make", "test"])],
};

export const CPP_MESON: LanguageProfile = {
	id: "cpp-meson",
	markers: ["meson.build"],
	checks: [
		miseExec("build", ["meson", "compile", "-C", "build"]),
		miseExec("test", ["meson", "test", "-C", "build"]),
	],
};
