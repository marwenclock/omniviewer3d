/** Simple undo/redo stack. Each action knows how to undo and redo itself. */
export interface Action {
  label: string;
  undo(): void;
  redo(): void;
}

export class History {
  private done: Action[] = [];
  private undone: Action[] = [];
  private listeners = new Set<() => void>();
  limit = 100;

  /** Records an action that has already been applied. */
  push(action: Action) {
    this.done.push(action);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.emit();
  }

  /** Applies an action and records it. */
  run(action: Action) { action.redo(); this.push(action); }

  undo() { const a = this.done.pop(); if (!a) return; a.undo(); this.undone.push(a); this.emit(); }
  redo() { const a = this.undone.pop(); if (!a) return; a.redo(); this.done.push(a); this.emit(); }
  clear() { this.done = []; this.undone = []; this.emit(); }
  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get nextUndo() { return this.done[this.done.length - 1]?.label; }
  get nextRedo() { return this.undone[this.undone.length - 1]?.label; }
  onChange(fn: () => void) { this.listeners.add(fn); }
  private emit() { this.listeners.forEach((f) => f()); }
}
