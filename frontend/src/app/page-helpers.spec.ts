// page-helpers imports Angular's HTTP package, which needs the JIT compiler
// when loaded outside an Angular build.
import '@angular/compiler';

import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import {
  errorMessage, formatApiError, formatErrorDetail, formatForDisplay, fromDatetimeLocal, toDatetimeLocal,
} from './page-helpers';

describe('datetime formatting', () => {
  it('shows an API timestamp as Taipei wall-clock time', () => {
    expect(formatForDisplay('2026-10-03T09:00:20+08:00')).toBe('2026-10-03 09:00:20');
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
