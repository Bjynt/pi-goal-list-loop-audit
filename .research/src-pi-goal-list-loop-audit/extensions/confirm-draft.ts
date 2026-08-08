// pi-goal-list-loop-audit — v0.2.0
// extensions/confirm-draft.ts
//
// v0.34.78 (GitHub #4): the draft-class confirm dialog as a real TUI
// component. ctx.ui.select renders plain text with no wrapping; this
// component renders the SAME title/body as Markdown (objective + contract
// readable at full width) with a SelectList for the Yes / Yes-and-always /
// No choices. Kept in its own file so tests can construct and render it
// without dragging in the whole goal loop.

import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";

export interface ConfirmDraftFactoryDeps {
  title: string;
  body: string;
  options: string[];
}

/** Structural type for the KeybindingsManager — mirrors settings-menu.ts. */
export interface KeybindingsManagerLike {
  matches(data: string, key: string): boolean;
}

/** Pure: the markdown rendered in the dialog. The title is the H1, the
 * body (objective + verification contract) is the content. */
export function buildConfirmDraftMarkdown(title: string, body: string): string {
  return `# ${title}\n\n${body}`;
}

/** Build a MarkdownTheme from the runtime Theme's fg()/bold() primitives.
 * Uses the theme's own md* colors so the dialog follows the active theme. */
function markdownTheme(theme: Theme): MarkdownTheme {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (t: string) => theme.fg(color, t);
  return {
    heading: (t) => theme.bold(fg("mdHeading")(t)),
    link: (t) => fg("mdLink")(t),
    linkUrl: (t) => fg("mdLinkUrl")(t),
    code: (t) => fg("mdCode")(t),
    codeBlock: (t) => fg("mdCodeBlock")(t),
    codeBlockBorder: (t) => fg("mdCodeBlockBorder")(t),
    quote: (t) => fg("mdQuote")(t),
    quoteBorder: (t) => fg("mdQuoteBorder")(t),
    hr: (t) => fg("mdHr")(t),
    listBullet: (t) => fg("mdListBullet")(t),
    bold: (t) => theme.bold(t),
    italic: (t) => t,
    strikethrough: (t) => t,
    underline: (t) => t,
    codeBlockIndent: "  ",
  };
}

function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  };
}

/**
 * The confirm dialog: DynamicBorder frame, markdown title+body, spacer, the
 * three-choice SelectList, and a help line. Exported so tests can construct
 * it with a fake theme and assert the rendered lines.
 */
export class ConfirmDraftComponent implements Component {
  private readonly md: Markdown;
  private readonly selectList: SelectList;
  private readonly requestRender: () => void;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManagerLike;

  constructor(
    deps: ConfirmDraftFactoryDeps,
    requestRender: () => void,
    theme: Theme,
    keybindings: KeybindingsManagerLike,
    done: (value: string | undefined) => void,
  ) {
    this.requestRender = requestRender;
    this.theme = theme;
    this.keybindings = keybindings;
    this.md = new Markdown(buildConfirmDraftMarkdown(deps.title, deps.body), 1, 1, markdownTheme(theme));
    const items: SelectItem[] = deps.options.map((o) => ({ value: o, label: o }));
    this.selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
    this.selectList.onSelect = (item) => done(item.value);
    this.selectList.onCancel = () => done(undefined);
  }

  render(width: number): string[] {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("borderAccent", s)));
    container.addChild(this.md);
    container.addChild(new Spacer(1));
    container.addChild(this.selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(this.theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("borderAccent", s)));
    return container.render(width);
  }

  invalidate(): void {
    this.md.invalidate();
    this.selectList.invalidate();
    this.requestRender();
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
    this.requestRender();
  }

  /** Exposed for tests. */
  getSelectedItem(): string | null {
    return this.selectList.getSelectedItem()?.value ?? null;
  }
}
