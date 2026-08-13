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
//   • Selection order is explicit: new items append, and `[ ]` moves the
//     highlighted selected item earlier/later without changing membership.
//
// UX:
//   • Space (" ") toggles the highlighted item. Models are toggleable;
//     session-row and manual-row both render but pressing space on them
//     is a no-op (they're not model refs to pick).
//   • Enter / Tab confirm with the current selection, refs in selection
//     order. Esc cancels with undefined.
//   • Selection state is visually ranked: `[1]`, `[2]`, … show the exact
//     persisted try order; `[ ]` means unselected. The marker is independent
//     of the highlighted row — ranks stay visible while navigating.
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
  /** Refs already in the selection, in canonical order. */
  initialSelected?: string[];
  /** The model occupying slot 0 in the runtime try order. */
  currentRef?: string;
  /** Cap on visible list rows (window scrolls with the selection). */
  maxVisibleRows?: number;
  /** Maximum number of model refs that may be selected. Undefined = no cap. */
  maxSelections?: number;
}

export type MultiModelPickerResult = string[] | undefined;

export class MultiModelPickerComponent {
  private readonly title: string;
  private readonly items: ModelPickItem[];
  private readonly maxRows: number;
  private readonly maxSelections: number | undefined;
  private readonly currentRef: string | undefined;
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
    this.maxSelections = deps.maxSelections !== undefined && Number.isInteger(deps.maxSelections) && deps.maxSelections >= 0
      ? deps.maxSelections
      : undefined;
    this.currentRef = typeof deps.currentRef === "string" && deps.currentRef.trim() ? deps.currentRef.trim() : undefined;
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    const itemRef = new Map<string, string>();
    for (const item of this.items) {
      if (item.kind === "model" && item.ref) itemRef.set(item.ref.toLowerCase(), item.ref);
    }
    const initial: string[] = [];
    const seen = new Set<string>();
    for (const candidate of deps.initialSelected ?? []) {
      if (typeof candidate !== "string") continue;
      const ref = candidate.trim();
      const key = ref.toLowerCase();
      if (!ref || seen.has(key)) continue;
      seen.add(key);
      // Prefer the registry's canonical spelling, but retain a stale ref so
      // the order is visible and it is not silently deleted on save.
      initial.push(itemRef.get(key) ?? ref);
    }
    this.selection = this.maxSelections === undefined ? initial : initial.slice(0, this.maxSelections);
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

  private selectionIndex(ref: string | undefined): number {
    if (!ref) return -1;
    const key = ref.toLowerCase();
    return this.selection.findIndex((candidate) => candidate.toLowerCase() === key);
  }

  private selectedItem(): ModelPickItem | undefined {
    const filtered = this.filteredItems();
    return filtered[this.selectedIdx];
  }

  private isCurrent(ref: string | undefined): boolean {
    return !!ref && !!this.currentRef && ref.toLowerCase() === this.currentRef.toLowerCase();
  }

  private effectiveDisabledReason(item: ModelPickItem | undefined): string | undefined {
    if (!item || item.kind !== "model" || !item.ref) return undefined;
    return item.disabledReason ?? (this.isCurrent(item.ref) ? "current session model (slot 0)" : undefined);
  }

  private toggle(): void {
    const it = this.selectedItem();
    if (!it || it.kind !== "model" || !it.ref) return;
    const idx = this.selectionIndex(it.ref);
    if (idx >= 0) {
      // Removing a stale/blocked ref is always allowed: the user is fixing
      // the setting explicitly rather than having the editor do it silently.
      this.selection.splice(idx, 1);
    } else {
      if (this.effectiveDisabledReason(it)) return;
      if (this.maxSelections !== undefined && this.selection.length >= this.maxSelections) {
        this.refresh();
        return;
      }
      this.selection.push(it.ref);
    }
    this.refresh();
  }

  /** Move the highlighted selected ref earlier/later in the try order. */
  private moveSelectedOrder(delta: number): void {
    const it = this.selectedItem();
    const idx = this.selectionIndex(it?.ref);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= this.selection.length) return;
    const current = this.selection[idx]!;
    this.selection[idx] = this.selection[next]!;
    this.selection[next] = current;
    this.refresh();
  }

  private isSelected(ref: string | undefined): boolean {
    return this.selectionIndex(ref) >= 0;
  }

  private orderLabel(ref: string | undefined): string {
    const idx = this.selectionIndex(ref);
    return idx >= 0 ? `[${idx + 1}]` : "[ ]";
  }

  private itemForRef(ref: string): ModelPickItem | undefined {
    const key = ref.toLowerCase();
    return this.items.find((item) => item.kind === "model" && item.ref?.toLowerCase() === key);
  }

  render(width: number): string[] {
    const w = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
    if (this.currentRef) {
      lines.push(this.theme.fg("muted", "try order on a provider failure (one supervised model at a time):"));
      lines.push(truncateToWidth(`  0 current  ${this.currentRef}`, w, "…"));
    } else {
      lines.push(this.theme.fg("muted", "configured try order (first eligible ref wins):"));
    }
    if (this.selection.length === 0) {
      lines.push(this.theme.fg("dim", this.currentRef
        ? "  — no backups; keep probing the current model"
        : "  — no fallback refs configured"));
    } else {
      for (let i = 0; i < this.selection.length; i++) {
        const ref = this.selection[i]!;
        const item = this.itemForRef(ref);
        const status = this.effectiveDisabledReason(item) ? ` · ${this.effectiveDisabledReason(item)}` : "";
        lines.push(truncateToWidth(`  ${i + 1} backup  ${ref}${status}`, w, "…"));
      }
    }
    lines.push("");
    const searchLine = `search: ${this.query}`;
    lines.push(this.theme.fg("muted", truncateToWidth(searchLine, w, "…") + "▏"));
    if (this.maxSelections !== undefined) {
      const count = `${this.selection.length}/${this.maxSelections}`;
      lines.push(this.theme.fg(this.selection.length >= this.maxSelections ? "warning" : "muted", `selected: ${count}`));
    }
    lines.push(this.theme.fg("dim", "selected rows are tried top-to-bottom; [ / ] changes their order"));
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
        const marker = this.orderLabel(it.ref);
        const disabledReason = this.effectiveDisabledReason(it);
        const disabled = disabledReason && !this.isSelected(it.ref) ? ` · ${disabledReason}` : "";
        const row = truncateToWidth(`${marker} ${it.label}${disabled}`, w - 2, "…");
        if (idx === sel) {
          // Use the available horizontal space for a high-contrast active
          // state. Accent-only text was easy to miss in dark terminals and
          // left the selected model indistinguishable from its neighbours.
          // The order marker is unrelated to the highlight — a selected
          // non-highlighted row keeps its rank, and vice versa.
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
    lines.push(this.theme.fg("dim", this.maxSelections !== undefined && this.selection.length >= this.maxSelections
      ? "space add/remove · [ ] reorder · enter save · esc cancel · maximum reached"
      : "space add/remove · [ ] reorder · enter save · esc cancel"));
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
    // Brackets reorder the highlighted selected model without changing
    // which row is highlighted. This makes order an explicit, inspectable
    // setting instead of an accidental side effect of toggle timing.
    if (data === "[") {
      this.moveSelectedOrder(-1);
      return;
    }
    if (data === "]") {
      this.moveSelectedOrder(+1);
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
