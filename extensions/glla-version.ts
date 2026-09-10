import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const GLLA_PACKAGE_NAME = "pi-goal-list-loop-audit";

/** Sidecar path shared with the update check (kept here so both
 * glla-version and glla-update-check resolve it without a cycle). */
export function updateCheckPath(cwd: string): string {
  return path.join(cwd, ".pi-glla", "update-check.json");
}

/** Numeric semver-ish compare: 1 when a > b, -1 when a < b, 0 when equal
 * or unparseable. Pure — shared by the version command and the nudge. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.trim().replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

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

export function formatGllaVersion(cwd?: string, info: GllaVersionInfo = readGllaVersionInfo()): string {
  const lines = [
    `${info.name} v${info.version}`,
    "Installed package version.",
    `Compare with registry latest: npm view ${info.name} version`,
  ];
  // v0.38.44 (field 20260909_161057): when the update sidecar has a
  // cached registry latest, say whether this session is stale and how
  // to fix it. No cache (offline / never checked) keeps the legacy
  // three lines — absence of evidence is not evidence of freshness.
  if (cwd) {
    try {
      const cached = readUpdateCheckLocal(cwd);
      if (cached) {
        lines.push(`Registry latest: v${cached.latest}.`);
        lines.push(
          compareLocal(cached.latest, info.version) > 0
            ? `This session is stale — update: pi install npm:${info.name}@latest then /reload.`
            : "This session is up to date.",
        );
      }
    } catch {
      // Sidecar read failure keeps the legacy output.
    }
  }
  return lines.join("\n");
}
