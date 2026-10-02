// Live preview of the battery rules the backend applies on write (DOMAIN_RULES
// 8.1), and of where every vehicle is while a path is being built. The numbers
// follow backend/app/domain/schedule_analysis.py; the backend stays the
// authority, this only shows a rejection before the user submits.
import type { ScheduleAnalysis, ServiceResponse, SimulationSegment, TrackElementResponse } from './models';
import type { OccupancyInterval } from './service-conflicts';

export const INITIAL_BATTERY = 80;
const MAX_BATTERY = 100;
const BLOCK_BATTERY_COST = 1;
export const CHARGE_SECONDS_PER_UNIT = 12;
export const LOW_BATTERY_THRESHOLD = 30;
export const MINIMUM_DEPARTURE_BATTERY = 80;
const YARD_ID = 'Y';

// One service with its timeline in epoch milliseconds.
export interface TimedService {
  // null for the service in the form when it has not been saved yet.
  serviceId: number | null;
  vehicleId: string;
  timeline: Pick<OccupancyInterval, 'elementId' | 'start' | 'end'>[];
}

export interface BatterySegment {
  // True while the vehicle waits between services or after its last one.
  idle: boolean;
  service: TimedService | null;
  pathIndex: number | null;
  elementId: string;
  start: number;
  end: number;
  batteryStart: number;
  batteryEnd: number;
}

export function timedService(service: Pick<ServiceResponse, 'id' | 'vehicleId' | 'timeline'>): TimedService {
  return {
    serviceId: service.id,
    vehicleId: service.vehicleId,
    timeline: service.timeline.map((interval) => ({
      elementId: interval.elementId, start: Date.parse(interval.startTime), end: Date.parse(interval.endTime),
    })),
  };
}

// The saved schedule as it would be after saving the candidate: an update
// replaces its original in place, a new service is added last.
export function withCandidate(saved: TimedService[], candidate: TimedService): TimedService[] {
  const replaces = (service: TimedService) => candidate.serviceId !== null && service.serviceId === candidate.serviceId;
  return saved.some(replaces)
    ? saved.map((service) => (replaces(service) ? candidate : service))
    : [...saved, candidate];
}

// The battery of one vehicle across its services, in time order. Each block
// costs one unit, idle time in the yard charges, and idle time elsewhere does
// neither. `until` extends the wait after the last service to that instant.
export function vehicleBatterySegments(
  services: TimedService[],
  blockIds: Set<string>,
  until: number | null = null,
): BatterySegment[] {
  const ordered = services
    .filter((service) => service.timeline.length > 0)
    .map((service, index) => ({ service, index }))
    .sort((a, b) => a.service.timeline[0].start - b.service.timeline[0].start || a.index - b.index)
    .map(({ service }) => service);
  const segments: BatterySegment[] = [];
  let battery = INITIAL_BATTERY;
  let previous: { elementId: string; end: number } | null = null;
  const idleUntil = (end: number) => {
    const batteryEnd = previous!.elementId === YARD_ID
      ? Math.min(MAX_BATTERY, battery + (end - previous!.end) / 1000 / CHARGE_SECONDS_PER_UNIT)
      : battery;
    segments.push({
      idle: true, service: null, pathIndex: null, elementId: previous!.elementId,
      start: previous!.end, end, batteryStart: battery, batteryEnd,
    });
    battery = batteryEnd;
  };
  for (const service of ordered) {
    if (previous !== null && previous.end < service.timeline[0].start) {
      idleUntil(service.timeline[0].start);
    }
    service.timeline.forEach((interval, pathIndex) => {
      const batteryEnd = blockIds.has(interval.elementId) ? Math.max(0, battery - BLOCK_BATTERY_COST) : battery;
      segments.push({
        idle: false, service, pathIndex, elementId: interval.elementId,
        start: interval.start, end: interval.end, batteryStart: battery, batteryEnd,
      });
      battery = batteryEnd;
    });
    const last = service.timeline[service.timeline.length - 1];
    previous = { elementId: last.elementId, end: last.end };
  }
  if (previous !== null && until !== null && previous.end < until) {
    idleUntil(until);
  }
  return segments;
}

export type BatteryConflictKind = 'INSUFFICIENT_CHARGE' | 'LOW_BATTERY';

export interface BatteryConflict {
  kind: BatteryConflictKind;
  vehicleId: string;
  // When the vehicle leaves the yard, or when its battery drops below the threshold.
  start: number;
  // The service and path element where the conflict begins; `service` is null
  // when it begins while the vehicle waits.
  service: TimedService | null;
  pathIndex: number | null;
  elementId: string;
  // Battery when leaving the yard; the threshold itself for a low battery.
  battery: number;
  // True for a low battery that begins before the candidate reaches the yard
  // at its end. The vehicle is on its way to charge, so the write is not
  // rejected for it; it is only pointed out.
  allowed: boolean;
}

function lowBatteryStart(segment: BatterySegment): number | null {
  if (segment.elementId === YARD_ID || Math.min(segment.batteryStart, segment.batteryEnd) >= LOW_BATTERY_THRESHOLD) {
    return null;
  }
  if (segment.batteryStart >= LOW_BATTERY_THRESHOLD && segment.start !== segment.end) {
    const fraction = (segment.batteryStart - LOW_BATTERY_THRESHOLD) / (segment.batteryStart - segment.batteryEnd);
    return segment.start + (segment.end - segment.start) * fraction;
  }
  return segment.start;
}

// Leaving the yard below 80, and every stretch below 30 outside the yard.
// Exactly 30 is not yet low. Consecutive low segments are one conflict.
export function batteryConflicts(vehicleId: string, segments: BatterySegment[]): BatteryConflict[] {
  const conflicts: BatteryConflict[] = [];
  let lowUntil: number | null = null;
  segments.forEach((segment, index) => {
    if (
      !segment.idle && segment.elementId !== YARD_ID && index > 0
      && segments[index - 1].elementId === YARD_ID && segment.batteryStart < MINIMUM_DEPARTURE_BATTERY
    ) {
      conflicts.push({
        kind: 'INSUFFICIENT_CHARGE', vehicleId, start: segment.start, service: segment.service,
        pathIndex: segment.pathIndex, elementId: segment.elementId, battery: segment.batteryStart, allowed: false,
      });
    }
    const lowStart = lowBatteryStart(segment);
    if (lowStart === null) {
      return;
    }
    if (lowUntil === null || lowStart > lowUntil) {
      conflicts.push({
        kind: 'LOW_BATTERY', vehicleId, start: lowStart, service: segment.service,
        pathIndex: segment.pathIndex, elementId: segment.elementId, battery: LOW_BATTERY_THRESHOLD, allowed: false,
      });
    }
    lowUntil = Math.max(lowUntil ?? segment.end, segment.end);
  });
  return conflicts;
}

// The battery conflicts saving the candidate would add to the vehicles it
// touches: its own, and on an update the vehicle it is moved away from. A
// conflict that begins at the same instant as one already saved is not new,
// so a vehicle saved with a battery conflict can still be sent to the yard.
// A candidate that ends in the yard is never rejected for running low on its
// way there; those conflicts come back with `allowed` set.
export function newBatteryConflicts(
  candidate: TimedService,
  saved: TimedService[],
  elements: TrackElementResponse[],
): BatteryConflict[] {
  const blockIds = blockIdSet(elements);
  const original = saved.find((service) => candidate.serviceId !== null && service.serviceId === candidate.serviceId);
  const final = withCandidate(saved, candidate);
  const vehicleIds = new Set([candidate.vehicleId, ...(original ? [original.vehicleId] : [])]);
  const last = candidate.timeline[candidate.timeline.length - 1];
  const homeAt = last !== undefined && last.elementId === YARD_ID ? last.end : null;
  return [...vehicleIds].flatMap((vehicleId) => {
    const conflictsOf = (services: TimedService[]) => batteryConflicts(
      vehicleId, vehicleBatterySegments(services.filter((service) => service.vehicleId === vehicleId), blockIds),
    );
    const known = new Set(conflictsOf(saved).map((conflict) => `${conflict.kind}@${conflict.start}`));
    return conflictsOf(final)
      .filter((conflict) => !known.has(`${conflict.kind}@${conflict.start}`))
      .map((conflict) => ({
        ...conflict,
        allowed: conflict.kind === 'LOW_BATTERY' && vehicleId === candidate.vehicleId
          && homeAt !== null && conflict.start <= homeAt,
      }));
  });
}

// Seconds a vehicle must wait in the yard before it may leave again.
export function secondsToDepartureCharge(battery: number): number {
  return Math.ceil(Math.max(0, MINIMUM_DEPARTURE_BATTERY - battery) * CHARGE_SECONDS_PER_UNIT);
}

export function blockIdSet(elements: TrackElementResponse[]): Set<string> {
  return new Set(elements.filter((element) => element.elementType === 'BLOCK').map((element) => element.id));
}

// Every vehicle's segments up to `instant`, in the shape the playback helpers
// read, so the editor map can place vehicles with `vehicleStatesAt`. A vehicle
// stays where its last service ended.
export function scheduleUntil(
  services: TimedService[],
  elements: TrackElementResponse[],
  instant: number,
): ScheduleAnalysis {
  const blockIds = blockIdSet(elements);
  const iso = (time: number) => new Date(time).toISOString();
  const vehicleIds = [...new Set(services.map((service) => service.vehicleId))];
  return {
    startTime: null,
    endTime: null,
    conflicts: [],
    vehicles: vehicleIds.map((vehicleId) => ({
      vehicleId,
      segments: vehicleBatterySegments(
        services.filter((service) => service.vehicleId === vehicleId), blockIds, instant,
      ).map((segment): SimulationSegment => ({
        segmentType: segment.idle ? 'IDLE' : 'SERVICE',
        serviceId: segment.service?.serviceId ?? null,
        pathIndex: segment.pathIndex,
        elementId: segment.elementId,
        startTime: iso(segment.start),
        endTime: iso(segment.end),
        batteryStart: segment.batteryStart,
        batteryEnd: segment.batteryEnd,
      })),
    })),
  };
}
