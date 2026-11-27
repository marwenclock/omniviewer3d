// Small registries so feature modules can add tool panels, commands and menu items
// without main.ts knowing about each one.

export interface ToolPanel {
  id: string;
  label: string;
  icon: string;
  /** one-line hint shown at the top of the viewport while the tool is active */
  hint: string;
  /** HTML for the details panel section */
  render(): string;
  /**
   * The tool's main control as a compact pill that floats under the model while the tool is on (a slider and its
   * apply button). Uses the same data- attributes as render(), so bind() wires it up too.
   */
  pill?(): string;
  /** wire up events inside the rendered section (also called on the floating pill) */
  bind?(host: HTMLElement): void;
  onActivate?(): void;
  onDeactivate?(): void;
  /** needs a loaded model (default true) */
  needsModel?: boolean;
}

export interface Command {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  run(): void;
  enabled?(): boolean;
}

export const panels = new Map<string, ToolPanel>();
export const commands: Command[] = [];

export function registerPanel(p: ToolPanel) { panels.set(p.id, p); }
export function registerCommand(...c: Command[]) {
  for (const cmd of c) {
    const i = commands.findIndex((x) => x.id === cmd.id);
    if (i >= 0) commands[i] = cmd; else commands.push(cmd);
  }
}
