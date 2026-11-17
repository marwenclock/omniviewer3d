/** Undo/redo stack with a "clean" marker (OV-003), grouping (OV-002) and a memory budget (OV-090). */
export interface Action {
  label: string;
  undo(): void;
  redo(): void;
  /** approximate bytes this action keeps alive (geometry snapshots); used for the memory budget */
  bytes?: number;
  /** releases resources once the action can no longer be undone (applied = true) or redone (applied = false) */
  dispose?(applied: boolean): void;
}

interface Entry extends Action { id: number }

export class History {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** id of the entry on top of the stack when the scene was last saved / opened (0 = empty stack) */
  private cleanId = 0;
  private cleanReachable = true;
  private group: Action[] | null = null;
  limit = 100;
  /** keep undo snapshots below this many bytes (oldest are dropped first) */
  byteBudget = 400 * 1024 * 1024;

  /** Records an action that has already been applied. */
  push(action: Action) {
    if (this.group) { this.group.push(action); return; }
    const e: Entry = { ...action, id: this.nextId++ };
    this.done.push(e);
    for (const u of this.undone) u.dispose?.(false);
    // The clean state can't come back once the redo branch that held it is discarded.
    if (this.undone.some((u) => u.id === this.cleanId)) this.cleanReachable = false;
    this.undone = [];
    this.trim();
    this.emit();
  }

  /** Applies an action and records it. */
  run(action: Action) { action.redo(); this.push(action); }

  /** Runs fn and records every action it pushes as ONE undo step (atomic transactions). */
  batch<T>(label: string, fn: () => T): T {
    if (this.group) return fn();
    const items: Action[] = [];
    this.group = items;
    let out: T;
    try { out = fn(); } finally { this.group = null; }
    if (items.length) {
      this.push({
        label,
        undo: () => { for (let i = items.length - 1; i >= 0; i--) items[i].undo(); },
        redo: () => { for (const a of items) a.redo(); },
        bytes: items.reduce((n, a) => n + (a.bytes || 0), 0),
        dispose: (applied: boolean) => items.forEach((a) => a.dispose?.(applied)),
      });
    }
    return out!;
  }

  private trim() {
    let bytes = this.done.reduce((n, a) => n + (a.bytes || 0), 0);
    while (this.done.length > this.limit || (bytes > this.byteBudget && this.done.length > 1)) {
      const a = this.done.shift()!;
      bytes -= a.bytes || 0;
      if (a.id === this.cleanId) this.cleanReachable = false;
      a.dispose?.(true);
    }
  }

  undo() { const a = this.done.pop(); if (!a) return; a.undo(); this.undone.push(a); this.emit(); }
  redo() { const a = this.undone.pop(); if (!a) return; a.redo(); this.done.push(a); this.emit(); }
  clear() {
    for (const a of this.done) a.dispose?.(true);
    for (const a of this.undone) a.dispose?.(false);
    this.done = []; this.undone = []; this.cleanId = 0; this.cleanReachable = true; this.emit();
  }
  /** Marks the current state as saved (after opening or exporting). */
  markClean() { this.cleanId = this.top; this.cleanReachable = true; this.emit(); }
  private get top() { return this.done[this.done.length - 1]?.id ?? 0; }
  /** true when the scene differs from the last opened / exported state */
  get dirty() { return !this.cleanReachable || this.top !== this.cleanId; }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get nextUndo() { return this.done[this.done.length - 1]?.label; }
  get nextRedo() { return this.undone[this.undone.length - 1]?.label; }
  /** labels of past actions, newest first (history list, OV-042) */
  get labels() { return this.done.map((a) => a.label).reverse(); }
  get redoLabels() { return this.undone.map((a) => a.label).reverse(); }
  /** Saves / restores the whole stack (multi-document tabs, OV-110). */
  snapshot() { return { done: this.done, undone: this.undone, cleanId: this.cleanId, cleanReachable: this.cleanReachable }; }
  restore(s: ReturnType<History['snapshot']>) { this.done = s.done; this.undone = s.undone; this.cleanId = s.cleanId; this.cleanReachable = s.cleanReachable; this.emit(); }
  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
}
