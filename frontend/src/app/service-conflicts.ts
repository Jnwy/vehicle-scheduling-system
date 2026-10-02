// Live previews of the write validation the backend applies (DOMAIN_RULES 8,
// 9, 10, 11). They use the same saved timeline snapshots and [start, end)
// semantics, but the backend stays the authority: these only explain a
// rejection before the user submits.
import type { ServiceResponse, TopologyResponse, TrackElementResponse } from './models';
import { nextPathSteps } from './path-steps';
import { derivePlatformTimings } from './service-timing';

export interface OccupancyInterval {
  pathIndex: number;
  elementId: string;
  start: number;
  end: number;
}

// The timeline the form would save, or null while its inputs cannot produce one.
export function candidateTimeline(
  startTime: string,
  path: string[],
  elements: TrackElementResponse[],
  dwellByIndex: Map<number, number | null>,
): OccupancyInterval[] | null {
  if (derivePlatformTimings(startTime, path, elements, dwellByIndex).error) {
    return null;
  }
  const byId = new Map(elements.map((element) => [element.id, element]));
  let cursor = Date.parse(`${startTime}+08:00`);
  return path.map((elementId, pathIndex) => {
    const element = byId.get(elementId)!;
    // Yard duration is zero; a block takes its traversal time; a platform its dwell.
    const seconds = element.elementType === 'BLOCK'
      ? element.traversalSeconds!
      : element.elementType === 'PLATFORM' ? dwellByIndex.get(pathIndex)! : 0;
    const start = cursor;
    cursor += seconds * 1000;
    return { pathIndex, elementId, start, end: cursor };
  });
}

// An empty interval overlaps nothing; touching endpoints do not overlap.
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart !== aEnd && bStart !== bEnd && aStart < bEnd && bStart < aEnd;
}

export interface InterlockingConflict {
  pathIndex: number;
  elementId: string;
  group: string;
  // The other vehicle's occupancy of the group that the candidate runs into.
  serviceId: number;
  vehicleId: string;
  start: number;
  end: number;
}

type SavedService = Pick<ServiceResponse, 'id' | 'vehicleId' | 'timeline'>;

function interlockingConflict(
  interval: OccupancyInterval,
  vehicleId: string,
  services: SavedService[],
  groupByBlock: Map<string, string>,
  excludeServiceId: number | null,
): InterlockingConflict | null {
  const group = groupByBlock.get(interval.elementId);
  if (group === undefined) {
    return null;
  }
  for (const service of services) {
    // A vehicle never blocks itself; that is the vehicle overlap rule.
    if (service.vehicleId === vehicleId || service.id === excludeServiceId) {
      continue;
    }
    for (const occupied of service.timeline) {
      const start = Date.parse(occupied.startTime);
      const end = Date.parse(occupied.endTime);
      if (groupByBlock.get(occupied.elementId) === group && overlaps(interval.start, interval.end, start, end)) {
        return {
          pathIndex: interval.pathIndex, elementId: interval.elementId, group,
          serviceId: service.id, vehicleId: service.vehicleId, start, end,
        };
      }
    }
  }
  return null;
}

function interlockingGroups(elements: TrackElementResponse[]): Map<string, string> {
  return new Map(elements.flatMap((element) =>
    element.elementType === 'BLOCK' && element.interlockingGroup
      ? [[element.id, element.interlockingGroup] as [string, string]]
      : []));
}

// Path elements that would enter an interlocking group while another vehicle holds it.
export function interlockingConflicts(
  timeline: OccupancyInterval[],
  vehicleId: string,
  services: SavedService[],
  elements: TrackElementResponse[],
  excludeServiceId: number | null,
): InterlockingConflict[] {
  const groupByBlock = interlockingGroups(elements);
  return timeline.flatMap((interval) =>
    interlockingConflict(interval, vehicleId, services, groupByBlock, excludeServiceId) ?? []);
}

// The next clicks (see path-steps.ts) that would be rejected for interlocking
// if the path continued from the time it currently ends. A stop is blocked by
// the first held block on the way to it; the conflict names that block.
export function blockedNextElements(
  path: string[],
  pathEnd: number,
  vehicleId: string,
  services: SavedService[],
  topology: TopologyResponse,
  excludeServiceId: number | null,
): Map<string, InterlockingConflict> {
  const groupByBlock = interlockingGroups(topology.elements);
  const byId = new Map(topology.elements.map((element) => [element.id, element]));
  const blocked = new Map<string, InterlockingConflict>();
  for (const [elementId, steps] of nextPathSteps(path, topology)) {
    let cursor = pathEnd;
    for (const [offset, stepId] of steps.entries()) {
      const element = byId.get(stepId);
      // Only blocks on the way take time; an unconfigured one ends the preview.
      if (element?.elementType !== 'BLOCK' || element.traversalSeconds === null) {
        break;
      }
      const interval = {
        pathIndex: path.length + offset, elementId: stepId, start: cursor, end: cursor + element.traversalSeconds * 1000,
      };
      const conflict = interlockingConflict(interval, vehicleId, services, groupByBlock, excludeServiceId);
      if (conflict !== null) {
        blocked.set(elementId, conflict);
        break;
      }
      cursor = interval.end;
    }
  }
  return blocked;
}

// One service as the vehicle rules see it: a time window and its two end locations.
export interface ScheduleWindow {
  // null for a service that has not been saved yet.
  serviceId: number | null;
  vehicleId: string;
  start: number;
  end: number;
  startElementId: string;
  endElementId: string;
}

export type VehicleProblem =
  | { kind: 'overlap'; service: ScheduleWindow; other: ScheduleWindow }
  | { kind: 'continuity'; from: ScheduleWindow; to: ScheduleWindow };

export function savedWindow(
  service: Pick<ServiceResponse, 'id' | 'vehicleId' | 'startTime' | 'path' | 'timeline'>,
): ScheduleWindow {
  const first = service.timeline[0];
  const last = service.timeline[service.timeline.length - 1];
  return {
    serviceId: service.id,
    vehicleId: service.vehicleId,
    start: Date.parse(first?.startTime ?? service.startTime),
    end: Date.parse(last?.endTime ?? service.startTime),
    startElementId: service.path[0],
    endElementId: service.path[service.path.length - 1],
  };
}

function instantInside(point: ScheduleWindow, span: ScheduleWindow): boolean {
  return point.start === point.end && span.start < point.start && point.start < span.end;
}

// Overlap first, then the nearest predecessor and successor must connect.
// Ties keep the first service in list order, as the backend does.
function vehicleProblem(service: ScheduleWindow, schedule: ScheduleWindow[]): VehicleProblem | null {
  const others = schedule.filter((other) =>
    other.vehicleId === service.vehicleId
    && other !== service
    && !(service.serviceId !== null && other.serviceId === service.serviceId));
  for (const other of others) {
    if (overlaps(service.start, service.end, other.start, other.end)
      || instantInside(service, other) || instantInside(other, service)) {
      return { kind: 'overlap', service, other };
    }
  }
  let predecessor: ScheduleWindow | null = null;
  let successor: ScheduleWindow | null = null;
  for (const other of others) {
    if (other.end <= service.start && (predecessor === null || other.end > predecessor.end)) {
      predecessor = other;
    }
    if (other.start >= service.end && (successor === null || other.start < successor.start)) {
      successor = other;
    }
  }
  if (predecessor !== null && predecessor.endElementId !== service.startElementId) {
    return { kind: 'continuity', from: predecessor, to: service };
  }
  if (successor !== null && service.endElementId !== successor.startElementId) {
    return { kind: 'continuity', from: service, to: successor };
  }
  return null;
}

// Why saving the candidate would be rejected by the same-vehicle rules. An
// update replaces its original in place and also revalidates every service of
// the old and new vehicle, so moving a service that bridged two others is caught.
export function vehicleProblems(candidate: ScheduleWindow, saved: ScheduleWindow[]): VehicleProblem[] {
  const original = saved.find((window) => candidate.serviceId !== null && window.serviceId === candidate.serviceId);
  const schedule = saved.map((window) => (window === original ? candidate : window));
  const affectedVehicles = new Set([candidate.vehicleId, original?.vehicleId]);
  const toCheck = original === undefined
    ? [candidate]
    : [candidate, ...schedule.filter((window) => window !== candidate && affectedVehicles.has(window.vehicleId))];
  const problems: VehicleProblem[] = [];
  const seen = new Set<string>();
  for (const service of toCheck) {
    const problem = vehicleProblem(service, schedule);
    if (problem === null) {
      continue;
    }
    // The same pair is found once from each side.
    const pair = problem.kind === 'overlap'
      ? [problem.service.serviceId, problem.other.serviceId].sort().join('~')
      : `${problem.from.serviceId}>${problem.to.serviceId}`;
    if (!seen.has(`${problem.kind}:${pair}`)) {
      seen.add(`${problem.kind}:${pair}`);
      problems.push(problem);
    }
  }
  return problems;
}

// Deleting a service makes its neighbours adjacent; they must still connect.
export function deletionProblem(target: ScheduleWindow, saved: ScheduleWindow[]): VehicleProblem | null {
  let predecessor: ScheduleWindow | null = null;
  let successor: ScheduleWindow | null = null;
  for (const other of saved) {
    if (other.vehicleId !== target.vehicleId || other.serviceId === target.serviceId) {
      continue;
    }
    if (other.end <= target.start && (predecessor === null || other.end > predecessor.end)) {
      predecessor = other;
    }
    if (other.start >= target.end && (successor === null || other.start < successor.start)) {
      successor = other;
    }
  }
  return predecessor !== null && successor !== null && predecessor.endElementId !== successor.startElementId
    ? { kind: 'continuity', from: predecessor, to: successor }
    : null;
}

// A vehicle only stands at a yard or platform, so a path must start and end
// at one; blocks are only passed through. Unknown elements are left to the
// timing preview, which already reports them.
export function pathEndpointProblems(path: string[], elements: TrackElementResponse[]): string[] {
  const blockIds = new Set(
    elements.filter((element) => element.elementType === 'BLOCK').map((element) => element.id),
  );
  const problems: string[] = [];
  if (path.length > 0 && blockIds.has(path[0])) {
    problems.push(`The path must start at a yard or platform; ${path[0]} is a block.`);
  }
  if (path.length > 1 && blockIds.has(path[path.length - 1])) {
    problems.push(`The path must end at a yard or platform; ${path[path.length - 1]} is a block.`);
  }
  return problems;
}
