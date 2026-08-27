// pi-goal-list-loop-audit — v0.24.6
// extensions/goal-loop-subagents.ts
//
// Subagent model inheritance fix (v0.24.6, Section I of the eager-continuation
// contract). pi-subagents v0.14.3's default Explore agent pins
// "anthropic/claude-haiku-4-5" (default-agents.ts:40). Its model resolution is
// explicit option > agent config > parent model (agent-runner.ts:720), so an
// Explore spawn NEVER inherits the session model — it silently routes to a
// different provider/model path. On rigs where the session model is
// local/alternative, an upstream pinned Explore can otherwise fail for
// reasons unrelated to the parent session.
//
// pi-subagents has no per-agent model setting (subagents.json covers
// concurrency/scope/etc., not models). Its supported override mechanism is
// user agent files: <agentDir>/agents/<Name>.md fully replaces the default
// config of the same name (custom-agents.ts + agent-types.ts overlay by
// exact key). A file that omits "model:" falls through to the parent model.
//
// This module manages the upstream pinned Explore.md plus glla's explicit
// read-only Designer.md role. It writes/updates/removes only files carrying
// its marker and according to glla settings, and NEVER touches a file it
// didn't write
// (marker frontmatter field). If tintinweb pins more defaults later, the
// drift test in tests/subagent-model-override.test.ts fails and prompts us
// to add embedded copies here.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Frontmatter marker identifying files this module wrote. Files without it
 * are user-owned: never modified, never deleted. */
export const SUBAGENT_MANAGED_MARKER = "pi-goal-list-loop-audit";

/** Default pi-subagents agents that pin a model. Today: only Explore
 * (anthropic/claude-haiku-4-5). Plan and general-purpose already inherit the
 * parent model. Guarded by the drift test. */
export const KNOWN_PINNED_DEFAULT_AGENTS = ["Explore"] as const;

/** Managed roles that should exist even when no model pin is configured. */
export const KNOWN_MANAGED_AGENT_NAMES = ["Explore", "Designer"] as const;

/** Strategy for subagent model selection. Default "inherit-parent": managed
 * override drops the model pin so subagents share the session model AND its
 * provider/model path. "agent-default": upstream behavior (Explore pins haiku). */
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
  /** "" means "all tools" (upstream omits builtinToolNames). */
  tools: string;
}

export const PLAN_DEFAULT_DESCRIPTION = "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.";

export const PLAN_DEFAULT_SYSTEM_PROMPT = `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools — attempting to edit files will fail.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations

# Output Format
- Use absolute file paths
- Do not use emojis
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`;

export const GENERAL_PURPOSE_DEFAULT_DESCRIPTION = "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.";

export const DESIGNER_DEFAULT_DESCRIPTION = "Read-only design specialist for turning an explicit design request into an architecture, affected-file map, risks, trade-offs, and a verification plan before implementation.";

export const DESIGNER_DEFAULT_SYSTEM_PROMPT = `# DESIGNER ROLE — READ-ONLY DESIGN CHECKPOINT
You are the Designer subagent. Do not edit, create, delete, or move files and do not run commands that change repository state.

For the assigned objective:
1. Inspect the relevant repository files and existing conventions.
2. Return a concise implementation design: current behavior, proposed shape, affected files, interfaces/data flow, risks, and concrete verification steps.
3. Call out assumptions and unresolved user decisions as explicit questions with a recommended default.
4. Prefer durable, maintainable fixes over cosmetic workarounds. The parent agent owns implementation and decides whether to apply the design.

Use only read, bash, grep, find, and ls. End with a short DESIGN CHECKPOINT summary the parent agent can turn into a task or plan.`;

/** Embedded copies keyed by agent name. Explore needs an entry for the
 * strategy-driven sync (KNOWN_PINNED_DEFAULT_AGENTS); Plan and
 * general-purpose entries exist so users can pin them per-type via
 * subagentModelOverrides (v0.25.6). */
const EMBEDDED_DEFAULTS: Record<string, EmbeddedAgentDefault> = {
  Explore: {
    description: EXPLORE_DEFAULT_DESCRIPTION,
    systemPrompt: EXPLORE_DEFAULT_SYSTEM_PROMPT,
    tools: EXPLORE_DEFAULT_TOOLS,
  },
  Plan: {
    description: PLAN_DEFAULT_DESCRIPTION,
    systemPrompt: PLAN_DEFAULT_SYSTEM_PROMPT,
    tools: EXPLORE_DEFAULT_TOOLS, // same read-only set upstream
  },
  "general-purpose": {
    description: GENERAL_PURPOSE_DEFAULT_DESCRIPTION,
    systemPrompt: "", // upstream: empty prompt, promptMode append
    tools: "", // upstream: all tools (builtinToolNames omitted)
  },
  Designer: {
    description: DESIGNER_DEFAULT_DESCRIPTION,
    systemPrompt: DESIGNER_DEFAULT_SYSTEM_PROMPT,
    tools: EXPLORE_DEFAULT_TOOLS,
  },
};

/** v0.25.6: agent types the user can pin per-type via
 * subagentModelOverrides (embedded defaults exist for each). */
export const OVERRIDABLE_AGENT_TYPES = Object.keys(EMBEDDED_DEFAULTS);

/** Default global agent dir (pi-subagents reads $PI_CODING_AGENT_DIR/agents,
 * default ~/.pi/agent/agents). Delegate to pi's runtime resolver so custom
 * `PI_CODING_AGENT_DIR` and future app-specific config-dir names stay aligned
 * with the host rather than being silently ignored by glla. */
export function defaultAgentDir(): string {
  return getAgentDir();
}

/** Build the override .md file content. With `model`, the pin is written;
 * without, the file falls through to the parent session model. */
export function buildAgentOverrideMd(name: string, model?: string): string {
  const def = EMBEDDED_DEFAULTS[name];
  if (!def) throw new Error(`no embedded default config for agent "${name}"`);
  const yamlDesc = "'" + def.description.replace(/'/g, "''") + "'";
  const lines = ["---", `description: ${yamlDesc}`];
  if (def.tools) lines.push(`tools: ${def.tools}`);
  lines.push(def.systemPrompt ? "prompt_mode: replace" : "prompt_mode: append");
  if (model) lines.push(`model: ${model}`);
  lines.push(
    `x-managed-by: ${SUBAGENT_MANAGED_MARKER}`,
    model
      ? `x-glla-note: model pinned to ${model} by glla subagentModelOverrides. Remove the file or change /glla subagent settings to inherit the session model.`
      : "x-glla-note: model pin removed (upstream default pins a fixed model) so this agent inherits the parent session model. Managed by glla — flip /glla subagent strategy to agent-default to restore upstream behavior.",
    "---",
    "",
    def.systemPrompt || "(no system-prompt override — upstream default is an empty append-mode prompt)",
    "",
  );
  return lines.join("\n");
}

function hasManagedMarker(content: string): boolean {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return !!frontmatter?.split(/\r?\n/).some((line) => line.trim() === `x-managed-by: ${SUBAGENT_MANAGED_MARKER}`);
}

export interface SubagentSyncResult {
  written: string[];
  removed: string[];
  /** Files left untouched because the user owns them (no marker). */
  skipped: Array<{ name: string } & { reason: string }>;
  /** v0.25.6: managed files that were expected (previously written) but
   * found missing or altered, and got re-written — surface these to the
   * user (external edit, pi update, or dracon-sync churn). */
  repaired: string[];
}

/** State file tracking what the last sync wrote (repair detection). */
export function subagentSyncStatePath(agentDir: string): string {
  return path.join(agentDir, "agents", ".glla-subagent-sync.json");
}

/** Sync <agentDir>/agents/<Name>.md with the desired state. Idempotent:
 * writes only when content differs. Never touches non-managed files. */
export function syncSubagentModelOverrides(opts: {
  agentDir: string;
  strategy: SubagentModelStrategy;
  overrides?: Record<string, string>;
}): SubagentSyncResult {
  const result: SubagentSyncResult = { written: [], removed: [], skipped: [], repaired: [] };
  const overrides = opts.overrides ?? {};
  // Keep the repair-state snapshot separate from this run's write events.
  // `result.written` is intentionally only the delta for user messaging; the
  // persisted state must contain every managed file that still exists so an
  // idempotent sync does not erase the evidence needed by the next repair.
  const managedNow = new Set<string>();
  // v0.25.6: load the previous sync state for repair detection — a file
  // we wrote before that is now MISSING or CONTENT-CHANGED was touched
  // externally; re-writing it is a repair the user should hear about.
  let prevWritten: string[] = [];
  try {
    const prev = JSON.parse(fs.readFileSync(subagentSyncStatePath(opts.agentDir), "utf-8"));
    if (Array.isArray(prev?.written)) prevWritten = prev.written.map(String);
  } catch {
    /* first sync or unreadable state */
  }
  const names = new Set<string>([...KNOWN_MANAGED_AGENT_NAMES, ...Object.keys(overrides)]);

  for (const name of names) {
    const overrideModel = overrides[name];
    if (overrideModel !== undefined && !EMBEDDED_DEFAULTS[name]) {
      result.skipped.push({
        name,
        reason: `no embedded default config for "${name}" — create ${name}.md manually (managed roles: ${KNOWN_MANAGED_AGENT_NAMES.join("/")})`,
      });
      continue;
    }
    const file = path.join(opts.agentDir, "agents", `${name}.md`);
    // The strategy-driven model-less write applies to upstream agents that
    // pin a model (Explore) and to glla's explicit Designer role. Plan and
    // general-purpose do not need a file unless the user pins them.
    const desired = overrideModel
      ? buildAgentOverrideMd(name, overrideModel)
      : ((opts.strategy === "inherit-parent" && (KNOWN_PINNED_DEFAULT_AGENTS as readonly string[]).includes(name))
        || name === "Designer")
        ? buildAgentOverrideMd(name)
        : undefined; // agent-default / no pin upstream + no override → file should be absent

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
    if (current === desired) {
      managedNow.add(name);
      continue; // idempotent no-op
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, desired);
    managedNow.add(name);
    result.written.push(name);
    if (prevWritten.includes(name)) result.repaired.push(name);
  }
  // Persist what we manage now (not only this run's write delta), best-effort.
  try {
    fs.mkdirSync(path.join(opts.agentDir, "agents"), { recursive: true });
    fs.writeFileSync(subagentSyncStatePath(opts.agentDir), JSON.stringify({ written: [...managedNow].sort(), at: new Date().toISOString() }));
  } catch {
    /* repair detection is best-effort */
  }
  return result;
}

/** v0.25.6: effective model for an agent type, for the headless settings
 * display. Per-type override wins; inherit-parent falls to the session
 * model; agent-default means upstream's own resolution (Explore's haiku
 * pin for Explore, session model for the others).
 * v0.34.115: subagentFallbacks[name] wins over per-type pin (the chain is
 * explicit and ordered) — only when the chain is empty do we fall through
 * to the legacy behavior. */
export function resolveEffectiveSubagentModel(
  name: string,
  settings: { subagentModelStrategy?: string; subagentModelOverrides?: Record<string, string>; subagentFallbacks?: Record<string, string[]> },
  sessionModel?: string,
): string {
  const chain = settings.subagentFallbacks?.[name];
  if (chain && chain.length > 0) {
    return `${chain.join(" → ")} (subagentFallbacks chain)`;
  }
  const pin = settings.subagentModelOverrides?.[name];
  if (pin) return `${pin} (per-type pin)`;
  if ((settings.subagentModelStrategy ?? "inherit-parent") === "inherit-parent") {
    return sessionModel ? `${sessionModel} (inherits session)` : "(session model)";
  }
  return name === "Explore" ? "anthropic/claude-haiku-4-5 (upstream pin)" : "(agent default)";
}

/** v0.34.115: pure helper — choose the model ref to write into the
 * subagent override .md given the configured chain, registry, and
 * forbidden list. Returns the FIRST ref in the chain that is not forbidden
 * and resolves against the registry. Used by syncSubagentModelOverrides
 * when the per-agent subagentFallbacks chain is set; falls through to the
 * legacy per-type pin / inherit-parent / agent-default behavior when the
 * chain is empty. */
export function resolveSubagentOverrideRef(
  name: string,
  chain: string[] | undefined,
  resolve: (ref: string) => unknown | undefined,
  isForbidden: (ref: string) => boolean,
): string | undefined {
  if (!chain || chain.length === 0) return undefined;
  for (const ref of chain) {
    if (isForbidden(ref)) continue;
    if (!resolve(ref)) continue;
    return ref;
  }
  return undefined;
}
