import { HttpErrorResponse } from '@angular/common/http';

export function formatForDisplay(value: string): string {
  return value.replace('T', ' ').replace('+08:00', '');
}

export function toDatetimeLocal(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
  if (match === null) {
    return value;
  }

  return match[1].length === 16 ? `${match[1]}:00` : match[1];
}

export function fromDatetimeLocal(value: string): string {
  // The HTTP boundary interprets naive input as Asia/Taipei.
  return value.length === 16 ? `${value}:00` : value;
}

export function formatApiError(error: HttpErrorResponse): string {
  if (error.status === 0) {
    return 'Connection error. Confirm the FastAPI backend is running at http://localhost:8000.';
  }

  const detail = error.error?.detail;
  const detailText = formatErrorDetail(detail);

  if (error.status === 409) {
    return `Schedule conflict: ${detailText}`;
  }

  if (error.status === 422) {
    return `Validation failed: ${detailText}`;
  }

  if (error.status === 404) {
    return `Not found: ${detailText}`;
  }

  return `Request failed (${error.status}): ${detailText}`;
}

export function formatErrorDetail(detail: unknown): string {
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (isRecord(item)) {
          const location = Array.isArray(item['loc']) ? item['loc'].join('.') : 'request';
          const message = typeof item['msg'] === 'string' ? item['msg'] : 'Invalid value';
          return `${location}: ${message}`;
        }

        return String(item);
      })
      .join('; ');
  }

  if (isRecord(detail)) {
    // The code identifies the rule for API clients; the message is the user-facing text.
    return typeof detail['message'] === 'string' ? detail['message'] : JSON.stringify(detail);
  }

  if (typeof detail === 'string') {
    return detail;
  }

  return 'No additional detail returned.';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function errorMessage(error: unknown): string {
  return error instanceof HttpErrorResponse ? formatApiError(error) : 'Unexpected frontend error.';
}
