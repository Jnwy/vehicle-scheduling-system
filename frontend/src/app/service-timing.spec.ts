import { describe, expect, it } from 'vitest';

import type { ServiceResponse, TrackElementResponse } from './models';
import { derivePlatformTimings, nextStartTime, savedTimingsAreStale } from './service-timing';

function elements(blockSeconds: Record<string, number | null> = {}): TrackElementResponse[] {
  const block = (id: string): TrackElementResponse => ({
    id,
    elementType: 'BLOCK',
    traversalSeconds: id in blockSeconds ? blockSeconds[id] : 20,
    interlockingGroup: null,
  });
  const platform = (id: string): TrackElementResponse => ({
    id, elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null,
  });
  return [
    { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
    block('B1'), block('B3'), block('B5'),
    platform('P1A'), platform('P2A'),
  ];
}

const dwell = (entries: [number, number | null][]) => new Map(entries);

describe('nextStartTime', () => {
  it('rounds up to the next five-minute boundary in Taipei wall-clock time', () => {
    // 2026-10-03 00:57:30 UTC is 08:57:30 in Taipei.
    expect(nextStartTime(Date.UTC(2026, 9, 3, 0, 57, 30))).toBe('2026-10-03T09:00:00');
  });

  it('moves to the following boundary when already on one', () => {
    expect(nextStartTime(Date.UTC(2026, 9, 3, 1, 0, 0))).toBe('2026-10-03T09:05:00');
  });

  it('crosses Taipei midnight into the next date', () => {
    // 15:58 UTC is 23:58 in Taipei.
    expect(nextStartTime(Date.UTC(2026, 9, 3, 15, 58, 0))).toBe('2026-10-04T00:00:00');
  });
});

describe('derivePlatformTimings', () => {
  it('accumulates block traversal and platform dwell along the path', () => {
    const result = derivePlatformTimings(
      '2026-10-03T09:00:00',
      ['Y', 'B1', 'P1A', 'B3', 'B5', 'P2A'],
      elements({ B5: 60 }),
      dwell([[2, 60], [5, 30]]),
    );

    expect(result.error).toBe('');
    expect(result.timings).toEqual([
      { pathIndex: 2, arrivalTime: '2026-10-03T09:00:20+08:00', departureTime: '2026-10-03T09:01:20+08:00' },
      { pathIndex: 5, arrivalTime: '2026-10-03T09:02:40+08:00', departureTime: '2026-10-03T09:03:10+08:00' },
    ]);
  });

  it('keeps repeated visits to one platform distinct by path index', () => {
    const result = derivePlatformTimings(
      '2026-10-03T09:00:00',
      ['P1A', 'B1', 'Y', 'B1', 'P1A'],
      elements(),
      dwell([[0, 10], [4, 0]]),
    );

    expect(result.timings.map((timing) => timing.pathIndex)).toEqual([0, 4]);
    expect(result.timings[1]).toEqual({
      pathIndex: 4,
      arrivalTime: '2026-10-03T09:00:50+08:00',
      departureTime: '2026-10-03T09:00:50+08:00',
    });
  });

  it('accepts a start time without seconds', () => {
    const result = derivePlatformTimings('2026-10-03T09:00', ['Y', 'B1', 'P1A'], elements(), dwell([[2, 0]]));

    expect(result.timings[0].arrivalTime).toBe('2026-10-03T09:00:20+08:00');
  });

  it('reports every unconfigured block on the path once', () => {
    const result = derivePlatformTimings(
      '2026-10-03T09:00:00',
      ['Y', 'B1', 'P1A', 'B1', 'Y'],
      elements({ B1: null }),
      dwell([[2, 60]]),
    );

    expect(result.timings).toEqual([]);
    expect(result.missingBlockIds).toEqual(['B1']);
    expect(result.error).toContain('B1');
  });

  it.each([
    ['missing', undefined],
    ['blank', null],
    ['negative', -1],
    ['not a number', Number.NaN],
  ])('rejects a %s dwell value', (_label, value) => {
    const entries: [number, number | null][] = value === undefined ? [] : [[2, value]];

    const result = derivePlatformTimings('2026-10-03T09:00:00', ['Y', 'B1', 'P1A'], elements(), dwell(entries));

    expect(result.timings).toEqual([]);
    expect(result.error).toContain('P1A');
  });

  it('rejects an invalid start time', () => {
    const result = derivePlatformTimings('', ['Y', 'B1', 'P1A'], elements(), dwell([[2, 60]]));

    expect(result.error).toBe('Enter a valid start time.');
  });

  it('rejects an unknown track element', () => {
    const result = derivePlatformTimings('2026-10-03T09:00:00', ['Y', 'B99'], elements(), dwell([]));

    expect(result.error).toBe('Unknown track element: B99.');
  });
});

describe('savedTimingsAreStale', () => {
  const saved: Pick<ServiceResponse, 'startTime' | 'path' | 'platformTimings'> = {
    startTime: '2026-10-03T09:00:00+08:00',
    path: ['Y', 'B1', 'P1A', 'B3', 'B5', 'P2A'],
    platformTimings: [
      { pathIndex: 2, arrivalTime: '2026-10-03T09:00:20+08:00', departureTime: '2026-10-03T09:01:20+08:00' },
      { pathIndex: 5, arrivalTime: '2026-10-03T09:02:00+08:00', departureTime: '2026-10-03T09:03:00+08:00' },
    ],
  };

  it('is false when the snapshot matches the current block configuration', () => {
    expect(savedTimingsAreStale(saved, elements())).toBe(false);
  });

  it('is true when a block before the first platform was reconfigured', () => {
    expect(savedTimingsAreStale(saved, elements({ B1: 30 }))).toBe(true);
  });

  it('is true when a block was shortened, so saved arrivals are too late', () => {
    expect(savedTimingsAreStale(saved, elements({ B1: 10 }))).toBe(true);
  });

  it('is true when a block between platforms was reconfigured', () => {
    expect(savedTimingsAreStale(saved, elements({ B5: 60 }))).toBe(true);
  });

  it('compares instants, not timestamp text', () => {
    const utc = {
      ...saved,
      startTime: '2026-10-03T01:00:00Z',
    };

    expect(savedTimingsAreStale(utc, elements())).toBe(false);
  });

  it('is true when a platform on the path has no saved timing', () => {
    const missing = { ...saved, platformTimings: saved.platformTimings.slice(0, 1) };

    expect(savedTimingsAreStale(missing, elements())).toBe(true);
  });

  it('does not judge a path whose block is unconfigured', () => {
    expect(savedTimingsAreStale(saved, elements({ B1: null }))).toBe(false);
  });
});
