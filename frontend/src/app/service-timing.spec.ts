import { describe, expect, it } from 'vitest';

import type { ServiceResponse, TrackElementResponse } from './models';
import {
  busyTimeOptions, calendarMonthCells, composeStartTime, daysInMonth, derivePlatformTimings, freeInstantWithin, nextFreeInstant, nextStartTime, startPartRange, savedTimingsAreStale, splitStartTime, staleServices, vehicleBusyWindows,
  vehicleContinuation, vehiclePositionAt, vehicleSlots,
} from './service-timing';

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

describe('vehicleContinuation', () => {
  const service = (vehicleId: string, startTime: string, path: string[], endTime: string) => ({
    vehicleId,
    startTime,
    path,
    timeline: [{ pathIndex: path.length - 1, elementId: path[path.length - 1], startTime, endTime }],
  });

  it('returns null when the vehicle has no services', () => {
    const services = [service('V2', '2026-10-03T08:00:00+08:00', ['Y', 'B1', 'P1A'], '2026-10-03T08:05:00+08:00')];
    expect(vehicleContinuation(services, 'V1')).toBeNull();
  });

  it('uses the end time and end location of the latest service, regardless of list order', () => {
    const services = [
      service('V1', '2026-10-03T09:00:00+08:00', ['P1A', 'B3', 'P2A'], '2026-10-03T09:10:00+08:00'),
      service('V1', '2026-10-03T08:00:00+08:00', ['Y', 'B1', 'P1A'], '2026-10-03T08:05:00+08:00'),
      service('V2', '2026-10-03T10:00:00+08:00', ['Y', 'B1'], '2026-10-03T10:20:00+08:00'),
    ];
    expect(vehicleContinuation(services, 'V1')).toEqual({ startTime: '2026-10-03T09:10:00', elementId: 'P2A' });
  });

  it('rounds a fractional end up to the next whole second', () => {
    const services = [service('V1', '2026-10-03T08:00:00+08:00', ['Y', 'B1'], '2026-10-03T08:00:20.500+08:00')];
    expect(vehicleContinuation(services, 'V1')?.startTime).toBe('2026-10-03T08:00:21');
  });
});

describe('start time parts', () => {
  it('splits and recomposes a start time', () => {
    const parts = splitStartTime('2026-10-03T08:05:09');
    expect(parts).toEqual({ year: 2026, month: 10, day: 3, hour: 8, minute: 5, second: 9 });
    expect(composeStartTime(parts)).toBe('2026-10-03T08:05:09');
  });

  it('knows month lengths, including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(daysInMonth(null, 2)).toBe(31);
  });

  it('lays a month out Sunday first', () => {
    // 1 October 2026 is a Thursday; 1 February 2026 is a Sunday.
    const october = calendarMonthCells(2026, 10);
    expect(october.slice(0, 6)).toEqual([null, null, null, null, 1, 2]);
    expect(october).toHaveLength(4 + 31);
    expect(calendarMonthCells(2026, 2)[0]).toBe(1);
    expect(calendarMonthCells(2028, 2).at(-1)).toBe(29);
  });

  it('defaults missing seconds to zero', () => {
    expect(splitStartTime('2026-10-03T08:05').second).toBe(0);
  });

  it('rejects an empty field, a non-existent date, and an out-of-range time', () => {
    const valid = splitStartTime('2026-02-28T08:00:00');
    expect(composeStartTime({ ...valid, minute: null })).toBe('');
    expect(composeStartTime({ ...valid, day: 30 })).toBe('');
    expect(composeStartTime({ ...valid, hour: 24 })).toBe('');
    expect(composeStartTime({ ...valid, second: 1.5 })).toBe('');
  });
});

describe('vehicle availability', () => {
  const at = (time: string) => Date.parse(`2026-10-03T${time}+08:00`);
  const service = (id: number, vehicleId: string, start: string, end: string, path: string[]) => ({
    id,
    vehicleId,
    startTime: `2026-10-03T${start}+08:00`,
    path,
    timeline: [{
      pathIndex: path.length - 1,
      elementId: path[path.length - 1],
      startTime: `2026-10-03T${start}+08:00`,
      endTime: `2026-10-03T${end}+08:00`,
    }],
  });
  const services = [
    service(2, 'V1', '09:00:00', '09:10:00', ['P1A', 'B3', 'P2A']),
    service(1, 'V1', '08:00:00', '08:05:00', ['Y', 'B1', 'P1A']),
    service(3, 'V2', '08:00:00', '10:00:00', ['Y', 'B1']),
  ];

  it('lists only the vehicle\'s services in time order and can leave one out', () => {
    expect(vehicleBusyWindows(services, 'V1').map((window) => window.serviceId)).toEqual([1, 2]);
    expect(vehicleBusyWindows(services, 'V1', 2).map((window) => window.serviceId)).toEqual([1]);
  });

  it('offers a single open slot for a vehicle without services', () => {
    expect(vehicleSlots([])).toEqual([
      { kind: 'free', start: null, end: null, serviceId: null, elementId: null, nextElementId: null },
    ]);
  });

  it('alternates free and busy slots with the location the vehicle waits at', () => {
    const slots = vehicleSlots(vehicleBusyWindows(services, 'V1'));
    expect(slots.map((slot) => [slot.kind, slot.elementId, slot.nextElementId])).toEqual([
      ['free', null, 'Y'],
      ['busy', 'Y', 'P1A'],
      ['free', 'P1A', 'P1A'],
      ['busy', 'P1A', 'P2A'],
      ['free', 'P2A', null],
    ]);
    expect(slots[2].start).toBe(at('08:05:00'));
    expect(slots[2].end).toBe(at('09:00:00'));
  });

  it('adds no free slot between back-to-back services', () => {
    const backToBack = [services[1], service(4, 'V1', '08:05:00', '08:20:00', ['P1A', 'B3', 'P2A'])];
    expect(vehicleSlots(vehicleBusyWindows(backToBack, 'V1')).map((slot) => slot.kind))
      .toEqual(['free', 'busy', 'busy', 'free']);
  });

  it('disables only the hours, minutes, and seconds that are busy throughout', () => {
    const windows = vehicleBusyWindows([
      service(5, 'V1', '08:00:30', '10:02:10', ['Y', 'B1']),
      service(6, 'V1', '10:02:10', '10:02:20', ['B1', 'B3']),
    ], 'V1');
    const busy = (options: boolean[]) => options.flatMap((value, index) => (value ? [index] : []));

    const at1002 = busyTimeOptions(windows, '2026-10-03', 10, 2);
    // 08:00:00-08:00:29 and 10:02:20 onwards are still free, so only 09 is fully busy.
    expect(busy(at1002.hour)).toEqual([9]);
    expect(busy(at1002.minute)).toEqual([0, 1]);
    // Back-to-back services merge; the end instant 10:02:20 itself is free.
    expect(busy(at1002.second)).toEqual(Array.from({ length: 20 }, (_, index) => index));

    expect(busy(busyTimeOptions(windows, '2026-10-03', 8, 0).second)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 30),
    );
    // Hours and minutes the services only partly cover stay selectable but are marked.
    expect(busy(at1002.partlyBusy.hour)).toEqual([8, 10]);
    expect(busy(at1002.partlyBusy.minute)).toEqual([2]);
    expect(busy(busyTimeOptions(windows, '2026-10-03', 8, 0).partlyBusy.minute)).toEqual([0]);
    const otherDay = busyTimeOptions(windows, '2026-10-04', 9, 0);
    expect([...otherDay.hour, ...otherDay.minute, ...otherDay.second]).not.toContain(true);
    const noDate = busyTimeOptions(windows, '', null, null);
    expect([...noDate.hour, ...noDate.minute, ...noDate.second]).not.toContain(true);
  });

  it('moves a busy start time to the first free second, across back-to-back services', () => {
    const windows = vehicleBusyWindows([
      service(5, 'V1', '08:00:30', '08:10:40', ['Y', 'B1']),
      service(6, 'V1', '08:10:40', '08:12:00.500', ['B1', 'B3']),
    ], 'V1');
    expect(nextFreeInstant(windows, at('08:10:10'))).toBe(at('08:12:01'));
    expect(nextFreeInstant(windows, at('08:00:29'))).toBe(at('08:00:29'));
    expect(nextFreeInstant(windows, at('08:12:01'))).toBe(at('08:12:01'));
    expect(nextFreeInstant([], at('08:10:10'))).toBe(at('08:10:10'));
  });

  it('spans the part that was picked, keeping the larger parts', () => {
    const parts = splitStartTime('2026-10-03T08:10:10');
    expect(startPartRange(parts, 'minute')).toEqual({ start: at('08:10:00'), end: at('08:11:00') });
    expect(startPartRange(parts, 'hour')).toEqual({ start: at('08:00:00'), end: at('09:00:00') });
    expect(startPartRange(parts, 'second')).toEqual({ start: at('08:10:10'), end: at('08:10:11') });
    expect(startPartRange(parts, 'day')).toEqual({
      start: Date.parse('2026-10-03T00:00:00+08:00'), end: Date.parse('2026-10-04T00:00:00+08:00'),
    });
    expect(startPartRange(splitStartTime('2026-12-31T08:10:10'), 'month')).toEqual({
      start: Date.parse('2026-12-01T00:00:00+08:00'), end: Date.parse('2027-01-01T00:00:00+08:00'),
    });
    expect(startPartRange({ ...parts, second: null }, 'minute')).toBeNull();
  });

  it('keeps a busy choice inside the picked part, or reports that it has no free time', () => {
    const windows = vehicleBusyWindows([service(5, 'V1', '08:10:05', '08:12:40', ['Y', 'B1'])], 'V1');
    const within = (time: string, from: string, to: string) => freeInstantWithin(windows, at(time), at(from), at(to));
    // Free already: unchanged.
    expect(within('08:09:10', '08:09:00', '08:10:00')).toBe(at('08:09:10'));
    // Later in the same minute.
    expect(within('08:12:10', '08:12:00', '08:13:00')).toBe(at('08:12:40'));
    // Nothing later in the minute, so the earlier free seconds are used.
    expect(within('08:10:10', '08:10:00', '08:11:00')).toBe(at('08:10:00'));
    // The whole minute is busy.
    expect(within('08:11:10', '08:11:00', '08:12:00')).toBeNull();
    // The same instant is fine when the picked part is the hour.
    expect(within('08:11:10', '08:00:00', '09:00:00')).toBe(at('08:12:40'));
  });

  it('reports the vehicle position using [start, end) windows', () => {
    const windows = vehicleBusyWindows(services, 'V1');
    expect(vehiclePositionAt(windows, at('07:00:00'))).toEqual({ busy: null, elementId: null });
    expect(vehiclePositionAt(windows, at('08:00:00')).busy?.serviceId).toBe(1);
    expect(vehiclePositionAt(windows, at('08:05:00'))).toEqual({ busy: null, elementId: 'P1A' });
    expect(vehiclePositionAt(windows, at('09:05:00')).busy?.serviceId).toBe(2);
    expect(vehiclePositionAt(windows, at('12:00:00'))).toEqual({ busy: null, elementId: 'P2A' });
  });
});

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
  const saved: Pick<ServiceResponse, 'startTime' | 'path' | 'platformTimings' | 'timeline'> = {
    startTime: '2026-10-03T09:00:00+08:00',
    path: ['Y', 'B1', 'P1A', 'B3', 'B5', 'P2A'],
    platformTimings: [
      { pathIndex: 2, arrivalTime: '2026-10-03T09:00:20+08:00', departureTime: '2026-10-03T09:01:20+08:00' },
      { pathIndex: 5, arrivalTime: '2026-10-03T09:02:00+08:00', departureTime: '2026-10-03T09:03:00+08:00' },
    ],
    timeline: [
      ['Y', '09:00:00', '09:00:00'],
      ['B1', '09:00:00', '09:00:20'],
      ['P1A', '09:00:20', '09:01:20'],
      ['B3', '09:01:20', '09:01:40'],
      ['B5', '09:01:40', '09:02:00'],
      ['P2A', '09:02:00', '09:03:00'],
    ].map(([elementId, start, end], pathIndex) => ({
      pathIndex, elementId,
      startTime: `2026-10-03T${start}+08:00`, endTime: `2026-10-03T${end}+08:00`,
    })),
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

  it.each([0, 10, 30])('detects a yard-only loop reconfigured to %s seconds', (seconds) => {
    const loop = {
      ...saved, path: ['Y', 'B1', 'Y'], platformTimings: [],
      timeline: [
        saved.timeline[0], saved.timeline[1],
        { pathIndex: 2, elementId: 'Y', startTime: saved.timeline[1].endTime, endTime: saved.timeline[1].endTime },
      ],
    };
    expect(savedTimingsAreStale(loop, elements())).toBe(false);
    expect(savedTimingsAreStale(loop, elements({ B1: seconds }))).toBe(true);
  });

  it('detects a block change after the last platform', () => {
    const returning = {
      ...saved, path: ['P1A', 'B1', 'Y'],
      platformTimings: [{ pathIndex: 0, arrivalTime: saved.startTime, departureTime: saved.startTime }],
      timeline: [
        { ...saved.timeline[0], elementId: 'P1A' }, saved.timeline[1],
        { pathIndex: 2, elementId: 'Y', startTime: saved.timeline[1].endTime, endTime: saved.timeline[1].endTime },
      ],
    };
    expect(savedTimingsAreStale(returning, elements())).toBe(false);
    expect(savedTimingsAreStale(returning, elements({ B1: 30 }))).toBe(true);
  });

  it('detects changed block durations even when their total duration stays the same', () => {
    expect(savedTimingsAreStale(saved, elements({ B3: 10, B5: 30 }))).toBe(true);
  });
});

describe('staleServices', () => {
  const loop = (id: number, block: string, minute: string): ServiceResponse => ({
    id, vehicleId: 'V1', startTime: `2026-10-03T09:${minute}:00+08:00`, path: ['Y', block, 'Y'], platformTimings: [],
    timeline: [
      { pathIndex: 0, elementId: 'Y', startTime: `2026-10-03T09:${minute}:00+08:00`, endTime: `2026-10-03T09:${minute}:00+08:00` },
      { pathIndex: 1, elementId: block, startTime: `2026-10-03T09:${minute}:00+08:00`, endTime: `2026-10-03T09:${minute}:20+08:00` },
      { pathIndex: 2, elementId: 'Y', startTime: `2026-10-03T09:${minute}:20+08:00`, endTime: `2026-10-03T09:${minute}:20+08:00` },
    ],
  });

  it('is empty while every snapshot matches the block configuration', () => {
    expect(staleServices([loop(1, 'B1', '00'), loop(2, 'B3', '10')], elements())).toEqual([]);
  });

  it('lists only the services that pass the reconfigured block, in the order they run', () => {
    const services = [loop(3, 'B1', '30'), loop(2, 'B3', '10'), loop(1, 'B1', '00')];

    expect(staleServices(services, elements({ B1: 25 })).map((service) => service.id)).toEqual([1, 3]);
  });
});
