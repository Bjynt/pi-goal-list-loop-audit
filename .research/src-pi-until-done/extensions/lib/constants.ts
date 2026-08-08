export const DEFAULT_MAX_TURNS = 20;
// Hard ceiling on turn budget. Orthogonal safety gates (spin guard,
// clean-end nudge, CI-failure → block, user input, /until-done pause,
// compaction) make the ceiling a coarse fail-safe rather than the primary
// guardrail — so 20000 is set high enough for multi-week autonomous
// goals (~333h at 1 turn/min) without removing the cap.
export const HARD_BUDGET_CEILING = 20000;
// Above this threshold, /until-done budget shows a confirm dialog so the
// user opts into the spend / wall-clock cost explicitly.
export const LARGE_BUDGET_CONFIRM_THRESHOLD = 500;
export const RESPONSE_SNIPPET_CHARS = 4000;
export const STATE_CUSTOM_TYPE = "until-done.state";
export const COMPACTION_CONTEXT_CUSTOM_TYPE = "until-done.compaction-context";
export const STATUS_KEY = "until-done";
export const WIDGET_KEY = "until-done";
export const TICK_INTERVAL_MS = 500;
export const ASK_BEFORE_TIMEOUT_MS = 30_000;
export const SETUP_CONFIRM_TIMEOUT_MS = 120_000;
