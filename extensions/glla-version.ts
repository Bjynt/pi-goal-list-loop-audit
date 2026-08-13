import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const GLLA_PACKAGE_NAME = "pi-goal-list-loop-audit";

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

export interface GllaVersionInfo {
  name: string;
  version: string;
}

/**
 * Read the installed package metadata instead of duplicating a release string
 * in the extension. This works for both a source checkout and an npm
 * installation because the extension and package.json share the package root.
 */
export function readGllaVersionInfo(): GllaVersionInfo {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const name = typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : GLLA_PACKAGE_NAME;
      const version = typeof record.version === "string" && record.version.trim()
        ? record.version.trim()
        : "unknown";
      return { name, version };
    }
  } catch {
    // A damaged/missing manifest must not make the command surface unusable.
  }
  return { name: GLLA_PACKAGE_NAME, version: "unknown" };
}

export function formatGllaVersion(info: GllaVersionInfo = readGllaVersionInfo()): string {
  return [
    `${info.name} v${info.version}`,
    "Installed package version.",
    `Compare with registry latest: npm view ${info.name} version`,
  ].join("\n");
}
