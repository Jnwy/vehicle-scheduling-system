import '@angular/compiler';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, EnvironmentInjector, Injector, createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServiceResponse, TopologyResponse } from './models';
import { ScheduleEditorComponent } from './schedule-editor.component';
import { SchedulingApi } from './scheduling-api.service';

const at = (seconds: number) => `2026-10-03T09:00:${String(seconds).padStart(2, '0')}+08:00`;
const loop = (id: number, vehicleId: string, block: string, start: number): ServiceResponse => ({
  id, vehicleId, startTime: at(start), path: ['Y', block, 'Y'], platformTimings: [],
  timeline: [
    { pathIndex: 0, elementId: 'Y', startTime: at(start), endTime: at(start) },
    { pathIndex: 1, elementId: block, startTime: at(start), endTime: at(start + 10) },
    { pathIndex: 2, elementId: 'Y', startTime: at(start + 10), endTime: at(start + 10) },
  ],
});
const topology: TopologyResponse = {
  elements: [
    { id: 'Y', elementType: 'YARD', traversalSeconds: null, interlockingGroup: null },
    { id: 'B1', elementType: 'BLOCK', traversalSeconds: 20, interlockingGroup: 'IG1' },
    { id: 'B2', elementType: 'BLOCK', traversalSeconds: 10, interlockingGroup: 'IG1' },
  ],
  connections: [
    { fromElementId: 'Y', toElementId: 'B1' }, { fromElementId: 'B1', toElementId: 'Y' },
    { fromElementId: 'Y', toElementId: 'B2' }, { fromElementId: 'B2', toElementId: 'Y' },
  ],
};

describe('editing a service after block reconfiguration', () => {
  let injector: EnvironmentInjector;
  let editor: ScheduleEditorComponent;
  let result: Subject<ServiceResponse>;
  let update: ReturnType<typeof vi.fn>;
  const saved = loop(1, 'V1', 'B1', 0);

  beforeEach(() => {
    vi.useFakeTimers();
    result = new Subject<ServiceResponse>();
    update = vi.fn(() => result);
    injector = createEnvironmentInjector([
      { provide: SchedulingApi, useValue: { updateService: update } },
      { provide: ChangeDetectorRef, useValue: { markForCheck: vi.fn() } },
    ], Injector.NULL as EnvironmentInjector);
    editor = runInInjectionContext(injector, () => new ScheduleEditorComponent());
    editor.topology.set(topology);
    editor.services.set([saved]);
  });

  afterEach(() => {
    injector.destroy();
    vi.useRealTimers();
  });

  it('shows the changed times and blocks saving a newly conflicting yard-only service', () => {
    editor.services.set([saved, loop(2, 'V2', 'B2', 15)]);
    editor.startEdit(saved);

    expect(editor.blockTimesChanged()).toBe(true);
    expect(editor.noticeKind()).toBe('warning');
    expect(editor.mapInstant()).toBe(Date.parse(at(20)));
    expect(editor.blockers().join(' ')).toContain('interlocking group IG1');
    expect(editor.blockers().join(' ')).toContain('V2 service #2');
    expect(editor.blockers().join(' ')).toContain('09:00:15');
    editor.submitService();
    expect(update).not.toHaveBeenCalled();
    expect(editor.services()[0]).toEqual(saved);
  });

  it('keeps the draft and saved snapshot when the backend rejects an apparently safe update', () => {
    editor.startEdit(saved);
    expect(editor.blockers()).toEqual([]);
    const draft = structuredClone(editor.serviceForm);
    editor.submitService();
    expect(update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ path: saved.path }));
    result.error(new HttpErrorResponse({ status: 409, error: { detail: {
      code: 'InterlockingConflictError', message: 'IG1 conflicts with service #2.',
    } } }));

    expect(editor.savingService()).toBe(false);
    expect(editor.noticeKind()).toBe('error');
    expect(editor.notice()).toContain('Schedule conflict: IG1');
    expect(editor.editingServiceId()).toBe(saved.id);
    expect(editor.serviceForm).toEqual(draft);
    expect(editor.services()).toEqual([saved]);
    expect(editor.blockTimesChanged()).toBe(true);
  });
});
