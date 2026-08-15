// pi-goal-list-loop-audit — scope-aware model-fallback selector (v0.34.115).
//
// Composes the pure helpers from main-model-recovery.ts (nextUntriedModelRef,
// classifyMainModelFailure, mainModelFailureDelayMs) with a per-scope
// {getChain, resolve, isForbidden, record} surface. One walker for every
// fallback chain — session model recovery (goal-recovery.ts
// tryMainModelFallback) and the per-subagent chain (goal-loop-subagents.ts
// subagentModelOverrides) share the same forbidden-gate + unregistered-skip
// + ledger semantics, so the gate and the chain mechanics live here and not
// duplicated in either caller.
//
// Scope is a discriminated tag: { kind: "session" } for the main model, and
// { kind: "subagent", agentName } for the per-type chain. The classifier
// and the delay computer are scope-agnostic — the chain, the registry, and
// the forbidden list are the only inputs that change by scope, and the
// scope tag rides in the record payload only.
//
// Why this exists: the pre-v0.34.115 fallback path in goal-recovery.ts
// inlined nextUntriedModelRef + isForbiddenModel + resolveMainModel + the
// loop body in tryMainModelFallback (and again, in a different shape, for
// the per-subagent chain that is in flight). Two implementations of the
// same walker drift — one gets a ledger event, the other doesn't, one
// short-circuits the gate differently, the unit tests cover one and not
// the other. The selector centralizes the walk and lets the wiring layers
// be thin: read the chain, ask the selector, apply the chosen model.
//
// Deliberately pure: no fs, no ctx, no runtime calls. The orchestration
// layer (goal.ts / goal-recovery.ts / the future per-subagent wiring) owns
// the durable state, the model switching, and the UI.

import {
  classifyMainModelFailure,
  mainModelFailureDelayMs,
  nextUntriedModelRef,
  type MainModelFailure,
} from "./main-model-recovery.ts";

/** Identifies which fallback chain the selector is consulting. Session is
 * the main-loop recovery; subagent chains are per-type (Explore, Plan,
 * general-purpose) and live in goal-loop-subagents.ts. */
export type ModelScope =
  | { kind: "session" }
  | { kind: "subagent"; agentName: string }
  | { kind: "drafter" };

export interface ModelSelectorDeps {
  /** Read the fallback chain for a scope (returns the configured list of
   * provider/model refs in priority order). */
  getChain: (scope: ModelScope) => string[];
  /** Resolve a ref to a model object (or undefined if not in the configured
   * registry). */
  resolve: (ref: string) => any | undefined;
  /** True if the ref is in the forbidden list. */
  isForbidden: (ref: string) => boolean;
  /** Optional recorder — emits the model_fallback_select ledger event. */
  record?: (event: ModelFallbackEvent) => void;
}

export interface ModelFallbackEvent {
  scope: ModelScope;
  fromRef: string | undefined;
  toRef: string | undefined;
  /** "ok" — selection applied; "forbidden" — ref was in forbidden list and
   * skipped; "unregistered" — ref not in registry; "exhausted" — chain
   * walked past everything. */
  reason: "ok" | "forbidden" | "unregistered" | "exhausted";
}

export type SelectResult =
  | { ref: string; model: any }
  | { reason: "forbidden" | "unregistered" | "exhausted"; ref?: string };

/** Scope-aware fallback-chain walker. Composes nextUntriedModelRef with the
 * forbidden-gate and registry-resolver supplied by the caller. The class
 * is stateless beyond the injected deps; instances are cheap to construct
 * per call site or to keep as a module-level singleton. */
export class ModelSelector {
  private readonly deps: ModelSelectorDeps;
  private visitedRefs: string[] = [];

  constructor(deps: ModelSelectorDeps) {
    this.deps = deps;
  }

  /** Refs visited by the most recent synchronous selection, including
   * forbidden/unregistered candidates. Callers that persist a cursor can
   * read this immediately after selectNextValid returns. */
  get lastVisitedRefs(): readonly string[] {
    return this.visitedRefs;
  }

  /** Classify a failure string into a MainModelFailure. Scope-agnostic —
   * the underlying classifyMainModelFailure is shared across every chain,
   * so the scope parameter is reserved for the record payload (it rides
   * with the selectNextValid ledger events, not with the failure itself). */
  classifyFailure(scope: ModelScope, error: string | undefined): MainModelFailure {
    void scope;
    return classifyMainModelFailure(error);
  }

  /** Pick the next untried ref in the chain (raw — does not consult the
   * resolver or the forbidden gate). Thin wrapper around nextUntriedModelRef
   * that resolves the chain from the scope. Exposed for callers that want
   * to render the configured list or do their own gating. */
  selectNext(scope: ModelScope, current: string | undefined, attempted: string[]): string | undefined {
    return nextUntriedModelRef(current, this.deps.getChain(scope), attempted);
  }

  /** Pick the next VALID ref: walks the chain past forbidden and
   * unregistered entries until it finds one. Returns the model on hit, a
   * tagged reason on exhaustion. Always calls deps.record for every ref
   * visited so the ledger captures the full walk. The caller's `attempted`
   * list is read but not mutated; the selector builds a local copy and
   * appends each rejected/tried ref to it as it walks. */
  selectNextValid(scope: ModelScope, current: string | undefined, attempted: string[]): SelectResult {
    const tried = attempted.slice();
    const visited: string[] = [];
    this.visitedRefs = visited;
    for (;;) {
      const ref = this.selectNext(scope, current, tried);
      if (ref === undefined) {
        this.deps.record?.({ scope, fromRef: current, toRef: undefined, reason: "exhausted" });
        return { reason: "exhausted" };
      }
      tried.push(ref);
      visited.push(ref);
      if (this.deps.isForbidden(ref)) {
        this.deps.record?.({ scope, fromRef: current, toRef: ref, reason: "forbidden" });
        continue;
      }
      const model = this.deps.resolve(ref);
      if (model === undefined) {
        this.deps.record?.({ scope, fromRef: current, toRef: ref, reason: "unregistered" });
        continue;
      }
      this.deps.record?.({ scope, fromRef: current, toRef: ref, reason: "ok" });
      return { ref, model };
    }
  }

  /** Compute retry delay for a failure. Currently scope-agnostic — same
   * call as mainModelFailureDelayMs, with the default 15-minute base. The
   * scope parameter exists so future per-scope cadences (e.g. a tighter
   * loop for subagent chains) don't break the API. */
  retryDelayMs(scope: ModelScope, failure: MainModelFailure, attempt: number, nowMs?: number): number {
    void scope;
    return mainModelFailureDelayMs(failure, attempt, 15, nowMs ?? Date.now());
  }

  /** True if a ref is allowed to switch to (not forbidden AND resolvable). */
  canUseRef(ref: string): boolean {
    if (this.deps.isForbidden(ref)) return false;
    return this.deps.resolve(ref) !== undefined;
  }

  /** Read the chain for a scope (passthrough to deps.getChain, exposed for
   * callers that want to render the configured list). */
  chainFor(scope: ModelScope): string[] {
    return this.deps.getChain(scope);
  }
}
