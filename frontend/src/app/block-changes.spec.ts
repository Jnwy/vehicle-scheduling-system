import { describe, expect, it } from 'vitest';

import { blockChanges, describeBlockChanges, parseTraversalSeconds, stageBlockTime } from './block-changes';

const saved = { B1: 20, B2: 20, B10: 20 };

describe('parseTraversalSeconds', () => {
  it.each([['0', 0], ['25', 25], [' 7 ', 7]])('reads %j as %s seconds', (value, seconds) => {
    expect(parseTraversalSeconds(value)).toBe(seconds);
  });

  it.each(['', '  ', '-1', '1.5', 'abc'])('rejects %j', (value) => {
    expect(typeof parseTraversalSeconds(value)).toBe('string');
  });
});

describe('stageBlockTime', () => {
  it('adds a changed block without touching the others', () => {
    const pending = { B2: 30 };

    expect(stageBlockTime(pending, saved, 'B1', 25)).toEqual({ B1: 25, B2: 30 });
    expect(pending).toEqual({ B2: 30 });
  });

  it('replaces an earlier unsaved value for the same block', () => {
    expect(stageBlockTime({ B1: 25 }, saved, 'B1', 40)).toEqual({ B1: 40 });
  });

  it('drops a block typed back to its saved value', () => {
    expect(stageBlockTime({ B1: 25, B2: 30 }, saved, 'B1', 20)).toEqual({ B2: 30 });
  });
});

describe('blockChanges', () => {
  it('lists the changes in natural block order', () => {
    expect(blockChanges({ B10: 5, B2: 30, B1: 25 })).toEqual([
      { id: 'B1', traversalSeconds: 25 }, { id: 'B2', traversalSeconds: 30 }, { id: 'B10', traversalSeconds: 5 },
    ]);
  });

  it('describes each change with the saved value it replaces', () => {
    expect(describeBlockChanges({ B10: 5, B1: 25 }, saved)).toEqual(['B1: 20s → 25s', 'B10: 20s → 5s']);
  });
});
