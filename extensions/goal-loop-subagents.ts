// pi-goal-list-loop-audit — v0.24.6
// extensions/goal-loop-subagents.ts
//
// Subagent model inheritance fix (v0.24.6, Section I of the eager-continuation
// contract). pi-subagents v0.14.3's default Explore agent pins
// "anthropic/claude-haiku-4-5" (default-agents.ts:40). Its model resolution is
// explicit option > agent config > parent model (agent-runner.ts:720), so an
// Explore spawn NEVER inherits the session model — it silently routes to a
// different provider with a different quota pool. On rigs where the session
// model is local/alternative (e.g. MiniMax-M3) and claude-haiku-4-5 resolves
// through a quota-capped key (OpenRouter), three concurrent Explore spawns
// exhaust the key with 403 "Key limit exceeded" while the parent session is
// unaffected.
//
// pi-subagents has no per-agent model setting (subagents.json covers
// concurrency/scope/etc., not models). Its supported override mechanism is
// user agent files: <agentDir>/agents/<Name>.md fully replaces the default
// config of the same name (custom-agents.ts + agent-types.ts overlay by
// exact key). A file that omits "model:" falls through to the parent model.
//
// This module manages exactly one override file — Explore.md — the only
// default agent with a model pin today. It writes/updates/removes the file
// according to glla settings, and NEVER touches a file it didn't write
// (marker frontmatter field). If tintinweb pins more defaults later, the
// drift test in tests/subagent-model-override.test.ts fails and prompts us
// to add embedded copies here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Frontmatter marker identifying files this module wrote. Files without it
 * are user-owned: never modified, never deleted. */
export const SUBAGENT_MANAGED_MARKER = "pi-goal-list-loop-audit";

/** Default pi-subagents agents that pin a model. Today: only Explore
 * (anthropic/claude-haiku-4-5). Plan and general-purpose already inherit the
 * parent model. Guarded by the drift test. */
export const KNOWN_PINNED_DEFAULT_AGENTS = ["Explore"] as const;

/** Strategy for subagent model selection. Default "inherit-parent": managed
 * override drops the model pin so subagents share the session model AND its
 * quota pool. "agent-default": upstream behavior (Explore pins haiku). */
export type SubagentModelStrategy = "inherit-parent" | "agent-default";

// ---- Embedded default-agent copies (verbatim from pi-subagents v0.14.3
// src/default-agents.ts; drift-tested against the installed package) ----

export const EXPLORE_DEFAULT_DESCRIPTION = "Fast read-only search agent for locating code. Use it to find files by pattern (eg. \"src/components/**/*.tsx\"), grep for symbols or keywords (eg. \"API endpoints\"), or answer \"where is X defined / which files reference Y.\" Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis \u2014 it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, or \"very thorough\" to search across multiple locations and naming conventions.";

export const EXPLORE_DEFAULT_SYSTEM_PROMPT = `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`;

export const EXPLORE_DEFAULT_TOOLS = "read, bash, grep, find, ls";

interface EmbeddedAgentDefault {
  description: string;
  systemPrompt: string;
  tools: string;
}

/** Embedded copies keyed by agent name. Only agents in
 * KNOWN_PINNED_DEFAULT_AGENTS need entries. */
const EMBEDDED_DEFAULTS: Record<string, EmbeddedAgentDefault> = {
  Explore: {
    description: EXPLORE_DEFAULT_DESCRIPTION,
    systemPrompt: EXPLORE_DEFAULT_SYSTEM_PROMPT,
    tools: EXPLORE_DEFAULT_TOOLS,
  },
};

/** Default global agent dir (pi-subagents reads $PI_CODING_AGENT_DIR/agents,
 * default ~/.pi/agent/agents). Parameterized in sync for tests. */
export function defaultAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/** Build the override .md file content. With `model`, the pin is written;
 * without, the file falls through to the parent session model. */
export function buildAgentOverrideMd(name: string, model?: string): string {
  const def = EMBEDDED_DEFAULTS[name];
  if (!def) throw new Error(`no embedded default config for agent "${name}"`);
  const yamlDesc = "'" + def.description.replace(/'/g, "''") + "'";
  const lines = [
    "---",
    `description: ${yamlDesc}`,
    `tools: ${def.tools}`,
    "prompt_mode: replace",
  ];
  if (model) lines.push(`model: ${model}`);
  lines.push(
    `x-managed-by: ${SUBAGENT_MANAGED_MARKER}`,
    model
      ? `x-glla-note: model pinned to ${model} by glla subagentModelOverrides. Remove the file or change /glla subagent settings to inherit the session model.`
      : "x-glla-note: model pin removed (upstream default pins a fixed model) so this agent inherits the parent session model and its quota pool. Managed by glla — flip /glla subagent strategy to agent-default to restore upstream behavior.",
    "---",
    "",
    def.systemPrompt,
    "",
  );
  return lines.join("\n");
}

function hasManagedMarker(content: string): boolean {
  return content.includes(`x-managed-by: ${SUBAGENT_MANAGED_MARKER}`);
}

export interface SubagentSyncResult {
  written: string[];
  removed: string[];
  /** Files left untouched because the user owns them (no marker). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Sync <agentDir>/agents/<Name>.md with the desired state. Idempotent:
 * writes only when content differs. Never touches non-managed files. */
export function syncSubagentModelOverrides(opts: {
  agentDir: string;
  strategy: SubagentModelStrategy;
  overrides?: Record<string, string>;
}): SubagentSyncResult {
  const result: SubagentSyncResult = { written: [], removed: [], skipped: [] };
  const overrides = opts.overrides ?? {};
  const names = new Set<string>([...KNOWN_PINNED_DEFAULT_AGENTS, ...Object.keys(overrides)]);

  for (const name of names) {
    const overrideModel = overrides[name];
    if (overrideModel !== undefined && !EMBEDDED_DEFAULTS[name]) {
      result.skipped.push({
        name,
        reason: `no embedded default config for "${name}" — create ${name}.md manually (only ${KNOWN_PINNED_DEFAULT_AGENTS.join("/")} are glla-managed)`,
      });
      continue;
    }
    const file = path.join(opts.agentDir, "agents", `${name}.md`);
    const desired = overrideModel
      ? buildAgentOverrideMd(name, overrideModel)
      : opts.strategy === "inherit-parent"
        ? buildAgentOverrideMd(name)
        : undefined; // agent-default + no per-type override → file should be absent

    const exists = fs.existsSync(file);
    const current = exists ? fs.readFileSync(file, "utf-8") : undefined;

    if (desired === undefined) {
      if (exists && hasManagedMarker(current!)) {
        fs.unlinkSync(file);
        result.removed.push(name);
      } else if (exists) {
        result.skipped.push({ name, reason: "user-owned file (no glla marker) — left untouched" });
      }
      continue;
    }

    if (exists && !hasManagedMarker(current!)) {
      result.skipped.push({ name, reason: "user-owned file (no glla marker) — left untouched" });
      continue;
    }
    if (current === desired) continue; // idempotent no-op
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, desired);
    result.written.push(name);
  }
  return result;
}
