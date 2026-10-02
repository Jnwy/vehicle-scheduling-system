import { describe, expect, it } from 'vitest';

import type { ServiceResponse, TrackElementResponse } from './models';
import { DraftPlacement, rejectedAt, rejectionAt, unavailableSpans } from './start-availability';

const at = (seconds: number) => Date.parse('2026-10-03T08:00:00+08:00') + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const elements: TrackElementResponse[] = [
  { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
  { id: 'P1A', elementType: 'PLATFORM', traversalSeconds: null, interlockingGroup: null },
  { id: 'B1', elementType: 'BLOCK', traversalSeconds: 20, interlockingGroup: null },
];

// Y -> B1 (20 seconds) -> P1A, starting at `start`.
function saved(id: number, vehicleId: string, start: number, path = ['Y', 'B1', 'P1A']): ServiceResponse {
  const rows = [[path[0], start, start], [path[1], start, start + 20], [path[2], start + 20, start + 20]] as const;
  return {
    id, vehicleId, startTime: iso(start), path, platformTimings: [],
    timeline: rows.map(([elementId, from, to], pathIndex) => ({
      pathIndex, elementId, startTime: iso(from), endTime: iso(to),
    })),
  };
}

function draft(vehicleId: string, path = ['Y', 'B1', 'P1A'], followsVehicle = false): DraftPlacement {
  let cursor = 0;
  return {
    vehicleId, serviceId: null, followsVehicle,
    timeline: path.map((elementId, pathIndex) => {
      const start = cursor;
      cursor += elementId === 'B1' ? 20 : 0;
      return { pathIndex, elementId, start: at(start), end: at(cursor) };
    }),
  };
}

describe('rejectedAt', () => {
  const v1 = saved(1, 'V1', 100);

  it('rejects an end time that puts another vehicle on the same block, and allows touching it', () => {
    // V1 is on B1 from 100 to 120; the draft is on it for the 20 seconds before its end.
    expect(rejectedAt(draft('V2'), at(130), [v1], elements)).toBe(true);
    expect(rejectedAt(draft('V2'), at(100), [v1], elements)).toBe(false);
    expect(rejectedAt(draft('V2'), at(140), [v1], elements)).toBe(false);
  });

  it('rejects a time that breaks the same vehicle\'s continuity or battery', () => {
    // After V1 ends at P1A, another service from Y does not connect.
    expect(rejectedAt(draft('V1'), at(300), [v1], elements)).toBe(true);
    // Back in the yard at 220 with 78 units: leaving needs 24 seconds of charging.
    const home = saved(2, 'V1', 200, ['P1A', 'B1', 'Y']);
    expect(rejectedAt(draft('V1'), at(220 + 23 + 20), [v1, home], elements)).toBe(true);
    expect(rejectedAt(draft('V1'), at(220 + 24 + 20), [v1, home], elements)).toBe(false);
  });

  it('does not rule out a time for a low battery on the way to the yard', () => {
    // 50 blocks take V1 from 80 to exactly 30, standing at P1A from 1000 seconds on.
    const path = [...Array.from({ length: 50 }, () => ['P1A', 'B1']).flat(), 'P1A'];
    let cursor = 0;
    const atThreshold: ServiceResponse = {
      id: 1, vehicleId: 'V1', startTime: iso(0), path, platformTimings: [],
      timeline: path.map((elementId, pathIndex) => {
        const start = cursor;
        cursor += elementId === 'B1' ? 20 : 0;
        return { pathIndex, elementId, startTime: iso(start), endTime: iso(cursor) };
      }),
    };

    expect(rejectedAt(draft('V1', ['P1A', 'B1', 'Y']), at(5000), [atThreshold], elements)).toBe(false);
    expect(rejectedAt(draft('V1', ['P1A', 'B1', 'P1A']), at(5000), [atThreshold], elements)).toBe(true);
  });

  it('only rules out busy times while the start still follows the vehicle', () => {
    const start = draft('V1', ['Y'], true);
    expect(rejectedAt(start, at(110), [v1], elements)).toBe(true);
    expect(rejectedAt(start, at(300), [v1], elements)).toBe(false);
    expect(rejectedAt(draft('V1', ['Y']), at(300), [v1], elements)).toBe(true);
  });
});

describe('rejectionAt', () => {
  it('marks the time a vehicle is still charging in the yard as a battery reason', () => {
    const out = saved(1, 'V1', 100);
    const home = saved(2, 'V1', 200, ['P1A', 'B1', 'Y']);
    // Back at 220 with 78 units; 80 is reached 24 seconds later.
    const start = draft('V1', ['Y'], true);
    expect(rejectionAt(start, at(230), [out, home], elements)).toBe('battery');
    expect(rejectionAt(start, at(243), [out, home], elements)).toBe('battery');
    expect(rejectionAt(start, at(244), [out, home], elements)).toBeNull();
    // While it is running a service the reason is the schedule, not the battery.
    expect(rejectionAt(start, at(210), [out, home], elements)).toBe('schedule');
    // With a path built, leaving too early is a battery reason as well.
    expect(rejectionAt(draft('V1'), at(250), [out, home], elements)).toBe('battery');
  });

  it('keeps a battery stretch apart from a schedule stretch next to it', () => {
    const out = saved(1, 'V1', 100);
    const home = saved(2, 'V1', 200, ['P1A', 'B1', 'Y']);
    const spans = unavailableSpans(draft('V1', ['Y'], true), { start: at(190), end: at(260) }, [out, home], elements, 70);
    expect(spans).toEqual([
      { start: at(201), end: at(220), reason: 'schedule' },
      { start: at(220), end: at(244), reason: 'battery' },
    ]);
  });
});

describe('unavailableSpans', () => {
  it('merges neighbouring rejected instants into one stretch', () => {
    const spans = unavailableSpans(draft('V2'), { start: at(0), end: at(200) }, [saved(1, 'V1', 100)], elements, 200);
    // Ends from 101 to 139 overlap V1 on B1; each rejected second covers one step.
    expect(spans).toEqual([{ start: at(101), end: at(140), reason: 'schedule' }]);
  });

  it('is empty without a draft or a range', () => {
    expect(unavailableSpans({ ...draft('V2'), timeline: [] }, { start: at(0), end: at(200) }, [], elements)).toEqual([]);
    expect(unavailableSpans(draft('V2'), { start: at(5), end: at(5) }, [], elements)).toEqual([]);
  });
});
