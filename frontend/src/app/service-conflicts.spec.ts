import { describe, expect, it } from 'vitest';

import type { ServiceResponse, TopologyResponse, TrackElementResponse } from './models';
import {
  ScheduleWindow, blockedNextElements, candidateTimeline, deletionProblem, interlockingConflicts, pathEndpointProblems,
  savedWindow,
  vehicleProblems,
} from './service-conflicts';

const at = (time: string) => Date.parse(`2026-10-03T${time}+08:00`);
const iso = (time: string) => `2026-10-03T${time}+08:00`;

const block = (id: string, interlockingGroup: string | null): TrackElementResponse => ({
  id, elementType: 'BLOCK', traversalSeconds: 20, interlockingGroup,
});
const elements: TrackElementResponse[] = [
  { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
  { id: 'P1A', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
  block('B1', null), block('B3', 'IG1'), block('B4', 'IG1'), block('B5', 'IG2'),
];

// A saved service whose timeline is given as [element, start, end] rows.
function saved(id: number, vehicleId: string, rows: [string, string, string][]): ServiceResponse {
  return {
    id, vehicleId, startTime: iso(rows[0][1]), path: rows.map(([elementId]) => elementId), platformTimings: [],
    timeline: rows.map(([elementId, start, end], pathIndex) => ({
      pathIndex, elementId, startTime: iso(start), endTime: iso(end),
    })),
  };
}

describe('candidateTimeline', () => {
  it('gives the yard no duration, blocks their traversal time, and platforms their dwell', () => {
    const timeline = candidateTimeline('2026-10-03T08:00:00', ['Y', 'B1', 'P1A', 'B3'], elements, new Map([[2, 30]]));
    expect(timeline?.map((interval) => [interval.elementId, interval.start, interval.end])).toEqual([
      ['Y', at('08:00:00'), at('08:00:00')],
      ['B1', at('08:00:00'), at('08:00:20')],
      ['P1A', at('08:00:20'), at('08:00:50')],
      ['B3', at('08:00:50'), at('08:01:10')],
    ]);
  });

  it('returns null while the inputs cannot produce a timeline', () => {
    expect(candidateTimeline('', ['Y', 'B1'], elements, new Map())).toBeNull();
    expect(candidateTimeline('2026-10-03T08:00:00', ['Y', 'B1', 'P1A'], elements, new Map())).toBeNull();
  });
});

describe('interlocking previews', () => {
  const v1InGroup = saved(1, 'V1', [['P1A', '08:00:00', '08:00:30'], ['B3', '08:00:30', '08:00:50']]);
  const timelineAt = (start: string, path = ['P1A', 'B4']) =>
    candidateTimeline(`2026-10-03T${start}`, path, elements, new Map([[0, 0]]))!;

  it('reports a different block of the same group held by another vehicle', () => {
    expect(interlockingConflicts(timelineAt('08:00:40'), 'V2', [v1InGroup], elements, null)).toEqual([{
      pathIndex: 1, elementId: 'B4', group: 'IG1', serviceId: 1, vehicleId: 'V1',
      start: at('08:00:30'), end: at('08:00:50'),
    }]);
  });

  it('allows touching intervals, other groups, ungrouped blocks, and the same vehicle', () => {
    expect(interlockingConflicts(timelineAt('08:00:50'), 'V2', [v1InGroup], elements, null)).toEqual([]);
    expect(interlockingConflicts(timelineAt('08:00:10'), 'V2', [v1InGroup], elements, null)).toEqual([]);
    expect(interlockingConflicts(timelineAt('08:00:40', ['P1A', 'B1']), 'V2', [v1InGroup], elements, null)).toEqual([]);
    expect(interlockingConflicts(timelineAt('08:00:40'), 'V1', [v1InGroup], elements, null)).toEqual([]);
  });

  it('ignores the service being replaced by an update', () => {
    expect(interlockingConflicts(timelineAt('08:00:40'), 'V2', [v1InGroup], elements, 1)).toEqual([]);
  });

  // Y -> B1 -> P1A, then P1A -> B3 -> B5 -> P2A or P1A -> B4 -> P2B; B3 and B4 share IG1.
  const stops: TopologyResponse = {
    elements: [
      ...elements,
      { id: 'P2A', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
      { id: 'P2B', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
    ],
    connections: [
      { fromElementId: 'Y', toElementId: 'B1' },
      { fromElementId: 'B1', toElementId: 'P1A' },
      { fromElementId: 'P1A', toElementId: 'B3' },
      { fromElementId: 'B3', toElementId: 'B5' },
      { fromElementId: 'B5', toElementId: 'P2A' },
      { fromElementId: 'P1A', toElementId: 'B4' },
      { fromElementId: 'B4', toElementId: 'P2B' },
    ],
  };

  it('blocks a next stop when a block on the way to it is in a held group', () => {
    const blocked = blockedNextElements(['P1A'], at('08:00:40'), 'V2', [v1InGroup], stops, null);
    expect([...blocked.keys()]).toEqual(['P2A', 'P2B']);
    expect(blocked.get('P2B')).toMatchObject({ pathIndex: 1, elementId: 'B4', group: 'IG1', serviceId: 1 });
    expect(blockedNextElements(['P1A'], at('08:00:50'), 'V2', [v1InGroup], stops, null).size).toBe(0);
  });

  it('enters each block on the way at the time the earlier blocks are cleared', () => {
    // From Y at 08:00:20, B1 is ungrouped; P1A is reached without entering IG1.
    expect(blockedNextElements(['Y'], at('08:00:20'), 'V2', [v1InGroup], stops, null).size).toBe(0);
    // A path leaving P1A at 08:00:50 clears B3 at 08:01:10 and enters B5 while its group is held.
    const v1InB5 = saved(2, 'V1', [['B5', '08:01:10', '08:01:30']]);
    const blocked = blockedNextElements(['P1A'], at('08:00:50'), 'V2', [v1InB5], stops, null);
    expect([...blocked.keys()]).toEqual(['P2A']);
    expect(blocked.get('P2A')).toMatchObject({ pathIndex: 2, elementId: 'B5', group: 'IG2' });
    expect(blockedNextElements(['P1A'], at('08:00:20'), 'V2', [v1InB5], stops, null).size).toBe(0);
  });

  it('blocks no starting element, because a path starts at a stop', () => {
    expect(blockedNextElements([], at('08:00:40'), 'V2', [v1InGroup], stops, null).size).toBe(0);
  });
});

describe('same-vehicle previews', () => {
  const window = (
    serviceId: number | null, start: string, end: string, startElementId: string, endElementId: string,
    vehicleId = 'V1',
  ): ScheduleWindow => ({ serviceId, vehicleId, start: at(start), end: at(end), startElementId, endElementId });
  const first = window(1, '08:00:00', '08:10:00', 'Y', 'P1A');
  const second = window(2, '09:00:00', '09:10:00', 'P1A', 'Y');

  it('reads a saved service from the ends of its timeline', () => {
    expect(savedWindow(saved(7, 'V1', [['Y', '08:00:00', '08:00:00'], ['B1', '08:00:00', '08:00:20']]))).toEqual(
      window(7, '08:00:00', '08:00:20', 'Y', 'B1'),
    );
  });

  it('accepts a service that fits between its neighbours', () => {
    expect(vehicleProblems(window(null, '08:10:00', '09:00:00', 'P1A', 'P1A'), [first, second])).toEqual([]);
  });

  it('reports an overlap, including a zero-duration service inside another', () => {
    const overlapping = window(null, '08:05:00', '08:20:00', 'P1A', 'P1A');
    expect(vehicleProblems(overlapping, [first, second])).toEqual([{ kind: 'overlap', service: overlapping, other: first }]);
    const instant = window(null, '08:05:00', '08:05:00', 'Y', 'Y');
    expect(vehicleProblems(instant, [first])[0]?.kind).toBe('overlap');
    expect(vehicleProblems(window(null, '08:10:00', '08:10:00', 'P1A', 'P1A'), [first])).toEqual([]);
  });

  it('reports a start that does not continue from the predecessor', () => {
    const candidate = window(null, '08:20:00', '08:30:00', 'Y', 'P1A');
    expect(vehicleProblems(candidate, [first, second])).toEqual([{ kind: 'continuity', from: first, to: candidate }]);
  });

  it('reports an end that does not connect to the successor', () => {
    const candidate = window(null, '08:20:00', '08:30:00', 'P1A', 'B3');
    expect(vehicleProblems(candidate, [first, second])).toEqual([{ kind: 'continuity', from: candidate, to: second }]);
  });

  it('ignores other vehicles', () => {
    expect(vehicleProblems(window(null, '08:05:00', '08:20:00', 'B3', 'B3', 'V2'), [first, second])).toEqual([]);
  });

  it('lets an update replace its original in place', () => {
    expect(vehicleProblems(window(1, '08:00:00', '08:15:00', 'Y', 'P1A'), [first, second])).toEqual([]);
  });

  it('reports the gap left behind when an update moves a bridging service away', () => {
    const bridge = window(3, '08:20:00', '08:30:00', 'P1A', 'B3');
    const after = window(4, '09:00:00', '09:10:00', 'B3', 'Y');
    const moved = window(3, '10:00:00', '10:10:00', 'Y', 'Y');
    expect(vehicleProblems(moved, [first, bridge, after])).toEqual([{ kind: 'continuity', from: first, to: after }]);
    const reassigned = { ...bridge, vehicleId: 'V2' };
    expect(vehicleProblems(reassigned, [first, bridge, after])).toEqual([{ kind: 'continuity', from: first, to: after }]);
  });

  it('rejects a deletion only when it leaves two disconnected neighbours', () => {
    const bridge = window(3, '08:20:00', '08:30:00', 'P1A', 'B3');
    const after = window(4, '09:00:00', '09:10:00', 'B3', 'Y');
    const all = [first, bridge, after];
    expect(deletionProblem(bridge, all)).toEqual({ kind: 'continuity', from: first, to: after });
    expect(deletionProblem(first, all)).toBeNull();
    expect(deletionProblem(after, all)).toBeNull();
    const loop = window(5, '08:20:00', '08:30:00', 'P1A', 'P1A');
    expect(deletionProblem(loop, [first, loop, second])).toBeNull();
  });
});

describe('pathEndpointProblems', () => {
  it('accepts a path that starts and ends at a yard or platform', () => {
    expect(pathEndpointProblems(['Y', 'B1', 'P1A'], elements)).toEqual([]);
    expect(pathEndpointProblems(['P1A', 'B1', 'P1A'], elements)).toEqual([]);
  });

  it('rejects a path that ends on a block', () => {
    expect(pathEndpointProblems(['Y', 'B1'], elements))
      .toEqual(['The path must end at a yard or platform; B1 is a block.']);
  });

  it('rejects a path that starts on a block', () => {
    expect(pathEndpointProblems(['B1', 'P1A'], elements))
      .toEqual(['The path must start at a yard or platform; B1 is a block.']);
  });

  it('reports both ends', () => {
    expect(pathEndpointProblems(['B3', 'B5'], elements)).toHaveLength(2);
  });

  it('reports a lone block once, as a bad start', () => {
    expect(pathEndpointProblems(['B1'], elements))
      .toEqual(['The path must start at a yard or platform; B1 is a block.']);
  });

  it('has nothing to say about an empty path or a lone yard', () => {
    expect(pathEndpointProblems([], elements)).toEqual([]);
    expect(pathEndpointProblems(['Y'], elements)).toEqual([]);
  });
});
