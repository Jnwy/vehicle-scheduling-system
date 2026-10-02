import type { PlatformTiming, ServiceResponse, TrackElementResponse } from './models';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function nextStartTime(now = Date.now()): string {
  const next = (Math.floor(now / 300000) + 1) * 300000;
  return new Date(next + TAIPEI_OFFSET_MS).toISOString().slice(0, 19);
}

// Location continuity: a vehicle's next service must begin where its latest
// service ended, and no earlier than that end.
export function vehicleContinuation(
  services: Pick<ServiceResponse, 'vehicleId' | 'startTime' | 'path' | 'timeline'>[],
  vehicleId: string,
): { startTime: string; elementId: string } | null {
  let latest: { end: number; elementId: string } | null = null;
  for (const service of services) {
    if (service.vehicleId !== vehicleId || service.path.length === 0) {
      continue;
    }
    const end = Math.max(
      Date.parse(service.startTime),
      ...service.timeline.map((interval) => Date.parse(interval.endTime)),
    );
    if (Number.isFinite(end) && (latest === null || end > latest.end)) {
      latest = { end, elementId: service.path[service.path.length - 1] };
    }
  }
  if (latest === null) {
    return null;
  }
  return { startTime: taipeiLocal(latest.end), elementId: latest.elementId };
}

export interface StartTimeParts {
  year: number | null;
  month: number | null;
  day: number | null;
  hour: number | null;
  minute: number | null;
  second: number | null;
}

export function splitStartTime(value: string): StartTimeParts {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match === null) {
    return { year: null, month: null, day: null, hour: null, minute: null, second: null };
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return { year, month, day, hour, minute, second };
}

// Returns '' unless the parts form a real calendar date and time, so that
// 30 February or hour 24 is reported instead of silently rolling over.
export function composeStartTime(parts: StartTimeParts): string {
  const { year, month, day, hour, minute, second } = parts;
  if (year === null || month === null || day === null || hour === null || minute === null || second === null) {
    return '';
  }
  if (![year, month, day, hour, minute, second].every(Number.isInteger) || year < 1000 || year > 9999) {
    return '';
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const roundTrips = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return roundTrips ? date.toISOString().slice(0, 19) : '';
}

export interface VehicleBusyWindow {
  serviceId: number;
  start: number;
  end: number;
  startElementId: string;
  endElementId: string;
}

// The time windows in which a vehicle is already running a service, in order.
export function vehicleBusyWindows(
  services: Pick<ServiceResponse, 'id' | 'vehicleId' | 'startTime' | 'path' | 'timeline'>[],
  vehicleId: string,
  excludeServiceId: number | null = null,
): VehicleBusyWindow[] {
  return services
    .filter((service) => service.vehicleId === vehicleId && service.id !== excludeServiceId && service.path.length > 0)
    .map((service) => {
      const start = Date.parse(service.startTime);
      return {
        serviceId: service.id,
        start,
        end: Math.max(start, ...service.timeline.map((interval) => Date.parse(interval.endTime))),
        startElementId: service.path[0],
        endElementId: service.path[service.path.length - 1],
      };
    })
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface VehicleSlot {
  kind: 'busy' | 'free';
  // null means unbounded: before the first service or after the last one.
  start: number | null;
  end: number | null;
  serviceId: number | null;
  // Busy: where the service starts. Free: where the vehicle waits, or null
  // before its first service, when the model gives it no position.
  elementId: string | null;
  // Busy: where the service ends. Free: where the following service starts.
  nextElementId: string | null;
}

export function vehicleSlots(windows: VehicleBusyWindow[]): VehicleSlot[] {
  const slots: VehicleSlot[] = [];
  let previous: VehicleBusyWindow | null = null;
  for (const window of windows) {
    if (previous === null || window.start > previous.end) {
      slots.push({
        kind: 'free',
        start: previous?.end ?? null,
        end: window.start,
        serviceId: null,
        elementId: previous?.endElementId ?? null,
        nextElementId: window.startElementId,
      });
    }
    slots.push({
      kind: 'busy',
      start: window.start,
      end: window.end,
      serviceId: window.serviceId,
      elementId: window.startElementId,
      nextElementId: window.endElementId,
    });
    if (previous === null || window.end >= previous.end) {
      previous = window;
    }
  }
  slots.push({
    kind: 'free',
    start: previous?.end ?? null,
    end: null,
    serviceId: null,
    elementId: previous?.endElementId ?? null,
    nextElementId: null,
  });
  return slots;
}

// Where the vehicle is at an instant. Busy windows are [start, end), so a
// service may start exactly when the previous one ends.
export function vehiclePositionAt(
  windows: VehicleBusyWindow[],
  instant: number,
): { busy: VehicleBusyWindow | null; elementId: string | null } {
  const busy = windows.find((window) => window.start <= instant && instant < window.end) ?? null;
  if (busy !== null) {
    return { busy, elementId: null };
  }
  let latest: VehicleBusyWindow | null = null;
  for (const window of windows) {
    if (window.end <= instant && (latest === null || window.end >= latest.end)) {
      latest = window;
    }
  }
  return { busy: null, elementId: latest?.endElementId ?? null };
}

// Wall-clock Taipei time for the start fields, rounded up to a whole second
// so a start taken from a previous end never overlaps it.
export function taipeiLocal(instant: number): string {
  return new Date(Math.ceil(instant / 1000) * 1000 + TAIPEI_OFFSET_MS).toISOString().slice(0, 19);
}

function taipeiTimestamp(instant: number): string {
  return new Date(instant + TAIPEI_OFFSET_MS).toISOString().replace('.000Z', '+08:00').replace('Z', '+08:00');
}

export function derivePlatformTimings(
  startTime: string,
  path: string[],
  elements: TrackElementResponse[],
  dwellByIndex: Map<number, number | null>,
): { timings: PlatformTiming[]; error: string; missingBlockIds: string[] } {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const missingBlockIds = [...new Set(path.filter((id) => {
    const element = byId.get(id);
    return element?.elementType === 'BLOCK' && element.traversalSeconds === null;
  }))];
  if (missingBlockIds.length > 0) {
    return { timings: [], error: `Configure traversal time for ${missingBlockIds.join(', ')} before saving.`, missingBlockIds };
  }

  // datetime-local is wall-clock time in Taipei, independent of browser timezone.
  let cursor = Date.parse(`${startTime}+08:00`);
  if (!Number.isFinite(cursor)) {
    return { timings: [], error: 'Enter a valid start time.', missingBlockIds };
  }

  const timings: PlatformTiming[] = [];
  for (const [pathIndex, id] of path.entries()) {
    const element = byId.get(id);
    if (!element) {
      return { timings: [], error: `Unknown track element: ${id}.`, missingBlockIds };
    }
    if (element.elementType === 'BLOCK') {
      const seconds = element.traversalSeconds;
      if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
        return { timings: [], error: `Invalid traversal time for ${id}.`, missingBlockIds };
      }
      cursor += seconds * 1000;
    } else if (element.elementType === 'PLATFORM') {
      const dwell = dwellByIndex.get(pathIndex);
      if (dwell === null || dwell === undefined || !Number.isFinite(dwell) || dwell < 0) {
        return { timings: [], error: `Enter a non-negative dwell time for ${id} at path index ${pathIndex}.`, missingBlockIds };
      }
      const departure = cursor + dwell * 1000;
      if (!Number.isFinite(departure) || Math.abs(departure + TAIPEI_OFFSET_MS) > 8640000000000000) {
        return { timings: [], error: 'The calculated time is outside the supported date range.', missingBlockIds };
      }
      timings.push({ pathIndex, arrivalTime: taipeiTimestamp(cursor), departureTime: taipeiTimestamp(departure) });
      cursor = departure;
    }
  }
  return { timings, error: '', missingBlockIds };
}

// A saved timeline is a snapshot; it goes stale when a block on its path is
// reconfigured. The backend recalculates on update and rejects stale arrivals.
export function savedTimingsAreStale(
  service: Pick<ServiceResponse, 'startTime' | 'path' | 'platformTimings'>,
  elements: TrackElementResponse[],
): boolean {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const timingByIndex = new Map(service.platformTimings.map((timing) => [timing.pathIndex, timing]));
  let cursor = Date.parse(service.startTime);
  for (const [pathIndex, id] of service.path.entries()) {
    const element = byId.get(id);
    if (!element) {
      return false;
    }
    if (element.elementType === 'BLOCK') {
      if (element.traversalSeconds === null) {
        return false;
      }
      cursor += element.traversalSeconds * 1000;
    } else if (element.elementType === 'PLATFORM') {
      const timing = timingByIndex.get(pathIndex);
      if (!timing || Date.parse(timing.arrivalTime) !== cursor) {
        return true;
      }
      cursor = Date.parse(timing.departureTime);
    }
  }
  return false;
}
