
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import { ServiceRequest, ServiceResponse, TopologyResponse, VehicleResponse } from './models';
import { errorMessage, formatForDisplay, fromDatetimeLocal, toDatetimeLocal } from './page-helpers';
import { nextPathSteps, withoutLastStep } from './path-steps';
import { TrackMapComponent } from './track-map.component';
import {
  ScheduleWindow, VehicleProblem, blockedNextElements, candidateTimeline, deletionProblem, earliestOpenStart,
  interlockingConflicts,
  pathEndpointProblems, savedWindow, vehicleProblems,
} from './service-conflicts';
import {
  BusyTimeOptions, StartTimeParts, VehicleBusyWindow, VehicleSlot, busyTimeOptions, composeStartTime, daysInMonth, derivePlatformTimings, nextStartTime,
  savedTimingsAreStale, splitStartTime, taipeiLocal, nextFreeInstant, vehicleBusyWindows, vehicleContinuation, vehiclePositionAt,
  vehicleSlots,
} from './service-timing';

interface TimingFormRow {
  pathIndex: number;
  platformId: string;
  dwellSeconds: number | null;
  arrivalTime: string;
  departureTime: string;
}

interface ServiceForm {
  vehicleId: string;
  startTime: string;
  pathText: string;
  platformTimings: TimingFormRow[];
}

@Component({
  selector: 'app-schedule-editor',
  imports: [FormsModule, RouterLink, TrackMapComponent],
  templateUrl: './schedule-editor.component.html',
  styleUrl: './scheduling-page.css',
})
export class ScheduleEditorComponent implements OnInit {
  private readonly api = inject(SchedulingApi);
  private readonly destroyRef = inject(DestroyRef);
  private originalService: ServiceResponse | null = null;
  private timingInputsChanged = false;
  readonly loadingInitial = signal(false);
  readonly notice = signal('');
  readonly noticeKind = signal<'success' | 'error' | 'warning'>('success');
  readonly vehicles = signal<VehicleResponse[]>([]);
  readonly topology = signal<TopologyResponse>({ elements: [], connections: [] });
  readonly services = signal<ServiceResponse[]>([]);
  readonly expandedServiceIds = signal<Set<number>>(new Set<number>());
  readonly savingService = signal(false);
  readonly timingError = signal('');
  readonly missingBlockIds = signal<string[]>([]);
  readonly editingServiceId = signal<number | null>(null);
  readonly pathSelection = signal<string[]>(['Y']);
  // Live previews of what the backend would reject; see service-conflicts.ts.
  readonly blockers = signal<string[]>([]);
  readonly conflictElementIds = signal<string[]>([]);
  readonly blockedNext = signal<Record<string, string>>({});
  readonly blockedNextList = computed(() => Object.entries(this.blockedNext()));
  readonly deleteBlockers = computed(() => {
    const windows = this.services().map(savedWindow);
    const reasons = new Map<number, string>();
    for (const window of windows) {
      const problem = deletionProblem(window, windows);
      if (problem !== null && problem.kind === 'continuity') {
        reasons.set(window.serviceId!, `${window.vehicleId} would have to jump from ${problem.from.endElementId} `
          + `(end of service #${problem.from.serviceId}) to ${problem.to.startElementId} `
          + `(start of service #${problem.to.serviceId}).`);
      }
    }
    return reasons;
  });
  readonly isBusy = computed(() => this.loadingInitial() || this.savingService());
  readonly formatForDisplay = formatForDisplay;

  serviceForm: ServiceForm = this.createEmptyForm();
  startParts: StartTimeParts = splitStartTime(this.serviceForm.startTime);
  // Rendered as one ISO-like timestamp: 2026 - 10 - 02  12 : 26 : 40.
  readonly startFields: { key: keyof StartTimeParts; label: string; separator: string }[] = [
    { key: 'year', label: 'Year', separator: '' },
    { key: 'month', label: 'Month', separator: '-' },
    { key: 'day', label: 'Day', separator: '-' },
    { key: 'hour', label: 'Hour', separator: '·' },
    { key: 'minute', label: 'Minute', separator: ':' },
    { key: 'second', label: 'Second', separator: ':' },
  ];
  private readonly currentYear = new Date().getFullYear();
  private readonly startValues = {
    year: Array.from({ length: 7 }, (_, index) => this.currentYear - 1 + index),
    month: Array.from({ length: 12 }, (_, index) => index + 1),
    day: Array.from({ length: 31 }, (_, index) => index + 1),
    hour: Array.from({ length: 24 }, (_, index) => index),
    minute: Array.from({ length: 60 }, (_, index) => index),
    second: Array.from({ length: 60 }, (_, index) => index),
  };

  startFieldValues(key: keyof StartTimeParts): number[] {
    const { year, month } = this.startParts;
    if (key === 'day') {
      return this.startValues.day.slice(0, daysInMonth(year, month));
    }
    // A saved service may lie outside the offered years; keep its year selectable.
    if (key === 'year' && year !== null && !this.startValues.year.includes(year)) {
      return [...this.startValues.year, year].sort((a, b) => a - b);
    }
    return this.startValues[key];
  }

  isBusyOption(key: keyof StartTimeParts, value: number): boolean {
    return (key === 'hour' || key === 'minute' || key === 'second') && this.busyTimeOptions[key][value];
  }
  private busyTimeOptionsKey = '';
  private busyTimeOptionsValue: BusyTimeOptions = busyTimeOptions([], '', null, null);

  get startDate(): string {
    const { year, month, day } = this.startParts;
    if (year === null || month === null || day === null) {
      return '';
    }
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  // Read once per option on every change detection, so it is recomputed only when its inputs change.
  get busyTimeOptions(): BusyTimeOptions {
    const { hour, minute } = this.startParts;
    const windows = this.busyWindows;
    const key = [this.startDate, hour, minute, ...windows.map((window) => `${window.start}-${window.end}`)].join('|');
    if (key !== this.busyTimeOptionsKey) {
      this.busyTimeOptionsKey = key;
      this.busyTimeOptionsValue = busyTimeOptions(windows, this.startDate, hour, minute);
    }
    return this.busyTimeOptionsValue;
  }

  // The service being edited is left out: it is the one being rescheduled.
  private get busyWindows(): VehicleBusyWindow[] {
    return vehicleBusyWindows(this.services(), this.serviceForm.vehicleId, this.editingServiceId());
  }

  get vehicleSlots(): VehicleSlot[] {
    return vehicleSlots(this.busyWindows);
  }

  get busyAtStart(): VehicleBusyWindow | null {
    const instant = Date.parse(`${this.serviceForm.startTime}+08:00`);
    return Number.isFinite(instant) ? vehiclePositionAt(this.busyWindows, instant).busy : null;
  }

  slotTime(instant: number): string {
    return formatForDisplay(taipeiLocal(instant));
  }

  ngOnInit(): void {
    this.refreshAll();
  }

  refreshAll(): void {
    this.loadingInitial.set(true);
    this.clearNotice();
    forkJoin({
      vehicles: this.api.getVehicles(),
      topology: this.api.getTopology(),
      services: this.api.getServices(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ vehicles, topology, services }) => {
        this.vehicles.set(vehicles);
        this.applyTopology(topology);
        this.services.set(services);
        if (!this.serviceForm.vehicleId && vehicles.length > 0) {
          this.serviceForm.vehicleId = vehicles[0].id;
          this.startFromVehicleEnd();
        }
        this.refreshConflicts();
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  private fillPlatformRowsFromPath(): void {
    const platformIds = new Set(
      this.topology()
        .elements.filter((element) => element.elementType === 'PLATFORM')
        .map((element) => element.id),
    );
    const existingByPlatform = new Map<string, TimingFormRow[]>();
    for (const row of this.serviceForm.platformTimings) {
      const visits = existingByPlatform.get(row.platformId) ?? [];
      visits.push(row);
      existingByPlatform.set(row.platformId, visits);
    }
    const rows = this.parsePathText()
      .map((elementId, pathIndex) => ({ elementId, pathIndex }))
      .filter(({ elementId }) => platformIds.has(elementId))
      .map(({ elementId, pathIndex }) => {
        const previous = existingByPlatform.get(elementId)?.shift();
        return {
          pathIndex,
          platformId: elementId,
          dwellSeconds: previous ? previous.dwellSeconds : 60,
          arrivalTime: '',
          departureTime: '',
        };
      });

    this.serviceForm.platformTimings = rows;
    this.recalculateTimings();
  }

  onVehicleChange(vehicleId: string): void {
    this.serviceForm.vehicleId = vehicleId;
    // An edited service keeps its own start; only a new service follows the vehicle.
    if (this.editingServiceId() === null) {
      this.startFromVehicleEnd();
    } else {
      this.refreshConflicts();
    }
  }

  // A new service continues from where and when the vehicle's latest service
  // ended, moved later if another vehicle holds every way out at that time.
  private startFromVehicleEnd(): void {
    const vehicleId = this.serviceForm.vehicleId;
    const continuation = vehicleContinuation(this.services(), vehicleId);
    const elementId = continuation?.elementId ?? 'Y';
    const earliest = Date.parse(`${continuation?.startTime ?? nextStartTime()}+08:00`);
    const open = earliestOpenStart(elementId, earliest, vehicleId, this.services(), this.topology());
    const startTime = taipeiLocal(open.start);
    this.startMove = open.avoided === null ? null : {
      startTime,
      message: `Start moved from ${this.slotTime(earliest)} to ${this.slotTime(open.start)}: `
        + `${open.avoided.vehicleId} service #${open.avoided.serviceId} holds interlocking group `
        + `${open.avoided.group} on every way out of ${elementId} before then.`,
    };
    this.setStartTime(startTime);
    this.setPathSelection([elementId]);
  }

  private startMove: { startTime: string; message: string } | null = null;

  // Shown only while the form still holds the start time that was moved.
  get startMovedNote(): string {
    return this.startMove !== null && this.editingServiceId() === null
      && this.startMove.startTime === this.serviceForm.startTime
      ? this.startMove.message
      : '';
  }

  private setStartTime(value: string): void {
    this.serviceForm.startTime = value;
    this.startParts = splitStartTime(value);
  }

  onStartPartChange(key: keyof StartTimeParts, value: number | null): void {
    this.startParts[key] = value;
    // Moving from the 31st to a shorter month lands on that month's last day.
    const { year, month, day } = this.startParts;
    if (day !== null) {
      this.startParts.day = Math.min(day, daysInMonth(year, month));
    }
    this.serviceForm.startTime = composeStartTime(this.startParts);
    // A combination that lands inside one of the vehicle's services moves on to when it is free again.
    const chosen = Date.parse(`${this.serviceForm.startTime}+08:00`);
    if (Number.isFinite(chosen)) {
      const free = nextFreeInstant(this.busyWindows, chosen);
      if (free !== chosen) {
        this.setStartTime(taipeiLocal(free));
        this.showWarning(`${this.serviceForm.vehicleId} is busy at ${this.slotTime(chosen)}, so the start time moved to ${this.slotTime(free)}, when it is free again.`);
      }
    }
    // Follow the vehicle only while no path has been built, so typing a time never discards one.
    if (this.editingServiceId() === null && this.pathSelection().length <= 1) {
      const instant = Date.parse(`${this.serviceForm.startTime}+08:00`);
      const position = Number.isFinite(instant) ? vehiclePositionAt(this.busyWindows, instant) : null;
      if (position !== null && position.busy === null) {
        this.setPathSelection([position.elementId ?? 'Y']);
        return;
      }
    }
    this.recalculateTimings();
  }

  useFreeSlot(slot: VehicleSlot): void {
    if (slot.start === null) {
      return;
    }
    this.setStartTime(taipeiLocal(slot.start));
    if (this.editingServiceId() === null) {
      this.setPathSelection([slot.elementId ?? 'Y']);
    } else {
      this.recalculateTimings();
    }
  }

  setDwellSeconds(row: TimingFormRow, value: number | null): void {
    row.dwellSeconds = value;
    this.recalculateTimings();
  }

  // A click on the next stop also adds the blocks leading to it; see path-steps.ts.
  selectPathElement(elementId: string): void {
    const steps = nextPathSteps(this.pathSelection(), this.topology()).get(elementId) ?? [elementId];
    this.setPathSelection([...this.pathSelection(), ...steps]);
  }

  undoPathElement(): void {
    this.setPathSelection(withoutLastStep(this.pathSelection(), this.topology()));
  }

  resetPathToY(): void {
    this.setPathSelection(['Y']);
  }

  choosePathStart(): void {
    this.setPathSelection([]);
  }

  submitService(): void {
    if (this.isBusy() || this.blockers().length > 0) {
      return;
    }
    const request = this.buildServiceRequest();
    if (request === null) {
      return;
    }

    this.savingService.set(true);
    const editingId = this.editingServiceId();
    const operation =
      editingId === null
        ? this.api.createService(request)
        : this.api.updateService(editingId, request);

    operation.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.loadAfterServiceWrite(editingId === null ? 'Service created.' : 'Service updated.');
      },
      error: (error: unknown) => {
        this.savingService.set(false);
        this.showError(error);
      },
    });
  }

  startEdit(service: ServiceResponse): void {
    this.originalService = service;
    this.timingInputsChanged = false;
    this.editingServiceId.set(service.id);
    this.serviceForm = {
      vehicleId: service.vehicleId,
      startTime: toDatetimeLocal(service.startTime),
      pathText: service.path.join(', '),
      platformTimings: service.platformTimings.map((timing) => ({
        pathIndex: timing.pathIndex,
        platformId: service.path[timing.pathIndex],
        dwellSeconds: (Date.parse(timing.departureTime) - Date.parse(timing.arrivalTime)) / 1000,
        arrivalTime: timing.arrivalTime,
        departureTime: timing.departureTime,
      })),
    };
    this.startParts = splitStartTime(this.serviceForm.startTime);
    this.pathSelection.set([...service.path]);
    if (savedTimingsAreStale(service, this.topology().elements)) {
      this.recalculateTimings();
      this.showWarning(`Editing service #${service.id}. Block traversal times changed since it was saved, so platform times were recalculated. Saving applies the new times.`);
      return;
    }
    this.recalculateTimings(true);
    this.showSuccess(`Editing service #${service.id}.`);
  }

  cancelEdit(): void {
    this.editingServiceId.set(null);
    this.resetForm();
  }

  resetForm(): void {
    this.originalService = null;
    this.editingServiceId.set(null);
    const vehicleId = this.vehicles()[0]?.id ?? '';
    this.serviceForm = this.createEmptyForm(vehicleId);
    this.startFromVehicleEnd();
  }

  confirmDelete(service: ServiceResponse): void {
    const confirmed = window.confirm(`Delete service #${service.id}?`);
    if (!confirmed) {
      return;
    }

    this.savingService.set(true);
    this.api.deleteService(service.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.expandedServiceIds.update((ids) => {
          const next = new Set(ids);
          next.delete(service.id);
          return next;
        });
        this.loadAfterServiceWrite(`Service #${service.id} deleted.`);
      },
      error: (error: unknown) => {
        this.savingService.set(false);
        this.showError(error);
      },
    });
  }

  toggleTimeline(serviceId: number): void {
    this.expandedServiceIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }
      return next;
    });
  }

  private createEmptyForm(vehicleId = ''): ServiceForm {
    return {
      vehicleId,
      startTime: nextStartTime(),
      pathText: 'Y',
      platformTimings: [],
    };
  }

  private buildServiceRequest(): ServiceRequest | null {
    const path = this.parsePathText();

    if (!this.serviceForm.vehicleId) {
      this.showErrorMessage('Select a vehicle before saving.');
      return null;
    }

    if (!this.serviceForm.startTime) {
      this.showErrorMessage('Start time is required.');
      return null;
    }

    if (path.length < 2) {
      this.showErrorMessage('Path must contain at least two elements.');
      return null;
    }

    if (this.timingError()) {
      this.showErrorMessage(this.timingError());
      return null;
    }

    return {
      vehicleId: this.serviceForm.vehicleId,
      startTime: this.originalService && !this.timingInputsChanged
        ? this.originalService.startTime
        : fromDatetimeLocal(this.serviceForm.startTime),
      path,
      platformTimings: this.serviceForm.platformTimings.map(({ pathIndex, arrivalTime, departureTime }) => ({
        pathIndex, arrivalTime, departureTime,
      })),
    };
  }

  private parsePathText(): string[] {
    return this.serviceForm.pathText
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  private loadAfterServiceWrite(successMessage: string): void {
    forkJoin({
      services: this.api.getServices(),
      topology: this.api.getTopology(),
      analysis: this.api.getAnalysis(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ services, topology, analysis }) => {
        this.services.set(services);
        this.applyTopology(topology);
        this.savingService.set(false);
        this.editingServiceId.set(null);
        this.resetForm();
        if (analysis.conflicts.length > 0) {
          this.showWarning(`${successMessage} ${analysis.conflicts.length} bonus conflict${analysis.conflicts.length === 1 ? '' : 's'} detected.`);
        } else {
          this.showSuccess(successMessage);
        }
      },
      error: (error: unknown) => {
        this.savingService.set(false);
        this.showError(error);
      },
    });
  }

  private setPathSelection(path: string[]): void {
    this.pathSelection.set(path);
    this.serviceForm.pathText = path.join(', ');
    this.fillPlatformRowsFromPath();
  }

  private applyTopology(topology: TopologyResponse): void {
    const previousById = new Map(this.topology().elements.map((element) => [element.id, element]));
    const changed = topology.elements.some((element) =>
      element.elementType === 'BLOCK' && this.pathSelection().includes(element.id)
      && previousById.get(element.id)?.traversalSeconds !== element.traversalSeconds,
    );
    this.topology.set(topology);
    if (this.editingServiceId() === null) {
      this.fillPlatformRowsFromPath();
    } else if (changed) {
      this.recalculateTimings();
    }
  }

  private recalculateTimings(preserveSaved = false): void {
    const result = derivePlatformTimings(
      this.serviceForm.startTime,
      this.parsePathText(),
      this.topology().elements,
      new Map(this.serviceForm.platformTimings.map((row) => [row.pathIndex, row.dwellSeconds])),
    );
    this.timingError.set(result.error);
    this.missingBlockIds.set(result.missingBlockIds);
    this.refreshConflicts();
    // Opening a persisted schedule must not replace its saved timeline snapshot.
    if (preserveSaved) {
      return;
    }
    this.timingInputsChanged = true;
    const byIndex = new Map(result.timings.map((timing) => [timing.pathIndex, timing]));
    for (const row of this.serviceForm.platformTimings) {
      row.arrivalTime = byIndex.get(row.pathIndex)?.arrivalTime ?? '';
      row.departureTime = byIndex.get(row.pathIndex)?.departureTime ?? '';
    }
  }

  // Recomputed on every change to the vehicle, start time, path, dwell, or saved services.
  private refreshConflicts(): void {
    const path = this.parsePathText();
    const vehicleId = this.serviceForm.vehicleId;
    const editingId = this.editingServiceId();
    const elements = this.topology().elements;
    const timeline = candidateTimeline(
      this.serviceForm.startTime,
      path,
      elements,
      new Map(this.serviceForm.platformTimings.map((row) => [row.pathIndex, row.dwellSeconds])),
    );
    const blockers: string[] = pathEndpointProblems(path, elements);
    const conflictIds = new Set<string>();
    const blocked: Record<string, string> = {};
    if (timeline !== null && vehicleId) {
      const range = (start: number, end: number) => `${this.slotTime(start)} to ${this.slotTime(end)}`;
      if (timeline.length >= 2) {
        const candidate: ScheduleWindow = {
          serviceId: editingId,
          vehicleId,
          start: timeline[0].start,
          end: timeline[timeline.length - 1].end,
          startElementId: path[0],
          endElementId: path[path.length - 1],
        };
        const label = (window: ScheduleWindow) => window === candidate ? 'this service' : `service #${window.serviceId}`;
        const describe = (problem: VehicleProblem) => problem.kind === 'overlap'
          ? `On ${problem.service.vehicleId}, ${label(problem.service)} overlaps ${label(problem.other)} `
            + `(${range(problem.other.start, problem.other.end)}).`
          : `${problem.from.vehicleId} cannot continue from ${label(problem.from)} ending at `
            + `${problem.from.endElementId} to ${label(problem.to)} starting at ${problem.to.startElementId}.`;
        blockers.push(...vehicleProblems(candidate, this.services().map(savedWindow)).map(describe));
      } else {
        // Before a path exists only the start instant can be judged.
        const busy = this.busyAtStart;
        if (busy !== null) {
          blockers.push(`${vehicleId} is running service #${busy.serviceId} at this time (${range(busy.start, busy.end)}).`);
        }
      }
      const held = (group: string, holder: { vehicleId: string; serviceId: number; start: number; end: number }) =>
        `interlocking group ${group} is held by ${holder.vehicleId} service #${holder.serviceId}, ${range(holder.start, holder.end)}`;
      for (const conflict of interlockingConflicts(timeline, vehicleId, this.services(), elements, editingId)) {
        conflictIds.add(conflict.elementId);
        blockers.push(`${conflict.elementId} (step ${conflict.pathIndex + 1}): ${held(conflict.group, conflict)}.`);
      }
      const pathEnd = timeline.length > 0
        ? timeline[timeline.length - 1].end
        : Date.parse(`${this.serviceForm.startTime}+08:00`);
      for (const [elementId, conflict] of blockedNextElements(path, pathEnd, vehicleId, this.services(), this.topology(), editingId)) {
        blocked[elementId] = `on the way through ${conflict.elementId}, ${held(conflict.group, conflict)}`;
      }
    }
    // The map redraws whenever an input changes identity, so keep unchanged values.
    const setIfChanged = <T>(target: { (): T; set(value: T): void }, value: T) => {
      if (JSON.stringify(target()) !== JSON.stringify(value)) {
        target.set(value);
      }
    };
    setIfChanged(this.blockers, blockers);
    setIfChanged(this.conflictElementIds, [...conflictIds]);
    setIfChanged(this.blockedNext, blocked);
  }

  private clearNotice(): void {
    this.notice.set('');
  }

  private successTimer?: ReturnType<typeof setTimeout>;

  // Success messages dismiss themselves; errors and warnings stay until closed.
  private showSuccess(message: string): void {
    this.noticeKind.set('success');
    this.notice.set(message);
    clearTimeout(this.successTimer);
    this.successTimer = setTimeout(() => {
      if (this.noticeKind() === 'success') {
        this.notice.set('');
      }
    }, 4000);
  }

  private showWarning(message: string): void {
    this.noticeKind.set('warning');
    this.notice.set(message);
  }

  private showErrorMessage(message: string): void {
    this.noticeKind.set('error');
    this.notice.set(message);
  }

  private showError(error: unknown): void {
    this.showErrorMessage(errorMessage(error));
  }
}
