import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { ContinuationAnnouncer } from '../src/ui/Editor/ContinuationAnnouncer';
import { continuationAnnouncement } from '../src/ui/Editor/continuationAnnouncement';
import { continuationsFor, materialize } from '../src/continuation';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { ContinuationOffer } from '../src/store/uiStore';
import { useUiStore } from '../src/store/uiStore';

function topicOffer(alternatives?: readonly string[]): ContinuationOffer {
  const pub = createNode({ id: 'pub', type: 'service', x: 0, y: 0 });
  const topic = createNode({ id: 't', type: 'queue', queueKind: 'topic', x: 480, y: 0 });
  const doc = addEdges(addNodes(createDocument('Announce'), [pub, topic]), [
    createEdge({ source: 'pub', target: 't', ...inferRelationship(pub, topic), semanticsOrigin: 'inferred' }),
  ]);
  const [first] = continuationsFor(doc, 't', 'select');
  return { ...materialize(doc, first!)!, trigger: 'select', ...(alternatives ? { alternatives } : {}) };
}

const region = (container: HTMLElement) => container.querySelector('[aria-live="polite"]')!;

beforeEach(() => {
  preferences.clear();
  useUiStore.getState().resetContinuation();
});

describe('what a screen reader is told about a suggestion', () => {
  it('names it, says why, and gives the keys — Tab, ] when there is a next, and Escape', () => {
    const lone = topicOffer();
    expect(continuationAnnouncement({ continuation: lone, continuationNotice: null })).toBe(
      'Suggested: Queue. This topic has a publisher but no delivery path. Press Tab to add it, or Escape to dismiss.',
    );
    const several = topicOffer([lone.id, 'topic-subscriber', 'topic-fan-out-worker']);
    expect(continuationAnnouncement({ continuation: several, continuationNotice: null })).toBe(
      'Suggested: Queue, 1 of 3. This topic has a publisher but no delivery path. Press Tab to add it, ] for the next, or Escape to dismiss.',
    );
  });

  it('says nothing for an offer that is not the quiet one: the picker’s preview is the picker’s own', () => {
    expect(continuationAnnouncement({ continuation: { ...topicOffer(), trigger: 'drop' }, continuationNotice: null })).toBe('');
    expect(continuationAnnouncement({ continuation: null, continuationNotice: null })).toBe('');
  });

  it('reads what ] had to say in place of the suggestion', () => {
    expect(continuationAnnouncement({ continuation: topicOffer(), continuationNotice: 'No other suggestions' })).toBe('No other suggestions');
  });
});

describe('the announcer', () => {
  // A live region announces when its text changes. So: a suggestion is read when it appears or
  // changes, not again while it merely stays put, and read again if it goes away and comes back —
  // for someone who cannot see it, that is a new thing each time.
  it('speaks when a suggestion appears or changes, and not while it stays as it is', () => {
    const { container } = render(<ContinuationAnnouncer />);
    expect(region(container).textContent).toBe('');

    const offer = topicOffer();
    act(() => useUiStore.getState().setContinuation(offer));
    const first = region(container).textContent;
    expect(first).toMatch(/^Suggested: Queue\./);

    // An unrelated edit recomputes an equal offer: the same words, so nothing for the region to announce.
    act(() => useUiStore.getState().setContinuation({ ...offer, nodes: offer.nodes.map((n) => ({ ...n, x: n.x + 10 })) }));
    expect(region(container).textContent).toBe(first);

    // A different alternative changes the words.
    act(() => useUiStore.getState().setContinuation({ ...offer, id: 'topic-subscriber', label: 'Queue → Worker', alternatives: [offer.id, 'topic-subscriber'] }));
    expect(region(container).textContent).toMatch(/^Suggested: Queue → Worker, 2 of 2\./);
  });

  it('goes quiet when the suggestion goes, and speaks again when it comes back', () => {
    const { container } = render(<ContinuationAnnouncer />);
    const offer = topicOffer();
    act(() => useUiStore.getState().setContinuation(offer));
    expect(region(container).textContent).not.toBe('');
    act(() => useUiStore.getState().setContinuation(null));
    expect(region(container).textContent).toBe('');
    act(() => useUiStore.getState().setContinuation(offer));
    expect(region(container).textContent).toMatch(/^Suggested: Queue\./);
  });

  it('reads the line `]` leaves when there is nothing to step to, then lets it go', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ContinuationAnnouncer />);
      act(() => useUiStore.getState().setContinuation(topicOffer()));
      act(() => useUiStore.getState().noteContinuation('No other suggestions'));
      expect(region(container).textContent).toBe('No other suggestions');
      act(() => void vi.advanceTimersByTime(3000));
      expect(region(container).textContent).toMatch(/^Suggested: Queue\./);
    } finally {
      vi.useRealTimers();
    }
  });
});
