import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PresenceLayer } from '../../src/canvas/PresenceLayer';
import type { FollowState, PeerView, Presence } from '../../src/collab/protocol';
import { addEdges, addNodes } from '../../src/document/operations';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { useEditorStore } from '../../src/store/editorStore';
import { FollowPrompt } from '../../src/ui/collab/FollowPrompt';

const peers: PeerView[] = [
  { id: 'host', name: 'Ada Lovelace', color: 0, role: 'owner', link: 'live' },
  { id: 'p1', name: 'Grace Hopper', color: 2, role: 'editor', link: 'live' },
  { id: 'p2', name: 'Elsewhere Person', color: 3, role: 'editor', link: 'live' },
];

const at = (overrides: Partial<Presence>): Presence => ({
  room: '',
  pointer: null,
  selection: { nodes: [], edges: [] },
  editing: null,
  ...overrides,
});

beforeEach(() => {
  const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
  const b = createNode({ id: 'b', type: 'database', x: 300, y: 0 });
  const withNodes = addNodes(createDocument('Presence'), [a, b]);
  useEditorStore.getState().setDocument(addEdges(withNodes, [createEdge({ id: 'e', source: 'a', target: 'b' })]), { resetHistory: true });
});

afterEach(() => useCollabStore.setState(COLLAB_AT_REST, true));

describe('PresenceLayer', () => {
  it('draws nothing outside a session', () => {
    const { container } = render(<PresenceLayer />);
    expect(container.innerHTML).toBe('');
  });

  it('draws the people in this room: named pointers, rings on what they hold, a typing tag', () => {
    useCollabStore.setState({
      role: 'guest',
      status: 'live',
      peers,
      presence: {
        host: at({ pointer: { x: 40, y: 20 }, selection: { nodes: ['a'], edges: ['e'] } }),
        p1: at({ pointer: { x: 320, y: 30 }, editing: 'b' }),
        p2: at({ room: 'a', pointer: { x: 5, y: 5 }, selection: { nodes: ['b'], edges: [] } }),
      },
    });
    const { container } = render(<PresenceLayer />);

    expect(screen.getAllByText('Ada Lovelace')).toHaveLength(1);
    // Typing, Grace's name rides on the shape's tag — once — and her pointer goes unlabelled.
    expect(screen.getAllByText('Grace Hopper')).toHaveLength(1);
    expect(container.querySelector('.dc-presence-typing .dc-presence-typing-who')?.textContent).toBe('Grace Hopper');
    expect(container.querySelectorAll('.dc-presence-cursor')).toHaveLength(2);
    // Someone inside another shape is not drawn here at all.
    expect(screen.queryByText('Elsewhere Person')).toBeNull();

    const rings = container.querySelectorAll('.dc-presence-ring');
    expect(rings).toHaveLength(2);
    expect(container.querySelector('.dc-presence-ring-band[data-peer-color="0"]')).not.toBeNull();
    expect(container.querySelector('.dc-presence-ring-band[data-peer-color="2"]')).not.toBeNull();
    expect(container.querySelector('.dc-presence-typing[data-peer-color="2"]')).not.toBeNull();

    const rules = container.querySelector('style')?.textContent ?? '';
    expect(rules).toContain('.react-flow__edge[data-id="e"] .dc-edge-hit');
    expect(rules).toContain('var(--dc-peer-0');
  });

  it('follows people between rooms', () => {
    useCollabStore.setState({ role: 'guest', status: 'live', peers, presence: { p1: at({ pointer: { x: 1, y: 1 } }) } });
    render(<PresenceLayer />);
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    act(() => useCollabStore.setState({ presence: { p1: at({ room: 'a', pointer: { x: 1, y: 1 } }) } }));
    expect(screen.queryByText('Grace Hopper')).toBeNull();
  });

  it('keeps ten people moving at once off the canvas: no document update, no shape re-render', () => {
    const crowd: PeerView[] = Array.from({ length: 10 }, (_, index) => ({
      id: `p${index}`,
      name: `Person ${index}`,
      color: index % 8,
      role: index === 0 ? 'owner' : 'editor',
      link: 'live',
    }));
    useCollabStore.setState({ role: 'host', status: 'live', peers: crowd, presence: {} });
    // Stands in for a shape on the canvas: it reads what React Flow's nodes are built from.
    let shapeRenders = 0;
    function Shape() {
      useEditorStore((state) => state.document.nodes);
      shapeRenders++;
      return null;
    }
    let documentUpdates = 0;
    const unsubscribe = useEditorStore.subscribe(() => documentUpdates++);
    const { container } = render(
      <>
        <Shape />
        <PresenceLayer />
      </>,
    );
    const rendersAtStart = shapeRenders;

    // A second of everyone moving and selecting: presence arrives about every 50 ms per person.
    const frames: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      for (const peer of crowd) {
        const started = performance.now();
        act(() => {
          useCollabStore.setState((state) => ({
            presence: {
              ...state.presence,
              [peer.id]: at({ pointer: { x: tick * 10, y: Number(peer.id.slice(1)) * 20 }, selection: { nodes: [tick % 2 ? 'a' : 'b'], edges: ['e'] } }),
            },
          }));
        });
        frames.push(performance.now() - started);
      }
    }
    unsubscribe();

    expect(container.querySelectorAll('.dc-presence-cursor')).toHaveLength(10);
    expect(documentUpdates).toBe(0);
    expect(shapeRenders).toBe(rendersAtStart);
    frames.sort((a, b) => a - b);
    // Generous for jsdom; a real browser is several times faster.
    expect(frames[Math.floor(frames.length / 2)]).toBeLessThan(16);
  });
});

describe('FollowPrompt', () => {
  const presenter: FollowState = { path: [], viewport: { x: 0, y: 0, zoom: 1 }, presenting: true, flowId: null, step: null };

  it('offers to follow when the owner presents, and hands the camera back on Stop', () => {
    useCollabStore.setState({ role: 'guest', status: 'live', peers });
    const { container } = render(<FollowPrompt />);
    expect(container.innerHTML).toBe('');

    act(() => useCollabStore.setState({ presenter }));
    expect(screen.getByText('Ada Lovelace is presenting')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(useCollabStore.getState().following).toBe(true);
    expect(screen.getByText('Following Ada Lovelace')).toBeTruthy();
    expect(container.querySelector('.dc-follow-frame')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stop following' }));
    expect(useCollabStore.getState().following).toBe(false);

    act(() => useCollabStore.setState({ presenter: null }));
    expect(container.innerHTML).toBe('');
  });

  it('folds to the presenter’s badge on Not now, still one click from following', () => {
    useCollabStore.setState({ role: 'guest', status: 'live', peers, presenter });
    render(<FollowPrompt />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Ada Lovelace is presenting')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Follow Ada Lovelace' }));
    expect(useCollabStore.getState().following).toBe(true);
  });

  it('is never shown to the owner', () => {
    useCollabStore.setState({ role: 'host', status: 'live', peers, presenter });
    const { container } = render(<FollowPrompt />);
    expect(container.innerHTML).toBe('');
  });
});
