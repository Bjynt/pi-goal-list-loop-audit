import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareVersions, GLLA_PACKAGE_NAME, updateCheckPath } from "./glla-version.js";

export { compareVersions, updateCheckPath };

/**
 * v0.38.44 (field 20260909_161057): a live session rendered the
 * pre-0.38.39 summary voice while the repo shipped 0.38.42 — nothing
 * visible told the session it runs old GLLA. Shipped fixes only reach
 * sessions that know they are stale, so the status line carries the
 * running version plus a nudge when the registry is ahead.
 *
 * Render discipline: the status/card render reads the sidecar cache ONLY
 * and never touches the network. A throttled fire-and-forget refresh
 * rides the command/lifecycle contact gate; failures (offline, slow
 * registry, missing npm) leave the old cache in place and never surface.
 */

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1_000;
export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export interface UpdateCheckCache {
  latest: string;
  checkedAt: number;
}

/** Read the cache; null when missing, unreadable, malformed, or future-dated. */
export function readUpdateCheck(cwd: string): UpdateCheckCache | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(updateCheckPath(cwd), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.latest !== "string" || !record.latest.trim()) return null;
    if (typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)) return null;
    if (record.checkedAt > Date.now() + 60_000) return null;
    return { latest: record.latest.trim(), checkedAt: record.checkedAt };
  } catch {
    return null;
  }
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { timeout: number },
) => { on(event: "close", listener: (code: number | null) => void): void; stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } };

/**
 * Throttled fire-and-forget refresh: returns immediately in every case.
 * Skips when the cache is within TTL; otherwise shells `npm view` with a
 * bounded timeout and rewrites the cache on success. Never throws — an
 * offline session simply keeps rendering without a nudge.
 */
export function refreshUpdateCheck(
  cwd: string,
  now = Date.now(),
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): void {
  try {
    const cached = readUpdateCheck(cwd);
    if (cached && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) return;
    const child = spawnFn("npm", ["view", GLLA_PACKAGE_NAME, "version"], { timeout: UPDATE_CHECK_TIMEOUT_MS });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > 256) out = out.slice(-256);
    });
    child.on("close", (code) => {
      try {
        if (code !== 0) return;
        const latest = out.trim().split(/\s+/).pop() ?? "";
        if (!latest) return;
        const dir = path.dirname(updateCheckPath(cwd));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(updateCheckPath(cwd), JSON.stringify({ latest, checkedAt: Date.now() }));
      } catch {
        // Cache write failure is invisible by design.
      }
    });
  } catch {
    // Spawn failure (no npm, no shell) is invisible by design.
  }
}

/** Numeric semver-ish compare: 1 when a > b, -1 when a < b, 0 when equal or unparseable. */
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

/**
 * The status-tail segment: `· v<running>` always (so the running
 * version is visible on every branch), plus `· update v<latest>
 * available` only when the cache proves the registry is ahead.
 * Empty string when the running version is unknown.
 */
export function buildVersionTail(running: string, latest: string | null): string {
  if (!running || running === "unknown") return "";
  const nudge = latest ? staleUpdateNudge(running, { latest, checkedAt: 0 }) : null;
  return `· v${running}${nudge ? ` · ${nudge}` : ""}`;
}

/** The nudge proper: null when there is nothing to say (no cache yet,
 * unparseable versions, or already current). "unknown" running versions
 * never nudge — a damaged manifest must not cry wolf. */
export function staleUpdateNudge(running: string, cached: UpdateCheckCache | null): string | null {
  if (!cached || running === "unknown") return null;
  if (compareVersions(cached.latest, running) > 0) return `update v${cached.latest} available`;
  return null;
}
