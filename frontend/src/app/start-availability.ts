// Which positions on the editor's timeline bar the service being built cannot
// be moved to, because saving it there would be rejected. The bar position is
// the instant the path ends; moving it shifts the whole service in time.
import {
  CHARGE_SECONDS_PER_UNIT, MINIMUM_DEPARTURE_BATTERY, blockIdSet, newBatteryConflicts, timedService, vehicleBatterySegments,
} from './battery-preview';
import type { ServiceResponse, TrackElementResponse } from './models';
import { OccupancyInterval, savedWindow, trackConflicts, vehicleProblems } from './service-conflicts';

export interface TimeSpan {
  start: number;
  end: number;
}

// Why a time is ruled out: the vehicle's battery, or anything else (the
// vehicle is busy or elsewhere, or another vehicle holds a block on the way).
export type RejectionReason = 'battery' | 'schedule';

export interface UnavailableSpan extends TimeSpan {
  reason: RejectionReason;
}

export interface DraftPlacement {
  vehicleId: string;
  // The service being edited, or null for a new one.
  serviceId: number | null;
  timeline: OccupancyInterval[];
  // A new service with no path yet starts wherever its vehicle is at that
  // time, so only the vehicle being busy can rule a time out.
  followsVehicle: boolean;
}

type SavedService = Pick<ServiceResponse, 'id' | 'vehicleId' | 'startTime' | 'path' | 'timeline'>;

export function rejectedAt(
  draft: DraftPlacement,
  pathEnd: number,
  services: SavedService[],
  elements: TrackElementResponse[],
): boolean {
  return rejectionAt(draft, pathEnd, services, elements) !== null;
}

// Why the draft, moved so that its path ends at `pathEnd`, would be rejected.
export function rejectionAt(
  draft: DraftPlacement,
  pathEnd: number,
  services: SavedService[],
  elements: TrackElementResponse[],
): RejectionReason | null {
  const shift = pathEnd - draft.timeline[draft.timeline.length - 1].end;
  const timeline = draft.timeline.map((interval) => ({
    ...interval, start: interval.start + shift, end: interval.end + shift,
  }));
  const window = {
    serviceId: draft.serviceId,
    vehicleId: draft.vehicleId,
    start: timeline[0].start,
    end: pathEnd,
    startElementId: timeline[0].elementId,
    endElementId: timeline[timeline.length - 1].elementId,
  };
  const problems = vehicleProblems(window, services.map(savedWindow));
  if (problems.some((problem) => !draft.followsVehicle || problem.kind === 'overlap')) {
    return 'schedule';
  }
  if (trackConflicts(timeline, draft.vehicleId, services, elements, draft.serviceId).length > 0) {
    return 'schedule';
  }
  if (timeline.length < 2) {
    return chargingInYard(draft, pathEnd, services, elements) ? 'battery' : null;
  }
  return newBatteryConflicts(
    { serviceId: draft.serviceId, vehicleId: draft.vehicleId, timeline }, services.map(timedService), elements,
  ).some((conflict) => !conflict.allowed) ? 'battery' : null;
}

// With no path yet, a service can still not start while its vehicle waits in
// the yard below the battery it needs to leave.
function chargingInYard(
  draft: DraftPlacement,
  instant: number,
  services: SavedService[],
  elements: TrackElementResponse[],
): boolean {
  const own = services
    .filter((service) => service.vehicleId === draft.vehicleId && service.id !== draft.serviceId)
    .map(timedService);
  // One millisecond further, so a vehicle arriving at this very instant is already waiting.
  const waiting = vehicleBatterySegments(own, blockIdSet(elements), instant + 1)
    .find((segment) => segment.idle && segment.start <= instant && instant <= segment.end);
  if (waiting === undefined || waiting.elementId !== 'Y') {
    return false;
  }
  const battery = waiting.batteryStart + (instant - waiting.start) / 1000 / CHARGE_SECONDS_PER_UNIT;
  return battery < MINIMUM_DEPARTURE_BATTERY;
}

// The stretches of `range` the path end cannot be moved to. The range is
// checked at evenly spaced instants, at most one per second, so an opening or
// a conflict shorter than one step can be missed; the form still lists the
// exact reasons for the time actually chosen.
export function unavailableSpans(
  draft: DraftPlacement,
  range: TimeSpan,
  services: SavedService[],
  elements: TrackElementResponse[],
  steps = 240,
): UnavailableSpan[] {
  if (draft.timeline.length === 0 || range.end <= range.start) {
    return [];
  }
  const step = Math.max(1000, Math.ceil((range.end - range.start) / steps / 1000) * 1000);
  const spans: UnavailableSpan[] = [];
  for (let instant = range.start; instant <= range.end; instant += step) {
    const reason = rejectionAt(draft, instant, services, elements);
    if (reason === null) {
      continue;
    }
    const last = spans[spans.length - 1];
    const end = Math.min(range.end, instant + step);
    if (last !== undefined && last.end >= instant && last.reason === reason) {
      last.end = end;
    } else {
      spans.push({ start: instant, end, reason });
    }
  }
  return spans;
}
