import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const JAVA_GRADLE: LanguageProfile = {
	id: "java-gradle",
	markers: ["build.gradle", "build.gradle.kts"],
	checks: [
		miseExec("compile", ["gradle", "--quiet", "compileJava"]),
		miseExec("build", ["gradle", "--quiet", "build", "-x", "test"]),
		miseExec("test", ["gradle", "--quiet", "test"]),
		miseExec("lint", ["gradle", "--quiet", "checkstyleMain"]),
	],
};

export const JAVA_MAVEN: LanguageProfile = {
	id: "java-maven",
	markers: ["pom.xml"],
	checks: [
		miseExec("compile", ["mvn", "-q", "compile"]),
		miseExec("build", ["mvn", "-q", "package", "-DskipTests"]),
		miseExec("test", ["mvn", "-q", "test"]),
		miseExec("lint", ["mvn", "-q", "checkstyle:check"]),
	],
};
