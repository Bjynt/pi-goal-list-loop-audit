// pi-goal-list-loop-audit — v0.29.17
// extensions/model-picker.ts
//
// A /model-style fuzzy picker for model-valued settings (Auditor model,
// subagent model pins). Why this exists:
//   • ctx.ui.select renders EVERY option unsorted with no search — a full
//     model registry is hundreds of rows; unusable (field: the auditor
//     model was left on a quota-dead openrouter key partly because fixing
//     it meant hand-typing provider/model into a bare input).
//   • pi's own /model dialog (ModelSelectorComponent) needs ModelRuntime
//     and SettingsManager internals that extensions never receive.
//   So we rebuild the same interaction shape — a search line with a
//   fuzzy-filtered list — from pi-tui primitives (fuzzyFilter) over
//   ctx.modelRegistry, hosted via ctx.ui.custom, exactly like the v0.28.0
//   settings table. Unit-testable via synthetic handleInput calls.
//
// Item order: "session model" (clear override) first, then every
// configured-auth model sorted by provider/id, then "type manually…" last.

import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsMenuTheme, KeybindingsManagerLike } from "./settings-menu.ts";

export type ModelPickKind = "session" | "model" | "manual";

export interface ModelPickItem {
  kind: ModelPickKind;
  /** provider/model-id for kind === "model". */
  ref?: string;
  /** Row label shown in the list. */
  label: string;
  /** Text the fuzzy filter matches against. */
  searchText: string;
}

export interface RegistryModelLike {
  provider: string;
  id: string;
  name?: string;
}

/** Build the picker's static item list from registry models (already
 * filtered to configured-auth providers by the caller). Session row first,
 * manual-entry row last; models sorted by provider then id. */
export function buildModelPickItems(models: RegistryModelLike[], sessionLabel: string): ModelPickItem[] {
  const sorted = [...models].sort((a, b) =>
    a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
  );
  return [
    {
      kind: "session",
      label: `session model (${sessionLabel}) — clear the override`,
      searchText: "session model default clear override follow",
    },
    ...sorted.map((m) => {
      const ref = `${m.provider}/${m.id}`;
      return {
        kind: "model" as const,
        ref,
        label: m.name && m.name !== m.id ? `${ref} — ${m.name}` : ref,
        searchText: `${ref} ${m.name ?? ""}`,
      };
    }),
    {
      kind: "manual",
      label: "type provider/model manually…",
      searchText: "manual type custom provider model id",
    },
  ];
}

export interface ModelPickerFactoryDeps {
  title: string;
  items: ModelPickItem[];
  /** Cap on visible list rows (window scrolls with the selection). */
  maxVisibleRows?: number;
}

export class ModelPickerComponent {
  private readonly title: string;
  private readonly items: ModelPickItem[];
  private readonly maxRows: number;
  private readonly requestRender: () => void;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (item: ModelPickItem | undefined) => void;

  private query = "";
  private selectedIdx = 0;

  constructor(
    deps: ModelPickerFactoryDeps,
    requestRender: () => void,
    theme: SettingsMenuTheme,
    keybindings: KeybindingsManagerLike,
    done: (item: ModelPickItem | undefined) => void,
  ) {
    this.title = deps.title;
    this.items = deps.items;
    this.maxRows = deps.maxVisibleRows ?? 12;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
  }

  /** Current search query. Exposed for tests. */
  getQuery(): string {
    return this.query;
  }

  /** Index into the filtered list. Exposed for tests. */
  getSelectedIdx(): number {
    return this.selectedIdx;
  }

  /** Filtered items for the current query. Exposed for tests. */
  filteredItems(): ModelPickItem[] {
    if (!this.query.trim()) return this.items;
    return fuzzyFilter(this.items, this.query.trim(), (it) => it.searchText);
  }

  private refresh(): void {
    this.requestRender();
  }

  private move(delta: number): void {
    const n = this.filteredItems().length;
    if (n === 0) return;
    this.selectedIdx = ((this.selectedIdx + delta) % n + n) % n;
    this.refresh();
  }

  render(width: number): string[] {
    const w = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
    lines.push("");
    const searchLine = `search: ${this.query}`;
    lines.push(this.theme.fg("muted", truncateToWidth(searchLine, w, "…") + "▏"));
    lines.push("");
    const filtered = this.filteredItems();
    if (filtered.length === 0) {
      lines.push(this.theme.fg("warning", "  no matches — keep typing, or Esc to cancel"));
    } else {
      const sel = Math.min(this.selectedIdx, filtered.length - 1);
      const half = Math.floor(this.maxRows / 2);
      const start = Math.max(0, Math.min(sel - half, filtered.length - this.maxRows));
      const window = filtered.slice(start, start + this.maxRows);
      if (start > 0) lines.push(this.theme.fg("dim", `  ↑ ${start} more`));
      for (let i = 0; i < window.length; i++) {
        const idx = start + i;
        const it = window[i]!;
        const row = truncateToWidth(it.label, w - 2, "…");
        lines.push(idx === sel ? this.theme.fg("accent", `→ ${row}`) : `  ${row}`);
      }
      const remaining = filtered.length - (start + window.length);
      if (remaining > 0) lines.push(this.theme.fg("dim", `  ↓ ${remaining} more`));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "type to filter · ↑/↓ move · enter select · esc cancel"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const it = this.filteredItems()[this.selectedIdx];
      this.done(it);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || data === "\x1b") {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.move(+1);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIdx = 0;
        this.refresh();
      }
      return;
    }
    // Printable input (single keystrokes and pasted runs alike). Ignore
    // escape/CSI sequences — they start with \x1b and were handled above.
    if (!data.startsWith("\x1b")) {
      const printable = [...data].filter((ch) => ch >= " ").join("");
      if (printable.length > 0) {
        this.query += printable;
        this.selectedIdx = 0;
        this.refresh();
      }
    }
  }

  invalidate(): void {
    // Stateless beyond the query/selection — nothing to clear.
  }
}

// Re-export for callers that only need the width helper's type signature.
export { visibleWidth };
