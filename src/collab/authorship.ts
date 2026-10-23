/**
 * Who changed what, on the owner's side, so the owner can take back one person's changes — the way
 * out when a collaborator's edits went wrong that doesn't also throw away everyone else's.
 *
 * For each person and each thing they touched (`changeKeys`), it keeps the file just after their last
 * edit to it, and the file just before the run of their edits that led there — the run starts again
 * whenever someone else changed it in between. That is enough to put it back, through the same rules
 * as selective undo (`revertEach`), without reaching past anyone else's version. Files share
 * structure, so holding them costs only what changed.
 */
import type { DraftDocument } from '../document/types';
import { changeKeys, revertEach, sameAt, type KeyRevert, type SelectiveStep } from './selective';

interface Touch extends KeyRevert {
  /** The order of the last edit that touched it, so the newest come back first. */
  order: number;
}

export interface PersonRevert extends SelectiveStep {
  /** Some of their changes had to stay: someone else built on them. */
  kept: boolean;
  /** Some of their earliest changes are no longer remembered (`MAX_VERSIONS_PER_PERSON`), so stay as they are. */
  forgotten: boolean;
}

/**
 * Distinct versions of the file one person's touches may hold. Files share structure, but each
 * version keeps its own lists — and a collaborator touching new things patch after patch made the
 * owner keep a version per patch, without end, until the tab ran out of memory. Past it, their
 * oldest touches go: taking their changes back then says some had to stay.
 */
const MAX_VERSIONS_PER_PERSON = 64;

export class Authorship {
  private readonly people = new Map<string, Map<string, Touch>>();
  /** How many of each person's touches hold each file version, for `MAX_VERSIONS_PER_PERSON`. */
  private readonly versions = new Map<string, Map<DraftDocument, number>>();
  /** People some of whose touches were let go: their changes can no longer all be taken back. */
  private readonly trimmed = new Set<string>();
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
        this.release(person, touch);
        // Someone else changed it since this person last did: what this person made before is
        // already gone, and taking their changes back must land on that other person's version
        // (or keep the owner's deletion), not reach past it to the very first.
        if (!sameAt(before, touch.left, key)) touch.found = before;
        touch.left = after;
        touch.order = this.order;
        // Back where they found it (made, then deleted): nothing of theirs to take back, or to keep.
        if (sameAt(touch.found, touch.left, key)) {
          touches.delete(key);
          continue;
        }
        this.retain(person, touch);
      } else {
        const fresh = { key, found: before, left: after, order: this.order };
        touches.set(key, fresh);
        this.retain(person, fresh);
      }
    }
    this.trim(person, touches);
  }

  private retain(person: string, touch: Touch): void {
    let held = this.versions.get(person);
    if (!held) this.versions.set(person, (held = new Map()));
    for (const file of new Set([touch.found, touch.left])) held.set(file, (held.get(file) ?? 0) + 1);
  }

  private release(person: string, touch: Touch): void {
    const held = this.versions.get(person);
    if (!held) return;
    for (const file of new Set([touch.found, touch.left])) {
      const count = (held.get(file) ?? 0) - 1;
      if (count <= 0) held.delete(file);
      else held.set(file, count);
    }
  }

  /** Lets go of `person`'s oldest touches until the versions they hold are well inside the bound. */
  private trim(person: string, touches: Map<string, Touch>): void {
    const held = this.versions.get(person);
    if (!held || held.size <= MAX_VERSIONS_PER_PERSON) return;
    const oldest = [...touches.values()].sort((a, b) => a.order - b.order);
    for (const touch of oldest) {
      if (held.size <= MAX_VERSIONS_PER_PERSON / 2) break;
      touches.delete(touch.key);
      this.release(person, touch);
    }
    this.trimmed.add(person);
  }

  /** Whether some of `person`'s earliest touches were let go (`MAX_VERSIONS_PER_PERSON`). */
  forgotten(person: string): boolean {
    return this.trimmed.has(person);
  }

  /** Whether `person` has changed anything this session. */
  has(person: string): boolean {
    return (this.people.get(person)?.size ?? 0) > 0 || this.trimmed.has(person);
  }

  /** Copies the remembered keys without exposing the versions held for taking edits back. */
  touches(): { key: string; person: string }[] {
    const result: { key: string; person: string }[] = [];
    for (const [person, touches] of this.people) {
      for (const key of touches.keys()) result.push({ key, person });
    }
    return result;
  }

  /**
   * `current` with `person`'s changes taken back, where nobody has changed those things since. When
   * taking all of them back would remove someone else's work, their changes go back one edit at a
   * time, newest first, and any that others built on stay.
   */
  revert(person: string, current: DraftDocument): PersonRevert {
    const touches = [...(this.people.get(person)?.values() ?? [])];
    const forgotten = this.trimmed.has(person);
    if (touches.length === 0) return { file: current, partial: false, blocked: false, kept: false, forgotten };
    const whole = revertEach(current, touches);
    if (!whole.blocked) return { ...whole, kept: false, forgotten };

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
    return { file, partial, blocked: file === current, kept, forgotten };
  }

  forget(person: string): void {
    this.people.delete(person);
    this.versions.delete(person);
    this.trimmed.delete(person);
  }
}
