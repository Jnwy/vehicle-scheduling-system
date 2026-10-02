import { describe, expect, it } from 'vitest';

import type { ScheduleAnalysis, ScheduleConflict, ServiceResponse } from './models';
import { buildVehicleOverviews, serviceEndTime } from './schedule-overview';

const at = (seconds: number) => `2026-10-03T09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}+08:00`;

function service(id: number, vehicleId: string, start: number, end: number, path = ['Y', 'B1', 'P1A']): ServiceResponse {
  return {
    id, vehicleId, startTime: at(start), path, platformTimings: [],
    timeline: [
      { pathIndex: 0, elementId: path[0], startTime: at(start), endTime: at(start) },
      { pathIndex: 1, elementId: path[path.length - 1], startTime: at(start), endTime: at(end) },
    ],
  };
}

function analysis(overrides: Partial<ScheduleAnalysis> = {}): ScheduleAnalysis {
  return {
    startTime: at(0),
    endTime: at(100),
    vehicles: [{ vehicleId: 'V1', segments: [] }, { vehicleId: 'V2', segments: [] }],
    conflicts: [],
    ...overrides,
  };
}

const conflict = (vehicleIds: string[], start: number, end: number): ScheduleConflict => ({
  conflictType: 'BLOCK_OCCUPANCY', resourceId: 'B5', startTime: at(start), endTime: at(end),
  vehicleIds, serviceIds: [], elementIds: ['B5'], message: 'Block B5 is occupied by multiple vehicles.',
});

describe('serviceEndTime', () => {
  it('is the end of the last timeline interval', () => {
    expect(serviceEndTime(service(1, 'V1', 10, 40))).toBe(at(40));
  });

  it('falls back to the start time without a timeline', () => {
    expect(serviceEndTime({ ...service(1, 'V1', 10, 40), timeline: [] })).toBe(at(10));
  });
});

describe('buildVehicleOverviews', () => {
  it('groups services by vehicle in vehicle ID order', () => {
    const overviews = buildVehicleOverviews(
      [service(1, 'V2', 0, 20), service(2, 'V1', 0, 20)],
      analysis(),
    );

    expect(overviews.map((overview) => overview.vehicleId)).toEqual(['V1', 'V2']);
    expect(overviews[0].services.map((item) => item.id)).toEqual([2]);
    expect(overviews[1].services.map((item) => item.id)).toEqual([1]);
  });

  it('orders a vehicle\'s services by start time, not by ID', () => {
    const [v1] = buildVehicleOverviews(
      [service(1, 'V1', 60, 80), service(2, 'V1', 0, 20)],
      analysis(),
    );

    expect(v1.services.map((item) => item.id)).toEqual([2, 1]);
    expect(v1.serviceBars.map((bar) => bar.label)).toEqual(['#2', '#1']);
  });

  it('breaks equal start times by ID', () => {
    const [v1] = buildVehicleOverviews(
      [service(5, 'V1', 0, 0), service(3, 'V1', 0, 0)],
      analysis(),
    );

    expect(v1.services.map((item) => item.id)).toEqual([3, 5]);
  });

  it('includes a known vehicle that has no services', () => {
    const overviews = buildVehicleOverviews([service(1, 'V1', 0, 20)], analysis());

    expect(overviews[1]).toMatchObject({ vehicleId: 'V2', services: [], serviceBars: [], conflictBars: [] });
  });

  it('includes a vehicle that appears only in the service list', () => {
    const overviews = buildVehicleOverviews([service(1, 'V9', 0, 20)], analysis({ vehicles: [] }));

    expect(overviews.map((overview) => overview.vehicleId)).toEqual(['V9']);
  });

  it('places service bars as percentages of the schedule range', () => {
    const [v1] = buildVehicleOverviews([service(1, 'V1', 25, 75)], analysis());

    expect(v1.serviceBars).toEqual([
      { label: '#1', title: 'Service #1: Y -> P1A', leftPercent: 25, widthPercent: 50 },
    ]);
  });

  it('clamps a bar to the schedule range', () => {
    const [v1] = buildVehicleOverviews([service(1, 'V1', 50, 150)], analysis());

    expect(v1.serviceBars[0]).toMatchObject({ leftPercent: 50, widthPercent: 50 });
  });

  it('shows a conflict only on the vehicles it involves', () => {
    const overviews = buildVehicleOverviews(
      [service(1, 'V1', 0, 100), service(2, 'V2', 0, 100)],
      analysis({ conflicts: [conflict(['V1', 'V2'], 20, 30), conflict(['V1'], 60, 80)] }),
    );

    expect(overviews[0].conflictBars.map((bar) => [bar.leftPercent, bar.widthPercent])).toEqual([[20, 10], [60, 20]]);
    expect(overviews[1].conflictBars.map((bar) => [bar.leftPercent, bar.widthPercent])).toEqual([[20, 10]]);
    expect(overviews[0].conflictBars[0].title).toBe('Block B5 is occupied by multiple vehicles.');
  });

  it('produces no bars when the schedule has no range', () => {
    const [v1] = buildVehicleOverviews(
      [service(1, 'V1', 0, 0)],
      analysis({ startTime: null, endTime: null }),
    );

    expect(v1.services).toHaveLength(1);
    expect(v1.serviceBars).toEqual([]);
  });

  it('produces no bars when the schedule range is empty', () => {
    const [v1] = buildVehicleOverviews(
      [service(1, 'V1', 0, 0)],
      analysis({ startTime: at(0), endTime: at(0) }),
    );

    expect(v1.serviceBars).toEqual([]);
  });

  it('does not reorder the caller\'s service list', () => {
    const services = [service(1, 'V1', 60, 80), service(2, 'V1', 0, 20)];

    buildVehicleOverviews(services, analysis());

    expect(services.map((item) => item.id)).toEqual([1, 2]);
  });
});
