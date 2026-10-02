import { describe, expect, it } from 'vitest';

import type { TopologyResponse, TrackElementResponse } from './models';
import { MAX_PATH_ELEMENTS, nextPathSteps, pathLengthProblems, visitLabel, withoutLastStep } from './path-steps';

const element = (id: string): TrackElementResponse => ({
  id,
  elementType: id.startsWith('B') ? 'BLOCK' : id.startsWith('P') ? 'PLATFORM' : 'YARD',
  traversalSeconds: id.startsWith('B') ? 20 : null,
  interlockingGroup: null,
});

function topologyOf(...edges: [string, string][]): TopologyResponse {
  const ids = [...new Set(edges.flat())];
  return {
    elements: ids.map(element),
    connections: edges.map(([fromElementId, toElementId]) => ({ fromElementId, toElementId })),
  };
}

// The assignment's shape around station 1 and the fork after P2A.
const topology = topologyOf(
  ['Y', 'B1'], ['B1', 'Y'], ['B1', 'P1A'], ['P1A', 'B1'],
  ['P1A', 'B3'], ['B3', 'B5'], ['B5', 'P2A'],
  ['P2A', 'B6'], ['B6', 'B7'], ['B7', 'P3A'], ['B6', 'B8'], ['B8', 'P3B'],
);
const stepsFrom = (...path: string[]) => Object.fromEntries(nextPathSteps(path, topology));

describe('nextPathSteps', () => {
  it('offers every platform and yard, but no block, as a possible start', () => {
    expect(stepsFrom()).toEqual({ Y: ['Y'], P1A: ['P1A'], P2A: ['P2A'], P3A: ['P3A'], P3B: ['P3B'] });
  });

  it('offers the next stops with the blocks leading to them', () => {
    expect(stepsFrom('Y')).toEqual({ P1A: ['B1', 'P1A'] });
    expect(stepsFrom('Y', 'B1', 'P1A')).toEqual({ Y: ['B1', 'Y'], P2A: ['B3', 'B5', 'P2A'] });
  });

  it('does not offer reversing in a block back to the same stop', () => {
    const twoWaysOut = topologyOf(['Y', 'B1'], ['B1', 'Y'], ['Y', 'B2'], ['B2', 'Y'], ['B1', 'P1A'], ['B2', 'P1B']);
    expect(Object.fromEntries(nextPathSteps(['Y'], twoWaysOut))).toEqual({ P1A: ['B1', 'P1A'], P1B: ['B2', 'P1B'] });
  });

  it('follows a fork to a separate stop on each branch', () => {
    expect(stepsFrom('P2A')).toEqual({ P3A: ['B6', 'B7', 'P3A'], P3B: ['B6', 'B8', 'P3B'] });
  });

  it('continues from a path that currently ends on a block', () => {
    expect(stepsFrom('B6')).toEqual({ P3A: ['B7', 'P3A'], P3B: ['B8', 'P3B'] });
  });

  it('follows connection direction', () => {
    expect(stepsFrom('P3A')).toEqual({});
  });

  it('falls back to single elements when a stop can be reached more than one way', () => {
    const forked = topologyOf(['P1', 'B1'], ['P1', 'B2'], ['B1', 'P2'], ['B2', 'P2'], ['B2', 'P3']);
    expect(Object.fromEntries(nextPathSteps(['P1'], forked))).toEqual({ P3: ['B2', 'P3'], B1: ['B1'], B2: ['B2'] });
    expect(Object.fromEntries(nextPathSteps(['P1', 'B1'], forked))).toEqual({ P2: ['P2'] });
  });

  it('does not loop on a cycle of blocks', () => {
    const cyclic = topologyOf(['P1', 'B1'], ['B1', 'B2'], ['B2', 'B1'], ['B2', 'P2']);
    expect(Object.fromEntries(nextPathSteps(['P1'], cyclic))).toEqual({ P2: ['B1', 'B2', 'P2'] });
  });
});

describe('withoutLastStep', () => {
  it('removes the last stop together with the blocks that led to it', () => {
    expect(withoutLastStep(['Y', 'B1', 'P1A', 'B3', 'B5', 'P2A'], topology)).toEqual(['Y', 'B1', 'P1A']);
    expect(withoutLastStep(['Y', 'B1', 'P1A'], topology)).toEqual(['Y']);
  });

  it('keeps a block the path starts on until it is the only element', () => {
    expect(withoutLastStep(['B6', 'B7', 'P3A'], topology)).toEqual(['B6']);
    expect(withoutLastStep(['B6'], topology)).toEqual([]);
    expect(withoutLastStep([], topology)).toEqual([]);
  });
});

describe('pathLengthProblems', () => {
  it('accepts a path at the limit', () => {
    expect(pathLengthProblems(Array.from({ length: MAX_PATH_ELEMENTS }, () => 'Y'))).toEqual([]);
  });

  it('reports a path over the limit with both numbers', () => {
    expect(pathLengthProblems(Array.from({ length: MAX_PATH_ELEMENTS + 1 }, () => 'Y'))).toEqual([
      'The path has 201 elements; a service path can have at most 200.',
    ]);
  });
});

describe('visitLabel', () => {
  it('lists every step of an element visited a few times', () => {
    expect(visitLabel([4])).toBe('4');
    expect(visitLabel([1, 13, 25])).toBe('1,13,25');
  });

  it('shortens the list for an element visited many times', () => {
    expect(visitLabel([1, 13, 25, 37])).toBe('1,13,25 +1');
    expect(visitLabel([1, 13, 25, 37, 49, 61, 73])).toBe('1,13,25 +4');
  });

  it('is empty for an element that is not on the path', () => {
    expect(visitLabel([])).toBe('');
  });
});
