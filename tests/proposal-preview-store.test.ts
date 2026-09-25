import { beforeEach, describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { useUiStore } from '../src/store/uiStore';

describe('uiStore.proposalPreview', () => {
  beforeEach(() => {
    useUiStore.getState().setProposalPreview(null);
  });

  it('starts null', () => {
    expect(useUiStore.getState().proposalPreview).toBeNull();
  });

  it('is replaced wholesale by a fresh set, never merged', () => {
    const nodeA = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const nodeB = createNode({ id: 'b', type: 'service', x: 0, y: 0 });
    useUiStore.getState().setProposalPreview({ proposalId: 'p1', path: [], nodes: [nodeA], edges: [], visible: true });
    useUiStore.getState().setProposalPreview({ proposalId: 'p2', path: [], nodes: [nodeB], edges: [], visible: true });
    const preview = useUiStore.getState().proposalPreview;
    expect(preview?.proposalId).toBe('p2');
    expect(preview?.nodes).toEqual([nodeB]);
  });

  it('setProposalPreviewVisible flips visibility without touching nodes/edges', () => {
    const node = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    useUiStore.getState().setProposalPreview({ proposalId: 'p1', path: [], nodes: [node], edges: [], visible: true });
    useUiStore.getState().setProposalPreviewVisible(false);
    const preview = useUiStore.getState().proposalPreview;
    expect(preview?.visible).toBe(false);
    expect(preview?.proposalId).toBe('p1');
    expect(preview?.nodes).toEqual([node]);
  });

  it('setProposalPreviewVisible is a no-op when there is nothing to preview', () => {
    useUiStore.getState().setProposalPreviewVisible(false);
    expect(useUiStore.getState().proposalPreview).toBeNull();
  });

  it('setProposalPreview(null) clears it', () => {
    const node = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    useUiStore.getState().setProposalPreview({ proposalId: 'p1', path: [], nodes: [node], edges: [], visible: true });
    useUiStore.getState().setProposalPreview(null);
    expect(useUiStore.getState().proposalPreview).toBeNull();
  });
});
