import { describe, expect, it } from 'vitest';

import {
  TimedService, batteryConflicts, newBatteryConflicts, scheduleUntil, secondsToDepartureCharge, timedService,
  vehicleBatterySegments, withCandidate,
} from './battery-preview';
import type { TrackElementResponse } from './models';
import { vehicleStatesAt } from './playback';

const at = (seconds: number) => Date.parse('2026-10-03T08:00:00+08:00') + seconds * 1000;

const elements: TrackElementResponse[] = [
  { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
  { id: 'P1A', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
  { id: 'P1B', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
  { id: 'B1', elementType: 'BLOCK', traversalSeconds: 10, interlockingGroup: null },
  { id: 'B2', elementType: 'BLOCK', traversalSeconds: 10, interlockingGroup: null },
];
const blockIds = new Set(['B1', 'B2']);

// Every block takes ten seconds; the yard and platforms take no time.
function service(serviceId: number | null, path: string[], start = 0, vehicleId = 'V1'): TimedService {
  let cursor = at(start);
  return {
    serviceId,
    vehicleId,
    timeline: path.map((elementId) => {
      const interval = { elementId, start: cursor, end: cursor + (blockIds.has(elementId) ? 10000 : 0) };
      cursor = interval.end;
      return interval;
    }),
  };
}

const laps = (count: number) => [...Array.from({ length: count }, () => ['P1A', 'B1']).flat(), 'P1A'];
const kinds = (candidate: TimedService, saved: TimedService[]) =>
  newBatteryConflicts(candidate, saved, elements).map((conflict) => conflict.kind);

describe('vehicleBatterySegments', () => {
  it('starts at 80, uses one unit per block, and charges one unit per 12 seconds in the yard', () => {
    const segments = vehicleBatterySegments(
      [service(1, ['Y', 'B1', 'Y']), service(2, ['Y', 'B1', 'P1A'], 16)], blockIds, at(100),
    );
    expect(segments.map((segment) => [segment.elementId, segment.idle, segment.batteryStart, segment.batteryEnd])).toEqual([
      ['Y', false, 80, 80], ['B1', false, 80, 79], ['Y', false, 79, 79],
      ['Y', true, 79, 79.5],
      ['Y', false, 79.5, 79.5], ['B1', false, 79.5, 78.5], ['P1A', false, 78.5, 78.5],
      // Waiting outside the yard neither charges nor drains.
      ['P1A', true, 78.5, 78.5],
    ]);
  });

  it('caps charging at 100, never drops below zero, and orders services by start time', () => {
    const charged = vehicleBatterySegments([service(1, ['P1A', 'B1', 'Y'])], blockIds, at(10000));
    expect(charged[charged.length - 1].batteryEnd).toBe(100);
    const drained = vehicleBatterySegments([service(1, laps(90))], blockIds);
    expect(drained[drained.length - 1].batteryEnd).toBe(0);
    const ordered = vehicleBatterySegments([service(2, ['P1A', 'B1', 'Y'], 50), service(1, ['Y', 'B1', 'P1A'])], blockIds);
    expect(ordered[0].service?.serviceId).toBe(1);
  });
});

describe('newBatteryConflicts', () => {
  it('rejects leaving the yard below 80 and names the departure', () => {
    const saved = [service(1, ['Y', 'B1', 'Y'])];
    const candidate = service(null, ['Y', 'B1', 'P1A'], 21);

    expect(newBatteryConflicts(candidate, saved, elements)).toEqual([expect.objectContaining({
      kind: 'INSUFFICIENT_CHARGE', vehicleId: 'V1', start: at(21), service: candidate, pathIndex: 1, elementId: 'B1',
    })]);
    // 12 seconds in the yard charge the unit back.
    expect(kinds(service(null, ['Y', 'B1', 'P1A'], 22), saved)).toEqual([]);
  });

  it('rejects passing through the yard below 80, where there is no time to charge', () => {
    expect(kinds(service(null, ['P1A', 'B1', 'Y', 'B2', 'P1B']), [])).toEqual(['INSUFFICIENT_CHARGE']);
  });

  it('allows exactly 30 and rejects the block that goes below it', () => {
    expect(kinds(service(null, laps(50)), [])).toEqual([]);

    const [conflict] = newBatteryConflicts(service(null, laps(51)), [], elements);
    // The battery passes 30 at the start of the 51st block.
    expect(conflict).toMatchObject({ kind: 'LOW_BATTERY', pathIndex: 101, elementId: 'B1', start: at(500) });
  });

  it('allows a low battery on the way to the yard, and only there', () => {
    const atThreshold = service(1, laps(50));

    expect(newBatteryConflicts(service(null, ['P1A', 'B1', 'Y'], 1000), [atThreshold], elements))
      .toEqual([expect.objectContaining({ kind: 'LOW_BATTERY', allowed: true, pathIndex: 1, elementId: 'B1' })]);
    expect(newBatteryConflicts(service(null, ['P1A', 'B1', 'P1A'], 1000), [atThreshold], elements))
      .toEqual([expect.objectContaining({ kind: 'LOW_BATTERY', allowed: false })]);
    // Leaving the yard again without charging is still rejected.
    const later = service(2, ['Y', 'B1', 'P1A'], 1000);
    expect(newBatteryConflicts(service(null, ['P1A', 'B1', 'Y'], 990), [later], elements))
      .toEqual([expect.objectContaining({ kind: 'INSUFFICIENT_CHARGE', allowed: false })]);
  });

  it('rejects running out of battery, even on the way to the yard', () => {
    const homeAfter = (blocks: number) =>
      service(null, [...Array.from({ length: blocks - 1 }, () => ['P1A', 'B1']).flat(), 'P1A', 'B1', 'Y']);

    // 80 blocks arrive with nothing left; the low battery on the way is allowed.
    expect(newBatteryConflicts(homeAfter(80), [], elements).map((conflict) => [conflict.kind, conflict.allowed]))
      .toEqual([['LOW_BATTERY', true]]);
    // The 81st block cannot be crossed.
    expect(newBatteryConflicts(homeAfter(81), [], elements)).toEqual([
      expect.objectContaining({ kind: 'LOW_BATTERY', allowed: true }),
      expect.objectContaining({ kind: 'EMPTY_BATTERY', allowed: false, pathIndex: 161, elementId: 'B1', battery: 0 }),
    ]);
  });

  it('finds a later saved service that the candidate drains', () => {
    const later = service(7, laps(50), 1000);
    const [conflict] = newBatteryConflicts(service(null, ['P1A', 'B1', 'P1A']), [later], elements);

    expect(conflict.kind).toBe('LOW_BATTERY');
    expect(conflict.service).toBe(later);
  });

  it('ignores other vehicles and conflicts that were already saved', () => {
    const savedLow = service(1, laps(51));

    expect(kinds(service(null, ['Y', 'B1', 'P1A'], 0, 'V2'), [savedLow])).toEqual([]);
    // The low battery began in the saved service, so the way home is allowed.
    expect(kinds(service(null, ['P1A', 'B1', 'Y'], 1000), [savedLow])).toEqual([]);
  });

  it('replaces the original on an update and also checks the vehicle it leaves', () => {
    const original = service(4, laps(50));

    expect(kinds(service(4, laps(50), 5), [original])).toEqual([]);
    expect(kinds(service(4, laps(51)), [original])).toEqual(['LOW_BATTERY']);
    expect(withCandidate([original], service(4, laps(2)))).toHaveLength(1);
    expect(withCandidate([original], service(null, laps(2)))).toHaveLength(2);
  });
});

describe('batteryConflicts', () => {
  it('reports one low battery conflict for consecutive low segments', () => {
    const segments = vehicleBatterySegments([service(1, laps(53))], blockIds, at(5000));

    expect(batteryConflicts('V1', segments).map((conflict) => conflict.kind)).toEqual(['LOW_BATTERY']);
  });
});

describe('secondsToDepartureCharge', () => {
  it('rounds up to whole seconds and is zero from 80', () => {
    expect(secondsToDepartureCharge(79)).toBe(12);
    expect(secondsToDepartureCharge(79.5)).toBe(6);
    expect(secondsToDepartureCharge(79.95)).toBe(1);
    expect(secondsToDepartureCharge(80)).toBe(0);
    expect(secondsToDepartureCharge(93)).toBe(0);
  });
});

describe('scheduleUntil', () => {
  const topology = { elements, connections: [] };

  it('keeps a vehicle at the end of its last service, with its battery, until the instant', () => {
    const analysis = scheduleUntil(
      [service(1, ['Y', 'B1', 'P1A']), service(2, ['P1B', 'B2', 'Y'], 0, 'V2')], elements, at(34),
    );
    const states = vehicleStatesAt(analysis, topology, at(34));

    expect(states.map((state) => [state.vehicleId, state.elementId, state.battery, state.charging])).toEqual([
      // Waiting at a platform does not charge; waiting in the yard does.
      ['V1', 'P1A', 79, false],
      ['V2', 'Y', 81, true],
    ]);
    // Once full, the vehicle is no longer charging.
    const full = scheduleUntil([service(2, ['P1B', 'B2', 'Y'], 0, 'V2')], elements, at(1000));
    expect(vehicleStatesAt(full, topology, at(900))[0]).toMatchObject({ battery: 100, charging: false });
  });

  it('shows a vehicle part of the way through a block and leaves out one that has not started', () => {
    const analysis = scheduleUntil(
      [service(1, ['Y', 'B1', 'P1A']), service(2, ['P1B', 'B2', 'Y'], 60, 'V2')], elements, at(5),
    );
    const states = vehicleStatesAt(analysis, topology, at(5));

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ vehicleId: 'V1', elementId: 'B1', battery: 79.5 });
  });

  it('reads saved services from the API shape', () => {
    expect(timedService({
      id: 3, vehicleId: 'V1',
      timeline: [{ pathIndex: 0, elementId: 'Y', startTime: '2026-10-03T08:00:00+08:00', endTime: '2026-10-03T08:00:05+08:00' }],
    })).toEqual({ serviceId: 3, vehicleId: 'V1', timeline: [{ elementId: 'Y', start: at(0), end: at(5) }] });
  });
});
