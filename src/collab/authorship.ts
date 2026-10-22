/**
 * Who changed what, on the owner's side, so the owner can take back one person's changes — the way
 * out when a collaborator's edits went wrong that doesn't also throw away everyone else's.
 *
 * For each person and each thing they touched (`changeKeys`), it keeps the file just before their
 * first edit to it and the file just after their last: enough to put it back, through the same rules
 * as selective undo (`revertEach`). Files share structure, so holding them costs only what changed.
 */
import type { DraftDocument } from '../document/types';
import { changeKeys, revertEach, type KeyRevert, type SelectiveStep } from './selective';

interface Touch extends KeyRevert {
  /** The order of the last edit that touched it, so the newest come back first. */
  order: number;
}

export interface PersonRevert extends SelectiveStep {
  /** Some of their changes had to stay: someone else built on them. */
  kept: boolean;
}

export class Authorship {
  private readonly people = new Map<string, Map<string, Touch>>();
  private order = 0;

  /** `person` took the file from `before` to `after`. */
  record(person: string, before: DraftDocument, after: DraftDocument): void {
    const keys = changeKeys(before, after);
    if (keys.length === 0) return;
    this.order += 1;
    let touches = this.people.get(person);
    if (!touches) this.people.set(person, (touches = new Map()));
    for (const key of keys) {
      const touch = touches.get(key);
      if (touch) {
        touch.left = after;
        touch.order = this.order;
      } else {
        touches.set(key, { key, found: before, left: after, order: this.order });
      }
    }
  }

  /** Whether `person` has changed anything this session. */
  has(person: string): boolean {
    return (this.people.get(person)?.size ?? 0) > 0;
  }

  /**
   * `current` with `person`'s changes taken back, where nobody has changed those things since. When
   * taking all of them back would remove someone else's work, their changes go back one edit at a
   * time, newest first, and any that others built on stay.
   */
  revert(person: string, current: DraftDocument): PersonRevert {
    const touches = [...(this.people.get(person)?.values() ?? [])];
    if (touches.length === 0) return { file: current, partial: false, blocked: false, kept: false };
    const whole = revertEach(current, touches);
    if (!whole.blocked) return { ...whole, kept: false };

    // Newest first: their connector to their own shape goes before the shape does.
    const byEdit = new Map<number, Touch[]>();
    for (const touch of touches) byEdit.set(touch.order, [...(byEdit.get(touch.order) ?? []), touch]);
    let file = current;
    let partial = whole.partial;
    let kept = false;
    for (const order of [...byEdit.keys()].sort((a, b) => b - a)) {
      const step = revertEach(file, byEdit.get(order)!);
      if (step.blocked) kept = true;
      else file = step.file;
      partial ||= step.partial;
    }
    return { file, partial, blocked: file === current, kept };
  }

  forget(person: string): void {
    this.people.delete(person);
  }
}
