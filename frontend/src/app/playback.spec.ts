import { describe, expect, it } from 'vitest';

import type { ScheduleAnalysis, ScheduleConflict, SimulationSegment, TopologyResponse } from './models';
import { conflictsAt, playbackSliderPosition, scheduleRange, vehicleStatesAt } from './playback';

const at = (seconds: number) => `2026-10-03T09:00:${String(seconds).padStart(2, '0')}+08:00`;
const ms = (seconds: number) => Date.parse(at(seconds));

const topology: TopologyResponse = {
  elements: [
    { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
    { id: 'B1', elementType: 'BLOCK', traversalSeconds: 20, interlockingGroup: 'IG1' },
    { id: 'B2', elementType: 'BLOCK', traversalSeconds: 20, interlockingGroup: 'IG1' },
    { id: 'P1A', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
  ],
  connections: [],
};

function segment(
  elementId: string, start: number, end: number, batteryStart: number, batteryEnd: number,
  overrides: Partial<SimulationSegment> = {},
): SimulationSegment {
  return {
    segmentType: 'SERVICE', serviceId: 1, pathIndex: 0, elementId,
    startTime: at(start), endTime: at(end), batteryStart, batteryEnd,
    ...overrides,
  };
}

function analysis(overrides: Partial<ScheduleAnalysis> = {}): ScheduleAnalysis {
  return {
    startTime: at(0),
    endTime: at(50),
    vehicles: [{
      vehicleId: 'V1',
      segments: [
        segment('Y', 0, 0, 80, 80),
        segment('B1', 0, 20, 80, 79),
        segment('P1A', 20, 40, 79, 79),
        segment('P1A', 40, 50, 79, 79, { segmentType: 'IDLE', serviceId: null, pathIndex: null }),
      ],
    }],
    conflicts: [],
    ...overrides,
  };
}

describe('scheduleRange', () => {
  it('returns the schedule bounds in milliseconds', () => {
    expect(scheduleRange(analysis())).toEqual({ start: ms(0), end: ms(50) });
  });

  it('is null for an empty schedule', () => {
    expect(scheduleRange(analysis({ startTime: null, endTime: null }))).toBeNull();
  });
});

describe('vehicleStatesAt', () => {
  it('returns nothing without a playback instant', () => {
    expect(vehicleStatesAt(analysis(), topology, null)).toEqual([]);
  });

  it('enters a block from the previous element during the first half of its time', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(5));

    expect(state).toEqual({
      vehicleId: 'V1', serviceId: 1, elementId: 'B1',
      fromElementId: 'Y', toElementId: 'B1', progress: 0.5, battery: 79.75,
    });
  });

  it('leaves a block towards the next element during the second half of its time', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(15));

    expect(state).toEqual({
      vehicleId: 'V1', serviceId: 1, elementId: 'B1',
      fromElementId: 'B1', toElementId: 'P1A', progress: 0.5, battery: 79.25,
    });
  });

  it('prefers the non-empty segment over a zero-length one at the same instant', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(0));

    expect(state).toMatchObject({ elementId: 'B1', fromElementId: 'Y', progress: 0 });
  });

  it('keeps a vehicle still on a platform', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(30));

    expect(state).toMatchObject({ elementId: 'P1A', fromElementId: 'P1A', toElementId: 'P1A', progress: 0, battery: 79 });
  });

  it('spends the whole time of a final block travelling in from the previous element', () => {
    const endingOnBlock = analysis({
      vehicles: [{
        vehicleId: 'V1',
        segments: [segment('P1A', 0, 20, 80, 80), segment('B1', 20, 40, 80, 79)],
      }],
    });

    expect(vehicleStatesAt(endingOnBlock, topology, ms(20))[0])
      .toMatchObject({ elementId: 'B1', fromElementId: 'P1A', toElementId: 'B1', progress: 0 });
    expect(vehicleStatesAt(endingOnBlock, topology, ms(30))[0])
      .toMatchObject({ elementId: 'B1', fromElementId: 'P1A', toElementId: 'B1', progress: 0.5 });
  });

  it('spends the whole time of a first block travelling out to the next element', () => {
    const startingOnBlock = analysis({
      vehicles: [{
        vehicleId: 'V1',
        segments: [segment('B1', 0, 20, 80, 79), segment('P1A', 20, 40, 79, 79)],
      }],
    });

    expect(vehicleStatesAt(startingOnBlock, topology, ms(10))[0])
      .toMatchObject({ fromElementId: 'B1', toElementId: 'P1A', progress: 0.5 });
  });

  it('hands over between consecutive blocks halfway between their nodes', () => {
    const blockToBlock = analysis({
      vehicles: [{
        vehicleId: 'V1',
        segments: [
          segment('Y', 0, 0, 80, 80),
          segment('B1', 0, 20, 80, 79),
          segment('B2', 20, 40, 79, 78),
          segment('P1A', 40, 50, 78, 78),
        ],
      }],
    });

    // Just before and at the boundary the marker is at the same point on B1 -> B2.
    expect(vehicleStatesAt(blockToBlock, topology, ms(19))[0])
      .toMatchObject({ elementId: 'B1', fromElementId: 'B1', toElementId: 'B2' });
    expect(vehicleStatesAt(blockToBlock, topology, ms(19))[0].progress).toBeCloseTo(0.45);
    expect(vehicleStatesAt(blockToBlock, topology, ms(20))[0])
      .toMatchObject({ elementId: 'B2', fromElementId: 'B1', toElementId: 'B2', progress: 0.5 });
    expect(vehicleStatesAt(blockToBlock, topology, ms(35))[0])
      .toMatchObject({ elementId: 'B2', fromElementId: 'B2', toElementId: 'P1A', progress: 0.5 });
  });

  it('keeps a vehicle still on a block with no neighbouring segments', () => {
    const lone = analysis({
      vehicles: [{ vehicleId: 'V1', segments: [segment('B1', 0, 20, 80, 79)] }],
    });

    expect(vehicleStatesAt(lone, topology, ms(10))[0])
      .toMatchObject({ fromElementId: 'B1', toElementId: 'B1', progress: 0 });
  });

  it('uses half-open segments at a boundary', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(20));

    expect(state.elementId).toBe('P1A');
  });

  it('reports an idle vehicle at its final location without a service', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(45));

    expect(state).toMatchObject({ serviceId: null, elementId: 'P1A' });
  });

  it('still shows the vehicle at the exact end of its last segment', () => {
    const [state] = vehicleStatesAt(analysis(), topology, ms(50));

    expect(state.elementId).toBe('P1A');
  });

  it('omits a vehicle outside all of its segments', () => {
    const late = analysis({
      vehicles: [{ vehicleId: 'V2', segments: [segment('B1', 30, 50, 80, 79)] }],
    });

    expect(vehicleStatesAt(late, topology, ms(10))).toEqual([]);
  });

  it('shows a vehicle whose only segment is zero-length at that instant', () => {
    const point = analysis({
      vehicles: [{ vehicleId: 'V1', segments: [segment('Y', 5, 5, 80, 80)] }],
    });

    expect(vehicleStatesAt(point, topology, ms(5))).toHaveLength(1);
    expect(vehicleStatesAt(point, topology, ms(6))).toEqual([]);
  });
});

describe('conflictsAt', () => {
  const conflict = (start: number, end: number): ScheduleConflict => ({
    conflictType: 'BLOCK_OCCUPANCY', resourceId: 'B1', startTime: at(start), endTime: at(end),
    vehicleIds: ['V1', 'V2'], serviceIds: [1, 2], elementIds: ['B1'], message: 'Block B1 is occupied by multiple vehicles.',
  });

  it('returns nothing without a playback instant', () => {
    expect(conflictsAt(analysis({ conflicts: [conflict(10, 20)] }), null)).toEqual([]);
  });

  it('treats a conflict interval as half-open', () => {
    const withConflict = analysis({ conflicts: [conflict(10, 20)] });

    expect(conflictsAt(withConflict, ms(9))).toHaveLength(0);
    expect(conflictsAt(withConflict, ms(10))).toHaveLength(1);
    expect(conflictsAt(withConflict, ms(19))).toHaveLength(1);
    expect(conflictsAt(withConflict, ms(20))).toHaveLength(0);
  });

  it('matches a zero-length conflict only at its instant', () => {
    const withConflict = analysis({ conflicts: [conflict(10, 10)] });

    expect(conflictsAt(withConflict, ms(10))).toHaveLength(1);
    expect(conflictsAt(withConflict, ms(11))).toHaveLength(0);
  });
});

describe('playbackSliderPosition', () => {
  const range = { start: ms(0), end: ms(50) };

  it('maps the instant onto a 0-1000 scale', () => {
    expect(playbackSliderPosition(range, ms(0))).toBe(0);
    expect(playbackSliderPosition(range, ms(25))).toBe(500);
    expect(playbackSliderPosition(range, ms(50))).toBe(1000);
  });

  it('is zero when there is no range, no instant, or an empty range', () => {
    expect(playbackSliderPosition(null, ms(10))).toBe(0);
    expect(playbackSliderPosition(range, null)).toBe(0);
    expect(playbackSliderPosition({ start: ms(5), end: ms(5) }, ms(5))).toBe(0);
  });
});
