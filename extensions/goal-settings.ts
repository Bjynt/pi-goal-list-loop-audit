// pi-goal-list-loop-audit — v0.25.0
// extensions/goal-settings.ts
//
// The settings layer, extracted from loops/goal.ts so tests can drive it
// without importing the whole extension. Two-tier config (v0.7.0): GLOBAL
// is the normal home, PROJECT the rare local override. Resolution:
// project > global > defaults (per key).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_FORBIDDEN_MODELS,
  DEFAULT_QUOTA_RETRY_MINUTES,
  mergeSettings,
  piGlaDir,
} from "./goal-loop-core.ts";
import type { SubagentModelStrategy } from "./goal-loop-subagents.js";
import { normalizeMainModelFallbackRefs } from "./main-model-recovery.js";

export interface Settings {
  /** v0.34.57: model refs/ids that must never be selected — the policy
   * guard (bug #1.14). The v0.34.115 default is [] (no opinionated ban
   * list); users can explicitly configure refs such as gpt-5.5 / sonnet /
   * opus. Matches case-insensitively as a substring against the
   * "provider/id" ref. Every switch to a forbidden model is ledgered as
   * `forbidden_model_switch`; with blockForbiddenModelSwitches on the
   * selection is reverted. */
  forbiddenModels?: string[];
  /** v0.34.57: when a forbidden model is selected, revert to the previous
   * model (block the call). Default ON. Off = the switch stands but the
   * `forbidden_model_switch` ledger entry records the violation. */
  blockForbiddenModelSwitches?: boolean;
  /** v0.34.72: on (default) → continuation prompts carry the VISION-ASSIST
   * directive: agents that need to SEE something route the check to the
   * mmx vision CLI (mmx-cli skill) instead of switching models; a switch
   * is sanctioned only when the target is preapproved (not forbidden).
   * Off → no vision guidance is injected (the forbiddenModels gate still
   * stands). */
  visionAssist?: boolean;
  /** Global-only ordered provider/model refs to use when the MAIN session model hits a provider wall. */
  mainModelFallbacks?: string[];
  /** v0.34.115: per-subagent fallback chains. Keyed by subagent name
   * (Explore, Plan, general-purpose, …). When set, the subagent sync uses
   * the FIRST eligible ref in the chain via ModelSelector.selectNextValid;
   * when unset, behavior is byte-identical to v0.34.114 (inherit-parent or
   * per-type pin). */
  subagentFallbacks?: Record<string, string[]>;
  /** Global-only base minutes before main-session recovery; doubles per attempt, caps at 5h, and the automatic window ends at 24h. */
  mainModelRetryMinutes?: number;
  /** "provider/model-id" or bare "model-id". Unset → session model. */
  auditorModel?: string;
  /** v0.31.3/v0.34.25: next detached auditor candidate when the primary
   * model is the session model or fails at runtime. Unset → session model
   * remains the final fallback. */
  auditorModelFallback?: string;
  /** v0.31.6: when the pinned auditor IS the session model, walk the
   * fallback pin (verifier ≠ executor). Default ON (undefined); false =
   * same-model audits stand — the isolated session + evidence contract is
   * the first-order defense either way; diversity is the second-order one
   * the user may deliberately trade away. */
  auditorSameSessionSwap?: boolean;
  /** v0.34.66: on → the auditor's report text renders FINAL-ONLY in the
   * widget: the live per-token tail is hidden while the detached worker
   * streams and the text surfaces at the verdict. Default ON — the
   * word-by-word HUD was the user complaint (note.md #4,
   * Screenshot_20260804_211341/211506). */
  auditorSilent?: boolean;
  /** v0.34.86: intermediate progress signals during silent audits — phase
   * label ("reading source…" / "writing report…") + report byte-counter.
   * Default ON; off = the plain timer-only card. */
  auditorProgressSignals?: boolean;
  /** Global-only: when main-model recovery is parked, fire an extra probe at
   * the next :00:30 every hour. Quota windows tend to refresh at the top of
   * the hour; the ticker is the fastest pickup the plugin can give without
   * spam. Default ON (the user asked for an additional retry after each hour
   * starts). Co-resident with the configured retry ladder — opt-out flips
   * only this ticker off. */
  hourlyQuotaProbe?: boolean;
  auditorThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Shell command run on goal complete / goal pause / loop stop; message passed as $1. */
  notifyCmd?: string;
  /** Per-goal token budget; crossing it pauses the goal. Off by default
   * (opt-in guard, v0.12.0): unset/0 = no budget. */
  tokenLimit?: number;
  /** v0.23.2: minutes of busy-but-silent before the wedge alert fires
   * (hung-command detector). Unset = 30 (WEDGE_ALERT_DEFAULT_MINUTES); 0 = off. */
  wedgeAlertMinutes?: number;
  /** on → restored goals/loops/lists auto-resume even in fresh sessions
   * (unattended rigs). Default off: restore holds until /goal resume. */
  autoResume?: boolean;
  /** v0.28.23: off → decision pauses don't pop the select() picker (the
   * widget card still shows the options; /goal decide opens it on demand).
   * Default on; unattended rigs have no UI so this never fires there. */
  decisionPopup?: boolean;
  /** v0.28.14: what happens to stale carryover (paused goal, waiting list,
   * held loop from before this session) when NEW work activates.
   * pause (default) = leave it + ONE summary; clear = drop it all honestly;
   * resume = legacy silent stacking. */
  carryover?: "resume" | "pause" | "clear";
  /** v0.24.2: pause the goal after N consecutive auditor disapprovals (0 = unlimited).
   * Default 5 (raised from 3 in v0.25.0, contract item 7). */
  auditCap?: number;
  /** Maximum auditor-report characters returned to the executor after a
   * disapproval (0 = full report). Default 0 (full report). */
  auditFeedbackChars?: number;
  /** v0.25.0: flip the continuation defaults toward keep-going
   * (contract item 5): autoResume on, auditCap 10, stuckMax 10, wedge off,
   * quota errors auto-retry silently. Explicit per-key settings still win. */
  aggressiveMode?: boolean;
  /** Minutes to wait before auto-retrying a quota-exhausted auditor when
   * the upstream gave no Retry-After hint (contract item 11). Default 60. */
  quotaRetryMinutes?: number;
  /** Consecutive stuck interventions before a loop stops (default 5,
   * 10 under aggressiveMode). */
  stuckMaxInterventions?: number;
  /** @deprecated v0.34.16: retained so older settings files deserialize, but
   * ignored. Recovery now uses session_shutdown/session_start handoff and
   * never injects terminal keystrokes. */
  autoReloadOnStale?: boolean;
  /** @deprecated v0.34.16: retained for settings-file compatibility, but
   * ignored. Lifecycle handoff is always enabled. */
  autoRecovery?: boolean;
  /** v0.26.1: consecutive heartbeat refires without a real turn before
   * the goal pauses / loop stops (default 5; 0 = never escalate). */
  stallEscalationRefires?: number;
  /** v0.27.3: a turn with no tool calls AND fewer words than this is a
   * nudge. Default 15 words. Higher = stricter (more pauses). */
  stallShortWords?: number;
  /** v0.27.3: a turn with no tool calls whose text trigram-similarity to
   * the prior assistant turn exceeds this is a nudge. Default 0.6. Higher
   * = stricter (more pauses). */
  stallSimilarityThreshold?: number;
  /** on → propose_* drafts activate WITHOUT the Confirm dialog and the
   * interview floor is skipped — the seed carries the intent (unattended
   * rigs). Default off: nothing activates before the user confirms. */
  autoAcceptDrafts?: boolean;
  /** v0.24.6: subagent model strategy for pi-subagents default agents that
   * pin a model (Explore pins claude-haiku-4-5, which silently routes
   * subagents to a different provider/quota pool than the session).
   * "inherit-parent" (default) writes a managed ~/.pi/agent/agents/Explore.md
   * override without the model pin so subagents share the session model and
   * its quota; "agent-default" restores upstream behavior. Applies to NEW
   * sessions (pi-subagents registers agents at session start). */
  /** v0.26.0: reviewer (post-completion follow-up enqueuer) config —
   * project-scoped; see extensions/reviewer.ts DEFAULT_REVIEWER_CONFIG.
   * v0.27.5: superseded by `postaudit` (same shape, terminology reflects
   * the auditor-adjacent role). Both keys are read; `postaudit` wins
   * when both are present. `reviewer` is kept for backwards compat. */
  reviewer?: Record<string, unknown>;
  /** v0.27.5: post-completion audit config. Same shape as `reviewer`. */
  postaudit?: Record<string, unknown>;
  subagentModelStrategy?: SubagentModelStrategy;
  /** v0.24.6: per-agent-type model pin, e.g. { "Explore": "minimax/MiniMax-M3" }.
   * Always wins over subagentModelStrategy — the managed override is written
   * WITH this pin regardless of strategy. */
  subagentModelOverrides?: Record<string, string>;
  /** v0.27.9: per-tool overrides — allowlist (force tools visible despite
   * an external modlist), hidden (force tools hidden even when allowed by
   * the session), and per-tool config (Record<toolName, Record<key, value>>
   * — extensible for tool-specific knobs like timeouts, formats, etc.). */
  toolOverrides?: {
    /** Tools that MUST be active even when an external allowlist hides them. */
    allow?: string[];
    /** Tools that MUST be hidden even when the session allows them. */
    hide?: string[];
    /** Per-tool configuration knobs (extensible). */
    perToolConfig?: Record<string, Record<string, unknown>>;
  };
}

/** These settings describe the main session's provider-recovery policy, not a
 * project artifact. The recovery runtime intentionally reads the global file
 * for them; ignoring project copies keeps the settings table and behavior
 * honest instead of showing a project value that the retry path cannot use. */
const GLOBAL_MAIN_RECOVERY_KEYS: ReadonlySet<keyof Settings> = new Set([
  "mainModelFallbacks",
  "mainModelRetryMinutes",
  "hourlyQuotaProbe",
]);

export const DEFAULT_SETTINGS: Settings = {
  // Main-model backups are opt-in: an empty list preserves pi's normal
  // session model behavior, while the recovery cadence still protects an
  // active supervised goal from a temporary quota wall.
  mainModelFallbacks: [],
  // v0.34.115: the default policy list is empty — no model is forbidden
  // unless the user explicitly configures forbiddenModels. The blocking gate
  // remains enabled for any explicit list.
  forbiddenModels: [...DEFAULT_FORBIDDEN_MODELS],
  blockForbiddenModelSwitches: true,
  // v0.34.72: vision-assist routing is the default — seeing is an mmx
  // vision CLI job, never a reason to switch models (note.md 2026-08-07).
  visionAssist: true,
  mainModelRetryMinutes: 15,
  // Unset = "high" at the call site (v0.31.2). The auditor is the
  // verification gate: its depth must NOT ride the session's coding-speed
  // thinking dial (user 2026-07-31: "we should also select its thinking
  // level — we don't keep switching it"). v0.31.4: picked alongside the
  // model in /glla → Auditor model; v0.34.127 adds the standalone Auditor
  // thinking row (the claimed "/glla thinking=" action never existed).
  auditorThinkingLevel: undefined,
  // v0.34.66: final-only auditor stream is the default — the HUD never
  // shows the report assembling word-by-word again (note.md #4).
  auditorSilent: true,
  // v0.34.86: progress signals are on by default — silent audits still
  // show a phase label + byte counter (note.md Screenshots 161837/175627).
  auditorProgressSignals: true,
  // v0.34.92: hourly probe ticker on by default — quota windows refresh
  // at the top of the hour; the ticker gives faster pickup without spam
  // (no chat message — just an extra recovery probe at :00:30). The
  // default constant lives in extensions/goal-loop-core.ts
  // (DEFAULT_HOURLY_QUOTA_PROBE) so the contract grep on goal-loop-core
  // matches; this is the wire-up to the settings loader.
  hourlyQuotaProbe: true, // mirrors DEFAULT_HOURLY_QUOTA_PROBE in goal-loop-core.ts
  // v0.24.6: subagents inherit the session model by default — one quota
  // pool, no surprise 403s from a pinned default agent's provider.
  subagentModelStrategy: "inherit-parent",
  auditFeedbackChars: DEFAULT_AUDIT_FEEDBACK_CHARS,
  // v0.25.0 (contract Section B): keep-going is opt-in via aggressiveMode;
  // the dial flips DEFAULTS, never explicit per-key user settings.
  aggressiveMode: false,
  quotaRetryMinutes: DEFAULT_QUOTA_RETRY_MINUTES,
};

export function globalSettingsPath(): string {
  // v0.28.18: test/embedding override — the suite must be hermetic from
  // the developer's real global settings file (a user setting autoAccept
  // globally once made draft-Confirm tests auto-accept and fail).
  const override = process.env.GLLA_GLOBAL_SETTINGS_PATH;
  if (override) return override;
  return path.join(os.homedir(), ".pi", "agent", "pi-goal-list-loop-audit.settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return path.join(piGlaDir(cwd), "settings.json");
}

export function readSettingsFile(file: string): Partial<Settings> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Partial<Settings> : {};
  } catch {
    return {};
  }
}

function normalizeLoadedSettings(settings: Settings): Settings {
  // Settings files can be edited by hand or survive an older UI. Normalize
  // the main fallback chain at every read so runtime, display, and persistence
  // all see the same bounded value.
  settings.mainModelFallbacks = normalizeMainModelFallbackRefs(settings.mainModelFallbacks);
  return settings;
}

export function loadSettings(cwd: string): Settings {
  const project = readSettingsFile(projectSettingsPath(cwd));
  for (const key of GLOBAL_MAIN_RECOVERY_KEYS) delete project[key];
  return normalizeLoadedSettings(mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    readSettingsFile(globalSettingsPath()) as Record<string, unknown>,
    project as Record<string, unknown>,
  ) as unknown as Settings);
}

/**
 * v0.29.5: autoResume is GLOBAL-only (user directive 2026-07-30: "we are
 * not supporting project level setting for it now, just global"). Launch-
 * time restore reads this, never the project file — a stale autoResume
 * key in a project's settings.json is ignored (junk-runner field case: a
 * project-local opt-in from the unattended-audit era kept auto-firing the
 * list at every bare `pi` launch after the global default flipped off).
 */
export function loadGlobalSettings(): Settings {
  return normalizeLoadedSettings(mergeSettings(
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    readSettingsFile(globalSettingsPath()) as Record<string, unknown>,
  ) as unknown as Settings);
}

/** Every provenance-tracked key (the /glla headless display + UI). */
export const SETTINGS_KEYS: Array<keyof Settings> = [
  "mainModelFallbacks",
  "mainModelRetryMinutes",
  "forbiddenModels",
  "blockForbiddenModelSwitches",
  "visionAssist",
  "auditorModel",
  "auditorModelFallback",
  "auditorSameSessionSwap",
  "auditorThinkingLevel",
  "notifyCmd",
  "tokenLimit",
  "wedgeAlertMinutes",
  "autoResume",
  "decisionPopup",
  "carryover",
  "autoAcceptDrafts",
  "auditCap",
  "auditFeedbackChars",
  "auditorSilent",
  "auditorProgressSignals",
  "hourlyQuotaProbe",
  "subagentModelStrategy",
  "subagentModelOverrides",
  "subagentFallbacks",
  "aggressiveMode",
  "quotaRetryMinutes",
  "stuckMaxInterventions",
  "stallEscalationRefires",
  "stallShortWords",
  "stallSimilarityThreshold",
  "postaudit",
  "toolOverrides",
  "reviewer", // v0.33.1: legacy alias — menu saves can write it; provenance must know it exists
];

/** Where each effective setting comes from (for the /glla display). */
export function settingsProvenance(cwd: string): Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }> {
  const proj = readSettingsFile(projectSettingsPath(cwd));
  const glob = readSettingsFile(globalSettingsPath());
  const effective = loadSettings(cwd);
  const out: Record<string, { value: unknown; source: "project" | "global" | "default" }> = {};
  for (const k of SETTINGS_KEYS) {
    const projectValue = GLOBAL_MAIN_RECOVERY_KEYS.has(k) ? undefined : (proj as Record<string, unknown>)[k];
    if (projectValue !== undefined) out[k] = { value: projectValue, source: "project" };
    else if ((glob as Record<string, unknown>)[k] !== undefined) out[k] = { value: (glob as any)[k], source: "global" };
    else out[k] = { value: (effective as any)[k], source: "default" };
  }
  return out as Record<keyof Settings, { value: unknown; source: "project" | "global" | "default" }>;
}

export function saveSettings(scope: "global" | "project", cwd: string, patch: Partial<Settings>): void {
  const file = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
  const current = readSettingsFile(file);
  const next: Record<string, unknown> = { ...current };
  if (scope === "project") {
    for (const key of GLOBAL_MAIN_RECOVERY_KEYS) delete next[key];
  }
  for (const [k, v] of Object.entries(patch)) {
    // Main recovery settings are global-only. If an old project file still
    // carries one, remove it rather than leaving a setting that appears saved
    // but can never affect the runtime.
    if (scope === "project" && GLOBAL_MAIN_RECOVERY_KEYS.has(k as keyof Settings)) {
      delete next[k];
      continue;
    }
    if (v === undefined) delete next[k]; // key=unset removes the key
    else next[k] = k === "mainModelFallbacks" ? normalizeMainModelFallbackRefs(v) : v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}
