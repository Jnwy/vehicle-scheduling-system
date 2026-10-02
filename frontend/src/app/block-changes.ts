import type { BlockChange } from './models';

// Unsaved block times by block ID.
export type PendingBlockTimes = Record<string, number>;

// Returns the message for a value that cannot be a traversal time, or the seconds.
export function parseTraversalSeconds(value: string): number | string {
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isInteger(seconds) || seconds < 0) {
    return 'Block traversal time must be a non-negative integer.';
  }
  return seconds;
}

// A value typed back to the saved one is no longer a change.
export function stageBlockTime(
  pending: PendingBlockTimes, saved: Record<string, number | null>, blockId: string, seconds: number,
): PendingBlockTimes {
  const { [blockId]: _, ...others } = pending;
  return saved[blockId] === seconds ? others : { ...others, [blockId]: seconds };
}

function naturalOrder(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

export function blockChanges(pending: PendingBlockTimes): BlockChange[] {
  return Object.keys(pending).sort(naturalOrder).map((id) => ({ id, traversalSeconds: pending[id] }));
}

export function describeBlockChanges(pending: PendingBlockTimes, saved: Record<string, number | null>): string[] {
  return blockChanges(pending).map(({ id, traversalSeconds }) => `${id}: ${saved[id] ?? '-'}s → ${traversalSeconds}s`);
}
