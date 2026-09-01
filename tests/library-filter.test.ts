import { describe, expect, it } from 'vitest';
import { headingFor, visibleCanvases } from '../src/ui/Library/libraryFilter';
import type { DraftSummary, Project } from '../src/document/types';

function summary(overrides: Partial<DraftSummary> & Pick<DraftSummary, 'id' | 'title'>): DraftSummary {
  return { createdAt: 0, updatedAt: 0, nodeCount: 0, edgeCount: 0, ...overrides };
}

const projects: Project[] = [
  { id: 'p1', name: 'Payments Platform', createdAt: 0, updatedAt: 0 },
  { id: 'p2', name: 'Recon', createdAt: 0, updatedAt: 0 },
];

const library: DraftSummary[] = [
  summary({ id: 'a', title: 'Checkout Flow', projectId: 'p1', createdAt: 10, updatedAt: 30 }),
  summary({ id: 'b', title: 'Refunds', projectId: 'p1', createdAt: 20, updatedAt: 10 }),
  summary({ id: 'c', title: 'Ledger Sync', projectId: 'p2', createdAt: 30, updatedAt: 20 }),
  summary({ id: 'd', title: 'Scratchpad', createdAt: 5, updatedAt: 5 }),
];

describe('visibleCanvases', () => {
  it('"recent" shows everything, pinned to last-edited order regardless of the chosen sort', () => {
    const result = visibleCanvases(library, projects, { kind: 'recent' }, '', 'name');
    expect(result.map((entry) => entry.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('"all" shows everything and respects the chosen sort', () => {
    const byName = visibleCanvases(library, projects, { kind: 'all' }, '', 'name');
    expect(byName.map((entry) => entry.id)).toEqual(['a', 'c', 'b', 'd']); // Checkout, Ledger, Refunds, Scratchpad

    const byCreated = visibleCanvases(library, projects, { kind: 'all' }, '', 'createdAt');
    expect(byCreated.map((entry) => entry.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('"unorganized" filters to canvases with no project', () => {
    const result = visibleCanvases(library, projects, { kind: 'unorganized' }, '', 'updatedAt');
    expect(result.map((entry) => entry.id)).toEqual(['d']);
  });

  it('"project" filters to that project\'s canvases only', () => {
    const result = visibleCanvases(library, projects, { kind: 'project', projectId: 'p1' }, '', 'updatedAt');
    expect(result.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
  });

  it('a title match searches across the whole library, ignoring the selected view', () => {
    const result = visibleCanvases(library, projects, { kind: 'unorganized' }, 'checkout', 'updatedAt');
    expect(result.map((entry) => entry.id)).toEqual(['a']);
  });

  it('a project-name match returns every canvas in that project, even from a different view', () => {
    const result = visibleCanvases(library, projects, { kind: 'unorganized' }, 'recon', 'updatedAt');
    expect(result.map((entry) => entry.id)).toEqual(['c']);
  });

  it('search is case-insensitive and matches a substring', () => {
    const result = visibleCanvases(library, projects, { kind: 'all' }, 'LEDGER', 'updatedAt');
    expect(result.map((entry) => entry.id)).toEqual(['c']);
  });

  it('an empty or whitespace-only query is treated as no search', () => {
    const result = visibleCanvases(library, projects, { kind: 'unorganized' }, '   ', 'updatedAt');
    expect(result.map((entry) => entry.id)).toEqual(['d']);
  });

  it('while searching, "recent" no longer pins to last-edited — the chosen sort applies', () => {
    // Matches by title ("Checkout Flow", "Scratchpad") and by project name
    // ("Refunds", via "Payments Platform"); name-sorted rather than last-edited-first.
    const result = visibleCanvases(library, projects, { kind: 'recent' }, 'a', 'name');
    expect(result.map((entry) => entry.id)).toEqual(['a', 'b', 'd']);
  });
});

describe('headingFor', () => {
  it('labels each view', () => {
    expect(headingFor({ kind: 'recent' }, projects, false)).toBe('Recently edited');
    expect(headingFor({ kind: 'all' }, projects, false)).toBe('All diagrams');
    expect(headingFor({ kind: 'unorganized' }, projects, false)).toBe('Unorganized');
    expect(headingFor({ kind: 'project', projectId: 'p2' }, projects, false)).toBe('Recon');
  });

  it('a search query overrides the view label', () => {
    expect(headingFor({ kind: 'project', projectId: 'p1' }, projects, true)).toBe('Search results');
  });

  it('falls back gracefully for a project id that no longer exists', () => {
    expect(headingFor({ kind: 'project', projectId: 'gone' }, projects, false)).toBe('Project');
  });
});
