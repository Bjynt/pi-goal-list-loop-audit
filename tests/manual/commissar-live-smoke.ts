/**
 * Live smoke: fire ONE real detached commissar check against a seeded goal
 * using the production transport + real provider. Run manually:
 *   GLLA_GLOBAL_SETTINGS_PATH=... bun tests/manual/commissar-live-smoke.ts <cwd>
 */
import * as fs from "node:fs";
import { state } from "../../extensions/goal-state.js";
import { maybeFireCommissarCheck } from "../../extensions/goal-commissar-hooks.js";

const cwd = process.argv[2];
if (!cwd) {
  console.error("usage: bun tests/manual/commissar-live-smoke.ts <cwd>");
  process.exit(1);
}

// Rehydrate like the orchestrator does: read the ledger's last state line.
const lines = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8").trim().split("\n");
for (const line of lines) {
  const e = JSON.parse(line);
  if (e.type === "state") Object.assign(state, e.value);
}
if (!state.goal) throw new Error("no seeded goal");

let settled = false;
const fired = maybeFireCommissarCheck(
  { cwd } as never,
  {},
);
console.log("commissar fired:", fired);
if (!fired) process.exit(2);

// Poll the ledger for the verdict event.
const deadline = Date.now() + 240_000;
const poll = setInterval(() => {
  const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf8");
  const events = ledger.trim().split("\n").map((l) => JSON.parse(l));
  const verdict = events.filter((e) => e.type === "commissar_verdict").at(-1);
  const infra = events.filter((e) => e.type === "commissar_infra" || e.type === "commissar_check_start");
  if (verdict) {
    console.log("VERDICT:", JSON.stringify(verdict.value));
    settled = true;
  }
  if (Date.now() > deadline && !settled) {
    console.log("TIMEOUT — last events:", JSON.stringify(infra.at(-1)?.value ?? null));
    settled = true;
  }
  if (settled) {
    clearInterval(poll);
    process.exit(0);
  }
}, 2000);
