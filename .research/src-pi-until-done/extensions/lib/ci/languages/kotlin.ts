import { miseExec } from "../factories";
import type { LanguageProfile } from "./types";

export const KOTLIN_GRADLE: LanguageProfile = {
	id: "kotlin-gradle",
	markers: [
		"build.gradle.kts",
		"build.gradle",
		"settings.gradle.kts",
		"settings.gradle",
	],
	markerContentPattern:
		/kotlin\(\s*["']jvm["']\s*\)|apply\s+plugin:\s*["']kotlin|org\.jetbrains\.kotlin/i,
	checks: [
		miseExec("compile", ["gradle", "--quiet", "compileKotlin"]),
		miseExec("build", ["gradle", "--quiet", "assemble"]),
		miseExec("test", ["gradle", "--quiet", "test"]),
		miseExec("lint", ["gradle", "--quiet", "detekt"]),
		miseExec("format", ["ktlint", "--reporter=plain", "--relative"]),
	],
};

export const KOTLIN_MAVEN: LanguageProfile = {
	id: "kotlin-maven",
	markers: ["pom.xml"],
	markerContentPattern: /kotlin-maven-plugin|kotlin-stdlib/i,
	checks: [
		miseExec("compile", ["mvn", "-q", "compile"]),
		miseExec("build", ["mvn", "-q", "package", "-DskipTests"]),
		miseExec("test", ["mvn", "-q", "test"]),
		miseExec("lint", ["mvn", "-q", "antrun:run@ktlint"]),
	],
};
