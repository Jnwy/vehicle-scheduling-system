// What the path editor offers as the next click. A path must start and end at
// a platform or yard (DOMAIN_RULES 3.9), so the user picks stops and the
// blocks leading to each one are filled in. This is an editor convenience
// only: the request still carries the complete path and the backend validates it.
import type { TopologyResponse } from './models';

// Every clickable element mapped to the elements a click appends, ending with
// the clicked element itself.
export function nextPathSteps(path: string[], topology: TopologyResponse): Map<string, string[]> {
  const blockIds = new Set(
    topology.elements.filter((element) => element.elementType === 'BLOCK').map((element) => element.id),
  );
  if (path.length === 0) {
    return new Map(topology.elements
      .filter((element) => !blockIds.has(element.id))
      .map((element) => [element.id, [element.id]]));
  }
  const nextOf = (elementId: string) => topology.connections
    .filter((connection) => connection.fromElementId === elementId)
    .map((connection) => connection.toElementId);

  const last = path[path.length - 1];
  const routesByStop = new Map<string, string[][]>();
  const walk = (elementId: string, blocks: string[]) => {
    for (const next of nextOf(elementId)) {
      // Entering a block only to reverse back to the same stop is not offered.
      if (next === last) {
        continue;
      }
      if (!blockIds.has(next)) {
        routesByStop.set(next, [...(routesByStop.get(next) ?? []), [...blocks, next]]);
      } else if (!blocks.includes(next)) {
        walk(next, [...blocks, next]);
      }
    }
  };
  walk(last, []);

  const steps = new Map<string, string[]>();
  let ambiguous = false;
  for (const [stopId, routes] of routesByStop) {
    if (routes.length === 1) {
      steps.set(stopId, routes[0]);
    } else {
      ambiguous = true;
    }
  }
  // The user provides the path: when a stop can be reached more than one way
  // the blocks are not guessed, and the next elements are offered one by one.
  if (ambiguous) {
    for (const next of nextOf(last)) {
      if (!steps.has(next)) {
        steps.set(next, [next]);
      }
    }
  }
  return steps;
}

// Undo removes what one click added: the last element and the blocks that led
// to it. The first element stays even when it is a block, as in a service
// saved before paths had to start at a stop.
export function withoutLastStep(path: string[], topology: TopologyResponse): string[] {
  const blockIds = new Set(
    topology.elements.filter((element) => element.elementType === 'BLOCK').map((element) => element.id),
  );
  const remaining = path.slice(0, -1);
  while (remaining.length > 1 && blockIds.has(remaining[remaining.length - 1])) {
    remaining.pop();
  }
  return remaining;
}

// The backend's limit (DOMAIN_RULES 3.10). A path may revisit elements, so
// without one it could grow without end.
export const MAX_PATH_ELEMENTS = 200;

export function pathLengthProblems(path: string[]): string[] {
  return path.length > MAX_PATH_ELEMENTS
    ? [`The path has ${path.length} elements; a service path can have at most ${MAX_PATH_ELEMENTS}.`]
    : [];
}

// The step numbers shown above a map element. A path that loops visits the
// same element many times, and the full list would run into its neighbours.
export function visitLabel(steps: number[], shown = 3): string {
  return steps.length <= shown
    ? steps.join(',')
    : `${steps.slice(0, shown).join(',')} +${steps.length - shown}`;
}
