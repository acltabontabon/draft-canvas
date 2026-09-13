import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveScene, stepStarts } from '../src/learn/frames';
import { CATEGORIES, QUICK_START, RECIPES, recipeById } from '../src/learn/recipes';
import { SCENES, sceneFor } from '../src/learn/scenes';
import { SCENE_HEIGHT, SCENE_WIDTH, type LearnRecipe } from '../src/learn/types';

const recipes = RECIPES as readonly LearnRecipe[];

describe('Learn recipes', () => {
  it('have unique ids, and every related recipe exists', () => {
    const ids = recipes.map((recipe) => recipe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const recipe of recipes) {
      for (const related of recipe.related ?? []) {
        expect(recipeById(related), `${recipe.id} → ${related}`).toBeDefined();
        expect(related).not.toBe(recipe.id);
      }
    }
  });

  it('keep the copy short — one sentence, no more', () => {
    for (const recipe of recipes) {
      expect(recipe.summary.length, recipe.id).toBeLessThanOrEqual(90);
      expect(recipe.summary.replace(/\.$/, ''), recipe.id).not.toMatch(/\.\s/);
      if (recipe.note) expect(recipe.note.length, recipe.id).toBeLessThanOrEqual(90);
    }
  });

  it('name only menu items the product actually has', () => {
    // "right-click → Make asynchronous": each label after an arrow must be a command title somewhere.
    const commands = readFileSync(resolve(__dirname, '../src/commands/registry.ts'), 'utf8');
    for (const recipe of recipes) {
      for (const text of [recipe.summary, recipe.note ?? '']) {
        for (const [, label] of text.matchAll(/right-click[^→]*→\s*([^.,]+)/gi)) {
          expect(commands, `${recipe.id}: "${label}"`).toContain(`'${label!.trim()}'`);
        }
      }
    }
  });

  it('curate a six-stop short version, in order, with no gaps', () => {
    expect(QUICK_START.map((recipe) => recipe.quickStart)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('all belong to a category Explore shows', () => {
    const categories = new Set(CATEGORIES.map((category) => category.id));
    for (const recipe of recipes) expect(categories.has(recipe.category), recipe.id).toBe(true);
    for (const category of CATEGORIES) expect(recipes.some((recipe) => recipe.category === category.id)).toBe(true);
  });

  it('say nothing the privacy check would flag', () => {
    const text = JSON.stringify(RECIPES) + JSON.stringify(SCENES);
    expect(text).not.toMatch(/fetch\(|eval\(/);
  });
});

describe('Learn scenes', () => {
  it('exist for every recipe, and only for recipes', () => {
    for (const recipe of recipes) expect(sceneFor(recipe.id), recipe.id).toBeDefined();
    expect(Object.keys(SCENES).sort()).toEqual(recipes.map((recipe) => recipe.id).sort());
  });

  it.each(recipes.map((recipe) => [recipe.id]))('%s resolves into drawable frames', (id) => {
    const scene = sceneFor(id)!;
    const { frames, steps } = resolveScene(scene);

    expect(scene.label.length).toBeGreaterThan(20);
    expect(frames.length).toBeGreaterThan(2);
    // Every step is a chip under the stage: at least one, and few enough to read at a glance.
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.length).toBeLessThanOrEqual(4);
    expect(stepStarts({ frames, steps })).toHaveLength(steps.length);

    const total = frames.reduce((sum, frame) => sum + frame.ms, 0);
    expect(total, 'a loop long enough to follow, short enough to wait for').toBeGreaterThan(3500);
    expect(total).toBeLessThan(13000);

    for (const frame of frames) {
      const ids = new Set([...frame.nodes.map((node) => node.id), ...frame.edges.map((edge) => edge.id)]);
      for (const id of frame.selection) expect(ids.has(id), `${id} selected in frame ${frame.index}`).toBe(true);
      for (const id of frame.dim) expect(ids.has(id), `${id} dimmed in frame ${frame.index}`).toBe(true);
      for (const id of frame.ghost) expect(ids.has(id), `${id} ghosted in frame ${frame.index}`).toBe(true);
      for (const id of frame.flow) expect(ids.has(id), `${id} in flow at frame ${frame.index}`).toBe(true);
      for (const id of Object.keys(frame.chips)) expect(ids.has(id), `chip host ${id}`).toBe(true);
      if (frame.handles) expect(ids.has(frame.handles)).toBe(true);
      // Every edge joins two nodes that are actually on stage.
      for (const edge of frame.edges) {
        expect(ids.has(edge.source) && ids.has(edge.target), edge.id).toBe(true);
      }
      // Nothing is placed off the stage.
      for (const node of frame.nodes) {
        expect(node.x, `${node.id} x`).toBeGreaterThanOrEqual(0);
        expect(node.y, `${node.id} y`).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width, `${node.id} right`).toBeLessThanOrEqual(SCENE_WIDTH);
        expect(node.y + node.height, `${node.id} bottom`).toBeLessThanOrEqual(SCENE_HEIGHT);
      }
    }
  });

  it('carry selection, cursor and chips forward, but not a beat’s overlay', () => {
    const { frames } = resolveScene({
      label: 'A test scene with enough words to count.',
      frames: [
        { ms: 100, step: 'One', add: { nodes: [{ id: 'a', type: 'service', x: 0, y: 0 }] }, select: ['a'], cursor: { x: 1, y: 2, click: true } },
        { ms: 100, overlay: { kind: 'keys', keys: ['s'] }, chips: { a: ['note'] } },
        { ms: 100, step: 'Two', remove: ['a'] },
      ],
    });
    expect(frames[1]!.selection.has('a')).toBe(true);
    expect(frames[1]!.cursor).toEqual({ x: 1, y: 2, down: undefined });
    expect(frames[1]!.overlay?.kind).toBe('keys');
    expect(frames[2]!.overlay).toBeNull();
    expect(frames[2]!.chips).toEqual({ a: ['note'] });
    expect(frames[2]!.nodes).toHaveLength(0);
    expect(frames.map((frame) => frame.step)).toEqual([0, 0, 1]);
  });
});
