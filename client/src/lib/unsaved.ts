/**
 * Drafts in progress, so leaving a screen asks first instead of losing them.
 *
 * A form calls `useUnsaved(dirty, { save, canSave })` while it holds edits.
 * Anything that would take the person away goes through `guard(action)` or
 * `leave(path)`: with nothing unsaved it runs at once; otherwise it waits for
 * the dialog, which offers Save, Discard, and Keep editing.
 *
 * A module singleton, like the router. One screen is on show at a time.
 */
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { navigate } from "./router";

export interface Draft {
  /** Save and answer whether it worked. Absent when the draft only makes sense with another action. */
  save?: () => Promise<boolean>;
  /** False while the form is not valid; the dialog then offers Discard and Keep editing only. */
  canSave?: boolean;
}

class Unsaved {
  private drafts = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  /** The action waiting on an answer, if the dialog is up. */
  pending: (() => void) | null = null;
  version = 0;

  register(id: string, draft: Draft): void {
    this.drafts.set(id, draft);
    this.notify();
  }

  unregister(id: string): void {
    this.drafts.delete(id);
    this.notify();
  }

  get any(): boolean {
    return this.drafts.size > 0;
  }

  /** One save for the dialog: only when every draft can be saved. */
  get save(): (() => Promise<boolean>) | undefined {
    const all = [...this.drafts.values()];
    if (all.length === 0 || all.some((d) => !d.save)) return undefined;
    return async () => {
      for (const d of all) if (!(await d.save!())) return false;
      return true;
    };
  }

  get canSave(): boolean {
    return [...this.drafts.values()].every((d) => d.canSave !== false);
  }

  ask(action: () => void): void {
    this.pending = action;
    this.notify();
  }

  /** Keep editing. */
  cancel(): void {
    this.pending = null;
    this.notify();
  }

  /** Go ahead; the drafts die with their screen. */
  proceed(): void {
    const action = this.pending;
    this.pending = null;
    this.notify();
    action?.();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const unsaved = new Unsaved();

/** Run `action` now, or after the person has answered for their draft. */
export function guard(action: () => void): void {
  if (unsaved.any) unsaved.ask(action);
  else action();
}

/** Navigate, asking first if a draft would be lost. */
export function leave(path: string, replace = false): void {
  guard(() => navigate(path, replace));
}

/** Tell the app this form holds edits while `dirty` is true. */
export function useUnsaved(dirty: boolean, draft: Draft = {}): void {
  const id = useId();
  const latest = useRef(draft);
  latest.current = draft;
  const hasSave = Boolean(draft.save);
  const canSave = draft.canSave !== false;
  useEffect(() => {
    if (!dirty) return;
    unsaved.register(id, {
      save: hasSave ? () => latest.current.save!() : undefined,
      canSave,
    });
    return () => unsaved.unregister(id);
  }, [id, dirty, hasSave, canSave]);
}

/** Re-render when drafts or the pending question change. */
export const useUnsavedState = () => useSyncExternalStore(unsaved.subscribe, () => unsaved.version);
