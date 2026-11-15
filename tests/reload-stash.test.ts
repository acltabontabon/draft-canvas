import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { discardReloadStash, stashForReload, takeReloadStash } from '../src/storage/reloadStash';

/** A stash is two entries: the document, and what it was based on. They must never be of two moments. */
describe('reloadStash', () => {
  const at = (title: string): DraftDocument => ({ ...createDocument(title), metadata: { ...createDocument(title).metadata, id: 'd_stash' } });

  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a document with what it was based on, once', () => {
    stashForReload(at('Edited'), { base: { title: 'Before' }, stamp: 's_1', writing: 's_2', conflict: true });
    expect(takeReloadStash('d_stash')).toMatchObject({ document: { metadata: { title: 'Edited' } }, base: { title: 'Before' }, stamp: 's_1', writing: 's_2', conflict: true });
    expect(takeReloadStash('d_stash')).toBeNull();
  });

  it('forgets an old context when the new stash has none', () => {
    stashForReload(at('First'), { stamp: 's_old', conflict: true });
    stashForReload(at('Second'));
    expect(takeReloadStash('d_stash')).toEqual({ document: expect.objectContaining({ metadata: expect.objectContaining({ title: 'Second' }) }) });
  });

  it('never pairs a new document with the context of an older stash when the second write fails', () => {
    stashForReload(at('First'), { base: { title: 'Old base' }, stamp: 's_old', conflict: true });
    const setItem = Storage.prototype.setItem;
    // The document is the big write and lands; the small one beside it is refused (quota).
    let calls = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      calls += 1;
      if (calls === 2) throw new DOMException('quota', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
    stashForReload(at('Second'), { base: { title: 'New base' }, stamp: 's_new' });
    vi.restoreAllMocks();
    const taken = takeReloadStash('d_stash');
    // Either the older pair whole, or the new document on its own: never the new one under the old stamp.
    if (taken) {
      const olderPair = taken.document.metadata.title === 'First' && taken.stamp === 's_old' && taken.conflict === true;
      const alone = taken.document.metadata.title === 'Second' && taken.stamp === undefined && taken.conflict === undefined;
      expect(olderPair || alone).toBe(true);
    }
  });

  it('leaves the older stash whole when the document itself cannot be written', () => {
    stashForReload(at('First'), { stamp: 's_old' });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'draft-canvas:reload:d_stash') throw new DOMException('quota', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
    stashForReload(at('Second'), { stamp: 's_new' });
    vi.restoreAllMocks();
    expect(takeReloadStash('d_stash')).toMatchObject({ document: { metadata: { title: 'First' } }, stamp: 's_old' });
  });

  it('discard removes both entries', () => {
    stashForReload(at('Edited'), { stamp: 's_1' });
    discardReloadStash('d_stash');
    expect(window.sessionStorage.length).toBe(0);
  });
});
