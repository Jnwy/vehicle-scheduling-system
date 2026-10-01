import type { PlatformTiming, TrackElementResponse } from './models';

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function nextStartTime(now = Date.now()): string {
  const next = (Math.floor(now / 300000) + 1) * 300000;
  return new Date(next + TAIPEI_OFFSET_MS).toISOString().slice(0, 19);
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
