import { describe, expect, it } from 'vitest';
import { interactionKindFor, resolveMessageLabel, resolveResponseLabel } from '../src/sequence/label';

describe('resolveMessageLabel — priority chain', () => {
  it('tier 1: an explicit label always wins, regardless of semantic', () => {
    expect(resolveMessageLabel({ label: 'Submit order', semantic: 'writes' }, 'service', 'database', 'sync')).toBe(
      'Submit order',
    );
  });

  it('tier 1: whitespace-only labels are treated as absent', () => {
    expect(resolveMessageLabel({ label: '   ', semantic: 'writes' }, 'service', 'database', 'sync')).toBe('writes to');
  });

  it('tier 2: semantic formats through relationshipCaptionLabel, including its "requests" wording', () => {
    expect(resolveMessageLabel({ semantic: 'calls', hasResponse: true }, 'service', 'service', 'sync')).toBe(
      'requests',
    );
    expect(resolveMessageLabel({ semantic: 'calls' }, 'service', 'service', 'sync')).toBe('calls');
  });

  it('tier 2: deadLetters formats "after N attempts" when deliveryAttempts is set', () => {
    expect(
      resolveMessageLabel({ semantic: 'deadLetters', deliveryAttempts: 3 }, 'queue', 'deadLetter', 'async'),
    ).toBe('after 3 attempts');
  });

  it('tier 2: a protocol reads as the call it carries, the same words the canvas caption uses', () => {
    expect(resolveMessageLabel({ semantic: 'http' }, 'service', 'service', 'sync')).toBe('calls over HTTP');
    expect(resolveMessageLabel({ semantic: 'readsWrites' }, 'service', 'database', 'sync')).toBe('reads / writes');
  });

  it('tier 3: an unset semantic falls back to the capability matrix\'s inferred default relation', () => {
    // service>database has no explicit semantic here but the matrix defaults to 'readsWrites' —
    // the store drawn beside a service is nearly always its own.
    expect(resolveMessageLabel({}, 'service', 'database', 'sync')).toBe('reads / writes');
    expect(resolveMessageLabel({}, 'database', 'service', 'sync')).toBe('read by');
    // A work queue is commanded; a topic is published to.
    expect(resolveMessageLabel({}, 'service', 'queue', 'async')).toBe('sends command to');
    expect(resolveMessageLabel({}, 'service', 'topic', 'async')).toBe('publishes to');
  });

  it('tier 4: an unlisted pairing with no semantic falls back to the generic bucket word', () => {
    expect(resolveMessageLabel({}, 'generic', 'generic', 'sync')).toBe('Call');
    expect(resolveMessageLabel({}, 'generic', 'generic', 'async')).toBe('Event');
  });
});

describe('resolveResponseLabel', () => {
  it('uses the explicit response text when present', () => {
    expect(resolveResponseLabel('200 OK')).toBe('200 OK');
  });

  it('trims whitespace and falls back to the generic word when empty', () => {
    expect(resolveResponseLabel('   ')).toBe('Response');
    expect(resolveResponseLabel(undefined)).toBe('Response');
  });
});

describe('interactionKindFor', () => {
  it('is sync by default', () => {
    expect(interactionKindFor({})).toBe('sync');
    expect(interactionKindFor({ semantic: 'calls' })).toBe('sync');
    expect(interactionKindFor({ semantic: 'writes' })).toBe('sync');
  });

  it('is async for inherently asynchronous relations', () => {
    for (const semantic of ['publishes', 'consumes', 'deliversTo', 'fansOut', 'deadLetters'] as const) {
      expect(interactionKindFor({ semantic })).toBe('async');
    }
  });

  it('is async for kind "event" or "async", or the async flag, independent of semantic', () => {
    expect(interactionKindFor({ kind: 'event' })).toBe('async');
    expect(interactionKindFor({ kind: 'async' })).toBe('async');
    expect(interactionKindFor({ async: true })).toBe('async');
    expect(interactionKindFor({ semantic: 'calls', kind: 'async' })).toBe('async');
    // A command is synchronous between two services; the inferred Service → Queue connector carries
    // `kind: 'async'` itself, and that is what makes its message asynchronous — not the word.
    expect(interactionKindFor({ semantic: 'command' })).toBe('sync');
    expect(interactionKindFor({ semantic: 'command', kind: 'async', async: true })).toBe('async');
  });
});
