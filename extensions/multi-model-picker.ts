// pi-goal-list-loop-audit — v0.29.17
// extensions/multi-model-picker.ts
//
// Multi-select variant of ModelPickerComponent for ordered model lists
// (main-model fallbacks, forbidden-models list, subagent fallbacks).
//
// Why this exists:
//   • The single-select picker doesn't scale to ordered lists — the user
//     needs to add 3-5 fallbacks in priority order, and the picker needs
//     to remember what was already picked between confirm and re-edit.
//   • Selection order = order items were toggled ON (not list order), so a
//     late-ohh-this-one-also add moves to the end, not silently retreats
//     behind the original picks.
//
// UX:
//   • Space (" ") toggles the highlighted item. Models are toggleable;
//     session-row and manual-row both render but pressing space on them
//     is a no-op (they're not model refs to pick).
//   • Enter / Tab confirm with the current selection, refs in selection
//     order. Esc cancels with undefined.
//   • Selection state is visually marked: `[x]` for selected, `[ ]` for
//     unselected. The marker is independent of the highlighted row —
//     selected items stay marked even when they're not the cursor.
//
// Pure UI — no fs, no path, no os. Imports: ./model-picker.ts for the
// item type, ./settings-menu.ts for the theme/keybindings shapes, and
// @earendil-works/pi-tui for fuzzyFilter / truncateToWidth / visibleWidth.

import { fuzzyFilter, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsMenuTheme, KeybindingsManagerLike } from "./settings-menu.ts";
import type { ModelPickItem } from "./model-picker.ts";

// Re-export so callers can import the item type from this module too.
export type { ModelPickItem };

export interface MultiModelPickerDeps {
  title: string;
  items: ModelPickItem[];
  /** Refs already in the selection, in canonical order. Stray refs that
   *  don't appear in the item list are dropped — the caller may pass
   *  stale values from a half-edited setting. */
  initialSelected?: string[];
  /** Cap on visible list rows (window scrolls with the selection). */
  maxVisibleRows?: number;
}

export type MultiModelPickerResult = string[] | undefined;

export class MultiModelPickerComponent {
  private readonly title: string;
  private readonly items: ModelPickItem[];
  private readonly maxRows: number;
  private readonly requestRender: () => void;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (result: MultiModelPickerResult) => void;

  private query = "";
  private selectedIdx = 0;
  /** Ordered list of selected refs — toggle order, not list order. */
  private readonly selection: string[];

  constructor(
    deps: MultiModelPickerDeps,
    requestRender: () => void,
    theme: SettingsMenuTheme,
    keybindings: KeybindingsManagerLike,
    done: (result: MultiModelPickerResult) => void,
  ) {
    this.title = deps.title;
    this.items = deps.items;
    this.maxRows = deps.maxVisibleRows ?? 12;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.selection = (deps.initialSelected ?? []).filter((ref) =>
      this.items.some((it) => it.kind === "model" && it.ref === ref),
    );
  }

  /** Current search query. Exposed for tests. */
  getQuery(): string {
    return this.query;
  }

  /** Index into the filtered list. Exposed for tests. */
  getSelectedIdx(): number {
    return this.selectedIdx;
  }

  /** Selected refs in selection order (toggle order). Exposed for tests. */
  getSelected(): string[] {
    return [...this.selection];
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

  private toggle(): void {
    const it = this.filteredItems()[this.selectedIdx];
    if (!it || it.kind !== "model" || !it.ref) return;
    const idx = this.selection.indexOf(it.ref);
    if (idx >= 0) {
      this.selection.splice(idx, 1);
    } else {
      this.selection.push(it.ref);
    }
    this.refresh();
  }

  private isSelected(ref: string | undefined): boolean {
    return ref !== undefined && this.selection.includes(ref);
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
        const marker = this.isSelected(it.ref) ? "[x]" : "[ ]";
        const row = truncateToWidth(`${marker} ${it.label}`, w - 2, "…");
        if (idx === sel) {
          // Use the available horizontal space for a high-contrast active
          // state. Accent-only text was easy to miss in dark terminals and
          // left the selected model indistinguishable from its neighbours.
          // The `[x]/[ ]` marker is unrelated to the highlight — a selected
          // non-highlighted row stays marked, and vice versa.
          const selectedRow = this.theme.bold(`→ ${row}`);
          const paddedRow = selectedRow + " ".repeat(Math.max(0, w - visibleWidth(selectedRow)));
          lines.push(this.theme.bg("selectedBg", paddedRow));
        } else {
          lines.push(`  ${row}`);
        }
      }
      const remaining = filtered.length - (start + window.length);
      if (remaining > 0) lines.push(this.theme.fg("dim", `  ↓ ${remaining} more`));
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "space toggle · enter confirm · esc cancel"));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\t") {
      this.done([...this.selection]);
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
    // Space toggles the highlighted model in/out of the selection. Session
    // and manual rows are intentionally no-op (they have no ref). This
    // overrides the default "append to query" behavior — search queries
    // are paged through with up/down + space, not by typing spaces.
    if (data === " ") {
      this.toggle();
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
