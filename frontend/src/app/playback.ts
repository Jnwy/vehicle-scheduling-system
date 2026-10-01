import {
  PlaybackVehicleState,
  ScheduleAnalysis,
  ScheduleConflict,
  SimulationSegment,
  TopologyResponse,
} from './models';

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
    const next = vehicle.segments[index + 1];
    return [{
      vehicleId: vehicle.vehicleId,
      serviceId: segment.serviceId,
      elementId: segment.elementId,
      nextElementId: blockIds.has(segment.elementId) && next ? next.elementId : segment.elementId,
      progress: blockIds.has(segment.elementId) ? fraction : 0,
      battery: segment.batteryStart + (segment.batteryEnd - segment.batteryStart) * fraction,
    }];
  });
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
