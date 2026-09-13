import { describe, expect, it } from 'vitest';
import { RECIPES } from '../src/learn/recipes';
import { searchLearn } from '../src/learn/search';

const ids = (query: string) => searchLearn(query).recipes.map((match) => match.recipe.id);
const top = (query: string, n = 1) => ids(query).slice(0, n);

describe('Learn search', () => {
  it('answers the words people actually type, first', () => {
    expect(top('async')).toEqual(['make-async']);
    expect(top('sequence')).toEqual(['export-sequence']);
    expect(top('notes')).toEqual(['attach-note']);
    expect(top('presentation')).toEqual(['present-flow']);
    expect(top('dlq')).toEqual(['dead-letter-queue']);
    expect(top('response')).toEqual(['add-response']);
    expect(top('junction')).toEqual(['junction']);
    expect(top('boundary')).toEqual(['boundary']);
    expect(top('starter')).toEqual(['starters']);
    expect(top('mermaid')).toEqual(['export-sequence']);
    expect(top('flow')).toContain('add-to-flow');
  });

  it('understands the names Draft Canvas doesn’t use', () => {
    expect(top('kafka')).toEqual(['pick-a-kind']);
    expect(top('db')).toEqual(['pick-a-kind']);
    expect(top('redis')).toEqual(['pick-a-kind']);
    expect(top('sqs', 3)).toContain('dead-letter-queue');
    expect(top('uml')).toEqual(['export-sequence']);
    expect(top('reply')).toEqual(['add-response']);
    expect(top('template')).toEqual(['starters']);
  });

  it('tolerates a sloppy query', () => {
    expect(top('  ASYNC ')).toEqual(['make-async']);
    expect(top('dead letter')).toEqual(['dead-letter-queue']);
    expect(top('prsnt')).toEqual(['present-flow']);
  });

  it('highlights the title only when the title is what matched', () => {
    const [asyncHit] = searchLearn('async').recipes;
    const title = asyncHit!.recipe.title;
    expect(asyncHit!.titleIndices.map((i) => title[i]).join('')).toBe('async');
    const [dlq] = searchLearn('dlq').recipes;
    expect(dlq!.titleIndices).toEqual([]);
  });

  it('points shortcut questions at the Keyboard shortcuts sheet', () => {
    expect(searchLearn('shortcut').shortcuts).toBe(true);
    expect(searchLearn('keyboard').shortcuts).toBe(true);
    expect(searchLearn('async').shortcuts).toBe(false);
  });

  it('returns nothing for nonsense or an empty box', () => {
    expect(searchLearn('zzqx')).toEqual({ recipes: [], shortcuts: false });
    expect(searchLearn('   ')).toEqual({ recipes: [], shortcuts: false });
  });

  it('never ranks a recipe that has nothing to do with the query', () => {
    // A two-letter query must not scatter-match every title that happens to contain both letters.
    expect(ids('db').length).toBeLessThan(RECIPES.length / 2);
  });
});
