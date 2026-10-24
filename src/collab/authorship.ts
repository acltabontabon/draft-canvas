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
const MAX_VERSIONS = 128;
const MAX_PEOPLE = 128;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_TOUCHES = 50_000;

interface RetainedObject {
  references: number;
  bytes: number;
  children: object[];
}

export class Authorship {
  private readonly people = new Map<string, Map<string, Touch>>();
  /** How many of each person's touches hold each file version, for `MAX_VERSIONS_PER_PERSON`. */
  private readonly versions = new Map<string, Map<DraftDocument, number>>();
  /** People some of whose touches were let go: their changes can no longer all be taken back. */
  private readonly trimmed = new Set<string>();
  private order = 0;
  /** Count shared immutable objects once, rather than serializing a whole file on every edit. */
  private readonly retained = new Map<object, RetainedObject>();
  private readonly files = new Map<DraftDocument, number>();
  private retainedBytes = 0;

  /** Identities still represented by the bounded take-back ledger, including trimmed histories. */
  authors(): string[] {
    return [...new Set([...this.people.keys(), ...this.trimmed])];
  }

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
        const previous = { ...touch };
        // Someone else changed it since this person last did: what this person made before is
        // already gone, and taking their changes back must land on that other person's version
        // (or keep the owner's deletion), not reach past it to the very first.
        if (!sameAt(before, touch.left, key)) touch.found = before;
        touch.left = after;
        touch.order = this.order;
        // Keep shared objects retained across replacement: dropping the last root first made a
        // repeated move rewalk the unchanged starting file on every pointer update.
        this.retain(person, touch);
        this.release(person, previous);
        // Back where they found it (made, then deleted): nothing of theirs to take back, or to keep.
        if (sameAt(touch.found, touch.left, key)) {
          touches.delete(key);
          this.release(person, touch);
          continue;
        }
      } else {
        const fresh = { key, found: before, left: after, order: this.order };
        touches.set(key, fresh);
        this.retain(person, fresh);
      }
    }
    this.trim(person, touches);
    this.trimAll();
  }

  private retain(person: string, touch: Touch): void {
    let held = this.versions.get(person);
    if (!held) this.versions.set(person, (held = new Map()));
    for (const file of new Set([touch.found, touch.left])) {
      held.set(file, (held.get(file) ?? 0) + 1);
      this.files.set(file, (this.files.get(file) ?? 0) + 1);
      this.retainObject(file);
    }
  }

  private release(person: string, touch: Touch): void {
    const held = this.versions.get(person);
    if (!held) return;
    for (const file of new Set([touch.found, touch.left])) {
      const count = (held.get(file) ?? 0) - 1;
      if (count <= 0) held.delete(file);
      else held.set(file, count);
      const all = (this.files.get(file) ?? 0) - 1;
      if (all <= 0) this.files.delete(file);
      else this.files.set(file, all);
      this.releaseObject(file);
    }
  }

  private retainObject(value: object): void {
    const existing = this.retained.get(value);
    if (existing) {
      existing.references += 1;
      return;
    }
    const values: unknown[] = Object.values(value);
    const children = values.filter((item): item is object => typeof item === 'object' && item !== null);
    // Conservative JS storage estimate, including field/array slots. Shared strings may count
    // twice; shared objects do not, so moving one shape in a large file keeps useful history.
    const bytes = 64 + values.length * 32 + values.reduce<number>((sum, item) => sum + (typeof item === 'string' ? item.length * 2 : 0), 0);
    this.retained.set(value, { references: 1, bytes, children });
    this.retainedBytes += bytes;
    for (const child of children) this.retainObject(child);
  }

  private releaseObject(value: object): void {
    const held = this.retained.get(value);
    if (!held || --held.references > 0) return;
    this.retained.delete(value);
    this.retainedBytes -= held.bytes;
    for (const child of held.children) this.releaseObject(child);
  }

  /** Bound the whole session as well: reconnecting under new ids must not multiply the allowance. */
  private trimAll(): void {
    let touches = [...this.people.values()].reduce((count, person) => count + person.size, 0);
    if (this.files.size > MAX_VERSIONS || this.retainedBytes > MAX_RETAINED_BYTES || touches > MAX_TOUCHES) {
      const oldest = [...this.people].flatMap(([person, values]) => [...values.values()].map((touch) => ({ person, touch }))).sort((a, b) => a.touch.order - b.touch.order);
      for (const { person, touch } of oldest) {
        if (this.files.size <= MAX_VERSIONS && this.retainedBytes <= MAX_RETAINED_BYTES && touches <= MAX_TOUCHES) break;
        this.people.get(person)!.delete(touch.key);
        this.release(person, touch);
        this.trimmed.add(person);
        touches -= 1;
      }
    }
    const authors = this.authors();
    for (const person of authors.slice(0, Math.max(0, authors.length - MAX_PEOPLE))) this.forget(person);
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
    for (const touch of this.people.get(person)?.values() ?? []) this.release(person, touch);
    this.people.delete(person);
    this.versions.delete(person);
    this.trimmed.delete(person);
  }
}
