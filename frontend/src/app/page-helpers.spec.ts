// page-helpers imports Angular's HTTP package, which needs the JIT compiler
// when loaded outside an Angular build.
import '@angular/compiler';

import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { ScheduleConflict } from './models';
import {
  describeConflicts, errorMessage, formatApiError, formatClockTime, formatDuration, formatErrorDetail, formatForDisplay,
  formatServiceDate, formatTimelineTime, fromDatetimeLocal, toDatetimeLocal,
} from './page-helpers';

describe('datetime formatting', () => {
  it('only adds a date when a timeline time changes calendar day', () => {
    const reference = '2026-12-31T23:59:40+08:00';
    expect(formatTimelineTime('2026-12-31T23:59:50+08:00', reference)).toBe('23:59:50');
    expect(formatTimelineTime('2027-01-01T00:00:00+08:00', reference)).toBe('2027-01-01 00:00:00');
  });
  it('shows an API timestamp as Taipei wall-clock time', () => {
    expect(formatForDisplay('2026-10-03T09:00:20+08:00')).toBe('2026-10-03 09:00:20');
  });

  it('splits a timestamp into service date and clock time', () => {
    expect(formatServiceDate('2026-10-03T09:00:20+08:00')).toBe('2026-10-03');
    expect(formatClockTime('2026-10-03T09:00:20+08:00')).toBe('09:00:20');
  });

  it('shows service duration in minutes and seconds', () => {
    expect(formatDuration('2026-10-03T09:00:20+08:00', '2026-10-03T09:02:05+08:00')).toBe('1m 45s');
    expect(formatDuration('2026-10-03T09:00:20+08:00', '2026-10-03T09:00:35+08:00')).toBe('15s');
  });

  it('converts an API timestamp to a datetime-local value with seconds', () => {
    expect(toDatetimeLocal('2026-10-03T09:00:20+08:00')).toBe('2026-10-03T09:00:20');
    expect(toDatetimeLocal('2026-10-03T09:00')).toBe('2026-10-03T09:00:00');
  });

  it('leaves an unrecognized value unchanged', () => {
    expect(toDatetimeLocal('not a time')).toBe('not a time');
  });

  it('adds seconds to a datetime-local value that omits them', () => {
    expect(fromDatetimeLocal('2026-10-03T09:00')).toBe('2026-10-03T09:00:00');
    expect(fromDatetimeLocal('2026-10-03T09:00:20')).toBe('2026-10-03T09:00:20');
  });
});

describe('formatErrorDetail', () => {
  it('shows a domain error message without its code', () => {
    const detail = {
      code: 'VehicleOverlapError',
      message: 'The new service overlaps service 2 assigned to the same vehicle.',
      candidate_service_id: null,
    };

    expect(formatErrorDetail(detail)).toBe('The new service overlaps service 2 assigned to the same vehicle.');
  });

  it('joins request shape errors with their field locations', () => {
    const detail = [
      { loc: ['body', 'vehicleId'], msg: 'Field required' },
      { loc: ['body', 'path'], msg: 'Input should be a valid list' },
    ];

    expect(formatErrorDetail(detail)).toBe('body.vehicleId: Field required; body.path: Input should be a valid list');
  });

  it('handles a request shape error without location or message', () => {
    expect(formatErrorDetail([{}])).toBe('request: Invalid value');
  });

  it('passes a plain string through', () => {
    expect(formatErrorDetail('Not Found')).toBe('Not Found');
  });

  it('serializes an object that has no message', () => {
    expect(formatErrorDetail({ code: 'X' })).toBe('{"code":"X"}');
  });

  it('has a fallback when no detail is returned', () => {
    expect(formatErrorDetail(undefined)).toBe('No additional detail returned.');
  });
});

describe('formatApiError', () => {
  const response = (status: number, message = 'Reason.') =>
    new HttpErrorResponse({ status, error: { detail: { code: 'SomeError', message } } });

  it.each([
    [409, 'Schedule conflict: Reason.'],
    [422, 'Validation failed: Reason.'],
    [404, 'Not found: Reason.'],
    [500, 'Request failed (500): Reason.'],
  ])('labels status %i', (status, expected) => {
    expect(formatApiError(response(status))).toBe(expected);
  });

  it('reports a connection failure when no response arrived', () => {
    expect(formatApiError(new HttpErrorResponse({ status: 0 }))).toBe(
      'Connection error. Confirm the backend container is running.',
    );
  });
});

describe('errorMessage', () => {
  it('formats an HTTP error', () => {
    const error = new HttpErrorResponse({ status: 404, error: { detail: 'Not Found' } });

    expect(errorMessage(error)).toBe('Not found: Not Found');
  });

  it('has a generic message for anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('Unexpected frontend error.');
  });
});

describe('describeConflicts', () => {
  const conflict = (conflictType: ScheduleConflict['conflictType'], message: string): ScheduleConflict => ({
    conflictType,
    resourceId: null,
    startTime: '2026-10-03T09:00:00+08:00',
    endTime: '2026-10-03T09:00:20+08:00',
    vehicleIds: ['V1'],
    serviceIds: [1],
    elementIds: [],
    message,
  });

  it('names both battery conflict types as a battery problem', () => {
    expect(describeConflicts([conflict('INSUFFICIENT_CHARGE', 'Vehicle V1 left the yard below 80 battery units.')]))
      .toBe('Battery problem: Vehicle V1 left the yard below 80 battery units.');
    expect(describeConflicts([conflict('LOW_BATTERY', 'Vehicle V1 is below 30 battery units outside the yard.')]))
      .toBe('Battery problem: Vehicle V1 is below 30 battery units outside the yard.');
  });

  it('names a block occupancy conflict', () => {
    expect(describeConflicts([conflict('BLOCK_OCCUPANCY', 'B5 is shared.')])).toBe('Block occupancy: B5 is shared.');
  });

  it('describes the first two conflicts and counts the rest', () => {
    const conflicts = [
      conflict('LOW_BATTERY', 'First.'),
      conflict('BLOCK_OCCUPANCY', 'Second.'),
      conflict('LOW_BATTERY', 'Third.'),
      conflict('LOW_BATTERY', 'Fourth.'),
    ];

    expect(describeConflicts(conflicts))
      .toBe('Battery problem: First. Block occupancy: Second. 2 more in Schedule Viewer.');
  });
});
