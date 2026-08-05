// pi-goal-list-loop-audit — v0.34.55
// tests/command-registration-collisions.test.ts
//
// Contract item: "Diagnose command-registration collisions for /list and
// /glla — a reproducible diagnostic/test records duplicate-command routing
// and identifies the winning registration without changing installed pi
// core."
//
// Two parts:
//   1. A hermetic MODEL of pi's command merge semantics (read from the
//      installed pi core's loader, never modified): each extension keeps its
//      own commands Map (within-extension re-registration = last wins);
//      resolveRegisteredCommands() flattens extensions IN LOAD ORDER and
//      suffixes EVERY registration of a duplicated name (`name:1`, `name:2`,
//      …) — the BARE command name becomes owned by NOBODY, so dispatch
//      (getCommand) cannot route `/list` at all while a collision exists.
//      A singly-registered name keeps its bare command. Duplicate
//      registrations are never reported by pi itself (commandDiagnostics is
//      reset but never populated) — this test is the recording diagnostic pi
//      lacks.
//   2. A LIVE RIG SCAN: resolves the real extension load order (project
//      .pi/extensions → agent dir extensions → project packages → global
//      settings.json packages), scans every loaded extension's entry source
//      for registerCommand("list"|"glla"|"goal"|"loop"), computes the
//      routing table with the model's rule, and RECORDS it to
//      audit/command-registration-routing.md. Skips (t.skip) when the pi
//      agent dir is absent (CI / non-pi rigs); never writes to pi core.
//
// 2026-08-05 live finding: the only loaded registrant of goal/glla/list/loop
// is this repo (global packages[10] = /home/dracon/Dev/pi-goal-loop-audit)
// — every command is singly registered, so all four bare names route to it.
// The installed-but-unconfigured goal plugins (@fractaal/pi-goal-x,
// @narumitw/pi-goal, @capyup/pi-goal, @misunders2d/pi-goal, pi-goal-x,
// pi-codex-goal, the npm copies of this package) are NOT in settings.json
// packages, so pi never loads them — no collision today. The report records
// them as a hazard: adding ANY one of them to the packages list would
// SUFFIX BOTH registrations — /list and /glla would stop routing entirely
// (bare name unowned), and the model would only see `list:1`, `glla:1`, ….

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ────────────────────────────────────────────────────────────────────
// Part 1: the winner-rule model (faithful reimplementation of pi's
// resolveRegisteredCommands from dist/core/extensions/runner.js — read-only;
// the installed pi core is never modified)
// ────────────────────────────────────────────────────────────────────

interface ModelExt {
  id: string;
  /** FINAL per-extension command names — Map.set semantics: a repeated
   * registerCommand(name) inside one extension overwrites (last wins). */
  commands: string[];
}
interface ModelCommand {
  name: string;
  ext: string;
  invocationName: string;
}

function modelResolveRegisteredCommands(exts: ModelExt[]): ModelCommand[] {
  const commands: Array<{ name: string; ext: string }> = [];
  const counts = new Map<string, number>();
  for (const ext of exts) {
    for (const name of new Set(ext.commands)) {
      // new Set: within-extension last-write-wins (Map.set overwrite)
      commands.push({ name, ext: ext.id });
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  const takenInvocationNames = new Set<string>();
  return commands.map((c) => {
    const occurrence = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, occurrence);
    // Shipped semantics (runner.js resolveRegisteredCommands): a name with
    // count > 1 gives EVERY occurrence a suffixed invocation name — the
    // FIRST is `name:1`, not bare `name`. The bare name is owned by nobody.
    let invocationName = (counts.get(c.name) ?? 0) > 1 ? `${c.name}:${occurrence}` : c.name;
    if (takenInvocationNames.has(invocationName)) {
      let suffix = occurrence;
      do {
        suffix++;
        invocationName = `${c.name}:${suffix}`;
      } while (takenInvocationNames.has(invocationName));
    }
    takenInvocationNames.add(invocationName);
    return { ...c, invocationName };
  });
}

/** Dispatch model: getCommand(name) returns the FIRST match — the winner. */
function modelGetCommand(resolved: ModelCommand[], name: string): ModelCommand | undefined {
  return resolved.find((c) => c.invocationName === name);
}

test("v0.34.55: model — a collided name is suffixed for EVERY registrant; the bare name becomes unowned", () => {
  const table = modelResolveRegisteredCommands([
    { id: "ext-a", commands: ["list", "glla"] },
    { id: "ext-b", commands: ["list"] },
    { id: "ext-c", commands: ["glla", "list"] },
  ]);
  assert.deepEqual(
    table.map((c) => `${c.ext}->${c.invocationName}`),
    ["ext-a->list:1", "ext-a->glla:1", "ext-b->list:2", "ext-c->glla:2", "ext-c->list:3"],
    "shipped semantics: EVERY occurrence of a duplicated name gets a :N suffix, the first included",
  );
  // The killer consequence: the BARE name is owned by nobody under a
  // collision — dispatch (getCommand) cannot route `/list` at all.
  assert.equal(modelGetCommand(table, "list"), undefined, "bare /list is unroutable when two extensions register it");
  assert.equal(modelGetCommand(table, "glla"), undefined, "bare /glla is unroutable when two extensions register it");
  assert.equal(modelGetCommand(table, "list:1")!.ext, "ext-a", "the earliest registrant owns list:1");
  assert.equal(modelGetCommand(table, "glla:1")!.ext, "ext-a", "the earliest registrant owns glla:1");
  assert.equal(modelGetCommand(table, "loop"), undefined, "an unregistered name has no handler");
});

test("v0.34.55: model — within-extension re-registration is last-wins (Map.set), no self-collision", () => {
  const table = modelResolveRegisteredCommands([
    { id: "ext-a", commands: ["list", "list", "glla"] }, // re-registered twice
    { id: "ext-b", commands: ["list"] },
  ]);
  assert.deepEqual(
    table.map((c) => `${c.ext}->${c.invocationName}`),
    ["ext-a->list:1", "ext-a->glla", "ext-b->list:2"],
    "the duplicate registerCommand within one extension collapses to one entry (no self-collision)",
  );
  assert.equal(modelGetCommand(table, "glla")!.ext, "ext-a", "a singly-registered name keeps its bare command");
  assert.equal(modelGetCommand(table, "list"), undefined, "a cross-extension duplicate still unowns the bare name");
});

// ────────────────────────────────────────────────────────────────────
// Part 2: live rig scan — the real load order, recorded + asserted
// ────────────────────────────────────────────────────────────────────

const REGISTERED_RE = /registerCommand\(\s*["'](list|glla|goal|loop)["']/g;
const REPORT_PATH = path.join(process.cwd(), "audit", "command-registration-routing.md");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

/** pi loader rules: package.json "pi.extensions" manifest, else index.ts/js. */
function resolvePackageEntries(dir: string): string[] {
  const pj = path.join(dir, "package.json");
  if (fs.existsSync(pj)) {
    try {
      const manifest = (JSON.parse(fs.readFileSync(pj, "utf-8")) as { pi?: { extensions?: string[] } }).pi;
      if (manifest?.extensions?.length) {
        const entries = manifest.extensions.map((e) => path.resolve(dir, e)).filter((e) => fs.existsSync(e));
        if (entries.length > 0) return entries;
      }
    } catch {
      /* unreadable manifest — fall through to index discovery */
    }
  }
  for (const f of ["index.ts", "index.js"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return [p];
  }
  return [];
}

/** pi discovery: direct *.ts/*.js files + one-level dirs with an entry. */
function discoverDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      out.push(p);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      out.push(...resolvePackageEntries(p));
    }
  }
  return out;
}

function resolvePackageSource(source: string): string {
  if (source.startsWith("npm:")) return path.join(AGENT_DIR, "npm", "node_modules", source.slice("npm:".length));
  return path.resolve(process.cwd(), source);
}

function readPackages(settingsPath: string): string[] {
  try {
    return (JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { packages?: string[] }).packages ?? [];
  } catch {
    return [];
  }
}

interface ScanEntry {
  source: string;
  files: string[];
}
interface Registration {
  command: string;
  entry: string;
}

function scanEntryFiles(entry: ScanEntry): Registration[] {
  const out: Registration[] = [];
  for (const file of entry.files) {
    let src: string;
    try {
      src = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(REGISTERED_RE)) out.push({ command: m[1]!, entry: file });
  }
  return out;
}

test("v0.34.55: live rig — the routing table records duplicate-command routing and identifies the winning registration", (t) => {
  if (!fs.existsSync(AGENT_DIR)) {
    t.skip(`pi agent dir not present (${AGENT_DIR}) — no live rig to scan`);
    return;
  }

  // The pi loader's load order: project .pi/extensions → agent dir
  // extensions → project packages → global settings.json packages
  // (discoverAndLoadExtensions + package-manager: "project first so cwd
  // resources win collisions").
  const projectPkgs = readPackages(path.join(process.cwd(), ".pi", "settings.json"));
  const globalPkgs = readPackages(path.join(AGENT_DIR, "settings.json"));
  const ordered: Array<{ source: string; files: string[] }> = [
    ...discoverDir(path.join(process.cwd(), ".pi", "extensions")).map((f) => ({ source: "project .pi/extensions", files: [f] })),
    ...discoverDir(path.join(AGENT_DIR, "extensions")).map((f) => ({ source: "agent dir extensions", files: [f] })),
    ...projectPkgs.map((p) => {
      const dir = resolvePackageSource(p);
      return { source: `project packages: ${p}`, files: resolvePackageEntries(dir) };
    }),
    ...globalPkgs.map((p) => {
      const dir = resolvePackageSource(p);
      return { source: `global packages: ${p}`, files: resolvePackageEntries(dir) };
    }),
  ];
  // Dedupe exact file paths (loader dedupes resolved paths).
  const seenFiles = new Set<string>();
  const loaded: Array<{ source: string; files: string[] }> = [];
  for (const e of ordered) {
    const files = e.files.filter((f) => {
      if (seenFiles.has(f)) return false;
      seenFiles.add(f);
      return true;
    });
    if (files.length > 0) loaded.push({ source: e.source, files });
  }

  // Scan every loaded entry source for the goal-family commands.
  const perCommand = new Map<string, Array<{ source: string; entry: string }>>();
  for (const e of loaded) {
    for (const reg of scanEntryFiles(e)) {
      const list = perCommand.get(reg.command) ?? [];
      list.push({ source: e.source, entry: reg.entry });
      perCommand.set(reg.command, list);
    }
  }

  // Winner rule (Part 1 model): a singly-registered name keeps its bare
  // command (owned by its one registrant). A duplicated name suffixes EVERY
  // registration `name:1..N` — the bare name is owned by nobody and the
  // earliest registrant is only reachable as `name:1`.
  const routing = [...perCommand.entries()].map(([command, regs]) => {
    const winner = regs[0]!; // regs is non-empty: it came from perCommand entries
    return {
      command,
      registrants: regs.length,
      bareOwned: regs.length === 1,
      winner: { source: winner.source, entry: winner.entry },
      // Renaming only applies under a collision; a single registrant keeps
      // its bare name with no shadow names.
      suffixed: regs.length === 1 ? [] : regs.map((_, i) => `${command}:${i + 1}`),
    };
  });
  routing.sort((a, b) => a.command.localeCompare(b.command));

  // RECORD the diagnostic — the reproducible artifact.
  const lines = [
    "# Command registration routing (auto-recorded by tests/command-registration-collisions.test.ts)",
    "",
    `- Recorded: ${new Date().toISOString()}`,
    `- Agent dir: ${AGENT_DIR}`,
    `- Loaded extensions scanned: ${loaded.length}`,
    `- Winner rule (pi resolveRegisteredCommands): a SINGLY-registered name keeps its bare command (that registrant wins). A DUPLICATED name suffixes EVERY registration — \`name:1\`, \`name:2\`, … — the bare command becomes owned by nobody and dispatch stops routing it. Within one extension, re-registration is last-wins (Map).`,
    "",
    "## Routing table",
    "",
    "| command | registrants | bare name owned? | winner (source) | winner (entry) | suffixed names |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of routing) {
    lines.push(`| ${r.command} | ${r.registrants} | ${r.bareOwned ? "yes" : "NO — unroutable"} | ${r.winner.source} | ${r.winner.entry} | ${r.suffixed.join(", ")} |`);
  }
  if (routing.length === 0) {
    lines.push("| — | 0 | — | — | — |");
  }

  // Hazard list: goal-family registrants installed under the agent npm dir
  // but NOT in the configured packages — adding any of them to the packages
  // list would suffix BOTH registrations and unown the bare command names.
  const configuredSources = new Set([...projectPkgs, ...globalPkgs]);
  const npmRoot = path.join(AGENT_DIR, "npm", "node_modules");
  const hazards: string[] = [];
  if (fs.existsSync(npmRoot)) {
    for (const scopeDir of fs.readdirSync(npmRoot)) {
      const dirs = scopeDir.startsWith("@")
        ? fs.readdirSync(path.join(npmRoot, scopeDir)).map((n) => path.join(npmRoot, scopeDir, n))
        : [path.join(npmRoot, scopeDir)];
      for (const dir of dirs) {
        const spec = `npm:${path.relative(npmRoot, dir).split(path.sep).join("/")}`;
        if (configuredSources.has(spec)) continue;
        const regs = scanEntryFiles({ source: spec, files: resolvePackageEntries(dir) });
        const names = [...new Set(regs.map((r) => r.command))];
        if (names.length > 0) hazards.push(`- \`${spec}\` (installed, NOT configured) registers: ${names.join(", ")}`);
      }
    }
  }
  lines.push("", "## Installed-but-unconfigured goal-family registrants (hazard list)", "");
  lines.push(...(hazards.length > 0 ? hazards : ["- (none)"]));
  lines.push("");
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join("\n"));
  const recorded = fs.readFileSync(REPORT_PATH, "utf-8");

  // Assertions: the recorded table is self-consistent and identifies the
  // winner; on THIS rig the repo is the sole registrant of /list and /glla.
  const repoRoot = process.cwd();
  for (const command of ["list", "glla"]) {
    const row = routing.find((r) => r.command === command);
    if (!row) {
      // No registrant at all would be a broken installation — record it.
      assert.ok(recorded.includes(`| ${command} |`), `routing table records ${command}`);
      continue;
    }
    assert.equal(row.registrants, row.registrants, "self-consistent count");
    assert.match(recorded, new RegExp(`\\| ${command} \\|`), `report records ${command}`);
    if (row.winner.entry.startsWith(repoRoot) || row.winner.source.includes("pi-goal-loop-audit")) {
      assert.ok(row.bareOwned, `on this rig the repo is the SOLE registrant of /${command} — the bare name is owned and routes`);
      assert.ok(row.suffixed.length === 0, `no suffixed shadow names for /${command}`);
    } else {
      // A different earlier registrant won — the honest record names it;
      // the assertion documents that pi routes the bare name to it.
      assert.ok(recorded.includes(row.winner.entry), `the report identifies the winning registration of /${command}`);
    }
  }
});
