import { CHARGE_SECONDS_PER_UNIT } from './battery-preview';
import {
  PlaybackVehicleState,
  ScheduleAnalysis,
  ScheduleConflict,
  SimulationSegment,
  TopologyResponse,
} from './models';

const FULL_BATTERY = 100;

export interface PlaybackRange {
  start: number;
  end: number;
}

export function scheduleRange(analysis: ScheduleAnalysis): PlaybackRange | null {
  if (analysis.startTime === null || analysis.endTime === null) {
    return null;
  }
  return { start: Date.parse(analysis.startTime), end: Date.parse(analysis.endTime) };
}

export function vehicleStatesAt(
  analysis: ScheduleAnalysis,
  topology: TopologyResponse,
  instant: number | null,
): PlaybackVehicleState[] {
  if (instant === null) {
    return [];
  }
  const blockIds = new Set(
    topology.elements
      .filter((element) => element.elementType === 'BLOCK')
      .map((element) => element.id),
  );
  return analysis.vehicles.flatMap((vehicle) => {
    const index = segmentIndexAt(vehicle.segments, instant);
    if (index < 0) {
      return [];
    }
    const segment = vehicle.segments[index];
    const start = Date.parse(segment.startTime);
    const end = Date.parse(segment.endTime);
    const fraction = end > start ? Math.max(0, Math.min(1, (instant - start) / (end - start))) : 0;
    const leg = blockIds.has(segment.elementId)
      ? blockLeg(
          segment.elementId,
          neighbourId(vehicle.segments[index - 1], segment),
          neighbourId(vehicle.segments[index + 1], segment),
          fraction,
          blockIds,
        )
      : { fromElementId: segment.elementId, toElementId: segment.elementId, progress: 0 };
    const heading = leg.fromElementId !== leg.toElementId
      ? { headingFromElementId: leg.fromElementId, headingToElementId: leg.toElementId }
      : standingHeading(vehicle.segments, index);
    // A block drains evenly over its time. Charging runs at a fixed rate and
    // stops at the segment's end value, which is where a full battery is capped.
    const charges = segment.segmentType === 'IDLE' && segment.batteryEnd > segment.batteryStart;
    const battery = charges
      ? Math.min(segment.batteryEnd, segment.batteryStart + (instant - start) / 1000 / CHARGE_SECONDS_PER_UNIT)
      : segment.batteryStart + (segment.batteryEnd - segment.batteryStart) * fraction;
    return [{
      vehicleId: vehicle.vehicleId,
      serviceId: segment.serviceId,
      elementId: segment.elementId,
      ...leg,
      ...heading,
      battery,
      charging: charges && battery < FULL_BATTERY,
    }];
  });
}

function neighbourId(neighbour: SimulationSegment | undefined, segment: SimulationSegment): string | null {
  return neighbour && neighbour.elementId !== segment.elementId ? neighbour.elementId : null;
}

// A standing vehicle keeps the direction it arrived in. Before its first move
// it faces where it will go next.
function standingHeading(
  segments: SimulationSegment[],
  index: number,
): Pick<PlaybackVehicleState, 'headingFromElementId' | 'headingToElementId'> {
  const elementId = segments[index].elementId;
  const previous = segments.slice(0, index).reverse().find((segment) => segment.elementId !== elementId);
  if (previous) {
    return { headingFromElementId: previous.elementId, headingToElementId: elementId };
  }
  const next = segments.slice(index + 1).find((segment) => segment.elementId !== elementId);
  return { headingFromElementId: elementId, headingToElementId: next?.elementId ?? elementId };
}

// A block's time is spent travelling in from the previous element, through
// the block node, and out to the next element, so the marker never jumps.
// Where two blocks meet, the hand-over point is halfway between their nodes.
function blockLeg(
  blockId: string,
  previousId: string | null,
  nextId: string | null,
  fraction: number,
  blockIds: Set<string>,
): Pick<PlaybackVehicleState, 'fromElementId' | 'toElementId' | 'progress'> {
  const entryProgress = previousId !== null && blockIds.has(previousId) ? 0.5 : 0;
  const exitProgress = nextId !== null && blockIds.has(nextId) ? 0.5 : 1;
  if (previousId === null && nextId === null) {
    return { fromElementId: blockId, toElementId: blockId, progress: 0 };
  }
  if (previousId === null) {
    return { fromElementId: blockId, toElementId: nextId!, progress: exitProgress * fraction };
  }
  if (nextId === null) {
    return { fromElementId: previousId, toElementId: blockId, progress: entryProgress + (1 - entryProgress) * fraction };
  }
  if (fraction < 0.5) {
    return { fromElementId: previousId, toElementId: blockId, progress: entryProgress + (1 - entryProgress) * fraction * 2 };
  }
  return { fromElementId: blockId, toElementId: nextId, progress: exitProgress * (fraction - 0.5) * 2 };
}

export function conflictsAt(
  analysis: ScheduleAnalysis,
  instant: number | null,
): ScheduleConflict[] {
  if (instant === null) {
    return [];
  }
  return analysis.conflicts.filter((conflict) => {
    const start = Date.parse(conflict.startTime);
    const end = Date.parse(conflict.endTime);
    return start === end ? instant === start : start <= instant && instant < end;
  });
}

export function playbackSliderPosition(
  range: PlaybackRange | null,
  instant: number | null,
): number {
  if (range === null || instant === null || range.end === range.start) {
    return 0;
  }
  return Math.round(((instant - range.start) / (range.end - range.start)) * 1000);
}

function segmentIndexAt(segments: SimulationSegment[], instant: number): number {
  const activeIndex = segments.findIndex((segment) => {
    const start = Date.parse(segment.startTime);
    const end = Date.parse(segment.endTime);
    return start < end && start <= instant && instant < end;
  });
  if (activeIndex >= 0) {
    return activeIndex;
  }
  const zeroLengthIndex = segments.findIndex((segment) => {
    const start = Date.parse(segment.startTime);
    return start === Date.parse(segment.endTime) && instant === start;
  });
  if (zeroLengthIndex >= 0) {
    return zeroLengthIndex;
  }
  if (segments.length > 0 && instant === Date.parse(segments[segments.length - 1].endTime)) {
    return segments.length - 1;
  }
  return -1;
}
