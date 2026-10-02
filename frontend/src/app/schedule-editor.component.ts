
import { ChangeDetectorRef, Component, DestroyRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import {
  BatteryConflict, INITIAL_BATTERY, MINIMUM_DEPARTURE_BATTERY, TimedService, blockIdSet, newBatteryConflicts, scheduleUntil,
  secondsToDepartureCharge, timedService, vehicleBatterySegments, withCandidate,
} from './battery-preview';
import { PlaybackVehicleState, ScheduleAnalysis, ServiceRequest, ServiceResponse, TopologyResponse, VehicleResponse } from './models';
import {
  describeConflicts, errorMessage, formatClockTime, formatDuration, formatForDisplay, formatServiceDate, formatTimelineTime, fromDatetimeLocal, toDatetimeLocal,
} from './page-helpers';
import { nextPathSteps, pathLengthProblems, withoutLastStep } from './path-steps';
import { vehicleStatesAt } from './playback';
import { serviceEndTime, servicePositions } from './schedule-overview';
import { ServicePathStripComponent } from './service-path-strip.component';
import { EndDwell, TrackMapComponent, vehicleColor } from './track-map.component';
import { VehicleIconComponent } from './vehicle-icon.component';
import {
  ScheduleWindow, TrackConflict, VehicleProblem, blockedNextElements, candidateTimeline, deletionProblem, earliestOpenStart,
  nextStepTimelines, pathEndpointProblems, savedWindow, trackConflicts, vehicleProblems,
} from './service-conflicts';
import {
  BusyTimeOptions, StartTimeParts, VehicleBusyWindow, VehicleSlot, busyTimeOptions, calendarMonthCells, composeStartTime, derivePlatformTimings, nextStartTime,
  savedTimingsAreStale, splitStartTime, startPartRange, freeInstantWithin, taipeiLocal, touchesBusy, vehicleBusyWindows, vehicleContinuation, vehiclePositionAt,
  vehicleSlots,
} from './service-timing';
import { unavailableSpans } from './start-availability';

// How long the map takes to advance through the time one click adds to the path.
const MAP_ADVANCE_MS = 1200;
// Room on the timeline bar before the first and after the last saved service.
const TIMELINE_MARGIN_MS = 10 * 60 * 1000;

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
  imports: [FormsModule, RouterLink, ServicePathStripComponent, TrackMapComponent, VehicleIconComponent],
  templateUrl: './schedule-editor.component.html',
  styleUrl: './scheduling-page.css',
})
export class ScheduleEditorComponent implements OnInit {
  private readonly api = inject(SchedulingApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
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
  readonly blockTimesChanged = signal(false);
  readonly pathSelection = signal<string[]>(['Y']);
  // Live previews of what the backend would reject; see service-conflicts.ts.
  readonly blockers = signal<string[]>([]);
  // Low battery on the way to the yard: shown, but it does not stop a save.
  readonly lowBatteryNotes = signal<string[]>([]);
  // The floating status panel can be reduced to its one-line verdict.
  readonly statusCollapsed = signal(false);
  readonly conflictElementIds = signal<string[]>([]);
  readonly blockedNext = signal<Record<string, string>>({});
  readonly servicePositions = computed(() => servicePositions(this.services()));
  readonly serviceEndTime = serviceEndTime;
  readonly blockedNextList = computed(() => Object.entries(this.blockedNext()));
  // Where every vehicle is, and its battery, at the instant the path being
  // built ends. The vehicle in the form follows the draft path.
  readonly mapVehicles = signal<PlaybackVehicleState[]>([]);
  // The dwell at the platform the path ends at; the map shows it there with buttons.
  readonly endDwell = signal<EndDwell | null>(null);
  readonly mapInstant = signal<number | null>(null);
  // The battery the vehicle in the form has left where the path ends.
  readonly draftBattery = signal<string>('');
  // The schedule the map reads, with the draft in it, and the time span the
  // timeline bar covers. The bar sits at the instant the path ends.
  private mapSchedule: ScheduleAnalysis | null = null;
  private mapDraftVehicleId: string | null = null;
  private pathEndInstant: number | null = null;
  readonly mapRange = signal<{ start: number; end: number } | null>(null);
  readonly draftBar = signal<{ leftPercent: number; widthPercent: number } | null>(null);
  readonly mapCursorPercent = computed(() => {
    const range = this.mapRange();
    const instant = this.mapInstant();
    return range === null || instant === null ? 0 : ((instant - range.start) / (range.end - range.start)) * 100;
  });
  // Stretches of the bar the service cannot be moved to; see start-availability.ts.
  readonly unavailableBars = signal<{ leftPercent: number; widthPercent: number; title: string; battery: boolean }[]>([]);
  private mapPath: string[] = [];
  private mapAdvanceFrame: number | null = null;
  // Vehicles in the way of the path, and vehicles the path would run low.
  readonly alertVehicleIds = signal<string[]>([]);
  readonly batteryAlertVehicleIds = signal<string[]>([]);
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
  readonly formatServiceDate = formatServiceDate;
  readonly formatClockTime = formatClockTime;
  readonly formatTimelineTime = formatTimelineTime;
  readonly formatDuration = formatDuration;
  readonly vehicleColor = vehicleColor;

  serviceForm: ServiceForm = this.createEmptyForm();
  startParts: StartTimeParts = splitStartTime(this.serviceForm.startTime);
  // Rendered as one ISO-like timestamp: the date opens a calendar, then 12 : 26 : 40 as dropdowns.
  readonly startTimeFields: { key: 'hour' | 'minute' | 'second'; label: string; separator: string; values: number[] }[] = [
    { key: 'hour', label: 'Hour', separator: '·', values: Array.from({ length: 24 }, (_, index) => index) },
    { key: 'minute', label: 'Minute', separator: ':', values: Array.from({ length: 60 }, (_, index) => index) },
    { key: 'second', label: 'Second', separator: ':', values: Array.from({ length: 60 }, (_, index) => index) },
  ];

  readonly weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  calendarOpen = false;
  calendarView = { year: 2026, month: 1 };

  get calendarTitle(): string {
    return `${this.calendarView.year}-${String(this.calendarView.month).padStart(2, '0')}`;
  }

  get calendarCells(): (number | null)[] {
    return calendarMonthCells(this.calendarView.year, this.calendarView.month);
  }

  toggleCalendar(): void {
    this.calendarOpen = !this.calendarOpen;
    if (this.calendarOpen) {
      const today = splitStartTime(taipeiLocal(Date.now()));
      this.calendarView = {
        year: this.startParts.year ?? today.year!,
        month: this.startParts.month ?? today.month!,
      };
    }
  }

  shiftCalendar(months: number): void {
    const index = this.calendarView.year * 12 + this.calendarView.month - 1 + months;
    this.calendarView = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  }

  private calendarDate(day: number): string {
    return `${this.calendarTitle}-${String(day).padStart(2, '0')}`;
  }

  isSelectedDay(day: number): boolean {
    return this.calendarDate(day) === this.startDate;
  }

  isToday(day: number): boolean {
    return this.calendarDate(day) === taipeiLocal(Date.now()).slice(0, 10);
  }

  // A day is unavailable only when the vehicle is busy for all of it.
  isBusyDay(day: number): boolean {
    const dayStart = Date.parse(`${this.calendarDate(day)}T00:00:00+08:00`);
    return freeInstantWithin(this.busyWindows, dayStart, dayStart, dayStart + 86400000) === null;
  }

  pickDay(day: number): void {
    const previous = { ...this.startParts };
    this.startParts = { ...this.startParts, year: this.calendarView.year, month: this.calendarView.month, day };
    this.calendarOpen = false;
    this.applyStartParts(previous, 'day');
  }

  @HostListener('document:click', ['$event'])
  closeCalendarOnOutsideClick(event: MouseEvent): void {
    if (this.calendarOpen && !(event.target as HTMLElement).closest('.date-picker')) {
      this.calendarOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  closeCalendar(): void {
    this.calendarOpen = false;
  }

  isBusyOption(key: 'hour' | 'minute' | 'second', value: number): boolean {
    return this.busyTimeOptions[key][value];
  }

  isPartlyBusyOption(key: 'hour' | 'minute' | 'second', value: number): boolean {
    return key !== 'second' && this.busyTimeOptions.partlyBusy[key][value];
  }

  isPartlyBusyDay(day: number): boolean {
    const dayStart = Date.parse(`${this.calendarDate(day)}T00:00:00+08:00`);
    return !this.isBusyDay(day) && touchesBusy(this.busyWindows, dayStart, 86400000);
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

  axisTime(instant: number, reference: number): string {
    return formatTimelineTime(taipeiLocal(instant), taipeiLocal(reference));
  }

  slotDate(instant: number): string {
    return formatServiceDate(taipeiLocal(instant));
  }

  slotClock(instant: number): string {
    return formatClockTime(taipeiLocal(instant));
  }

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.stopMapAdvance());
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
    const notes: string[] = [];
    // A vehicle back in the yard may only leave once it is charged to 80.
    let charged = earliest;
    if (continuation !== null && elementId === 'Y') {
      const segments = vehicleBatterySegments(
        this.services().filter((service) => service.vehicleId === vehicleId).map(timedService),
        blockIdSet(this.topology().elements),
      );
      const battery = segments.length > 0 ? segments[segments.length - 1].batteryEnd : INITIAL_BATTERY;
      charged += secondsToDepartureCharge(battery) * 1000;
      if (charged > earliest) {
        notes.push(`Start moved from ${this.slotTime(earliest)} to ${this.axisTime(charged, earliest)}: ${vehicleId} returns to `
          + `the yard with ${this.batteryUnits(battery)} battery units and must charge to ${MINIMUM_DEPARTURE_BATTERY} before leaving.`);
      }
    }
    const open = earliestOpenStart(elementId, charged, vehicleId, this.services(), this.topology());
    const startTime = taipeiLocal(open.start);
    if (open.avoided !== null) {
      notes.push(`Start moved from ${this.slotTime(charged)} to ${this.axisTime(open.start, charged)}: `
        + `${open.avoided.vehicleId} service #${open.avoided.serviceId} `
        + (open.avoided.group === null
          ? `occupies block ${open.avoided.elementId}`
          : `holds interlocking group ${open.avoided.group}`)
        + ` on every way out of ${elementId} before then.`);
    }
    this.startMove = notes.length === 0 ? null : { startTime, message: notes.join(' ') };
    this.setStartTime(startTime);
    this.startChosen = false;
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
    const previous = { ...this.startParts };
    this.startParts[key] = value;
    this.applyStartParts(previous, key);
  }

  private applyStartParts(previous: StartTimeParts, key: keyof StartTimeParts): void {
    this.serviceForm.startTime = composeStartTime(this.startParts);
    // The part just chosen is kept. If the combination lands inside one of the
    // vehicle's services, only the smaller parts move, to a free time within
    // the chosen one; when it has none, the choice is undone.
    const chosen = Date.parse(`${this.serviceForm.startTime}+08:00`);
    const range = startPartRange(this.startParts, key);
    if (Number.isFinite(chosen) && range !== null) {
      const vehicleId = this.serviceForm.vehicleId;
      const free = freeInstantWithin(this.busyWindows, chosen, range.start, range.end);
      if (free === null) {
        this.serviceForm.startTime = composeStartTime(previous);
        // The dropdown already shows the rejected value; it only redraws when
        // its model changes, so the old parts are restored on the next tick.
        setTimeout(() => {
          this.startParts = previous;
          this.changeDetector.markForCheck();
        });
        this.showWarning(`${vehicleId} is busy for all of the ${key} you picked, so the start time was left unchanged.`);
      } else if (free !== chosen) {
        this.setStartTime(taipeiLocal(free));
        this.showWarning(`${vehicleId} is busy at ${this.slotTime(chosen)}, so the start time was set to ${this.axisTime(free, chosen)}, the nearest free time in that ${key}.`);
      }
    }
    if (!this.followVehicleAt(Date.parse(`${this.serviceForm.startTime}+08:00`))) {
      this.recalculateTimings();
    }
  }

  // A new service with no path yet starts where its vehicle is at the chosen
  // time, so changing the time never discards a path. A start the user picked
  // with "Change start" is kept, unless the vehicle is known to be somewhere
  // else at that time. Returns whether the start element was set.
  private followVehicleAt(instant: number): boolean {
    const path = this.pathSelection();
    if (this.editingServiceId() !== null || path.length > 1 || !Number.isFinite(instant)) {
      return false;
    }
    const position = vehiclePositionAt(this.busyWindows, instant);
    if (position.busy !== null) {
      return false;
    }
    if (this.startChosen && path.length === 1 && (position.elementId === null || position.elementId === path[0])) {
      return false;
    }
    this.startChosen = false;
    this.setPathSelection([position.elementId ?? 'Y']);
    return true;
  }

  // True once the user picked the start element on the map instead of taking the vehicle's position.
  private startChosen = false;

  useFreeSlot(slot: VehicleSlot): void {
    if (slot.start === null) {
      return;
    }
    this.setStartTime(taipeiLocal(slot.start));
    if (this.editingServiceId() === null) {
      this.startChosen = false;
      this.setPathSelection([slot.elementId ?? 'Y']);
    } else {
      this.recalculateTimings();
    }
  }

  private endPlatformRow(): TimingFormRow | undefined {
    const lastIndex = this.pathSelection().length - 1;
    return this.serviceForm.platformTimings.find((row) => row.pathIndex === lastIndex);
  }

  // The map's buttons at the platform the path ends at.
  stepEndDwell(seconds: number): void {
    const row = this.endPlatformRow();
    if (row !== undefined) {
      this.setDwellSeconds(row, Math.max(0, (row.dwellSeconds ?? 0) + seconds));
    }
  }

  setDwellSeconds(row: TimingFormRow, value: number | null): void {
    row.dwellSeconds = value;
    this.recalculateTimings();
  }

  // A click on the next stop also adds the blocks leading to it; see path-steps.ts.
  selectPathElement(elementId: string): void {
    if (this.pathSelection().length === 0) {
      this.startChosen = true;
    }
    const steps = nextPathSteps(this.pathSelection(), this.topology()).get(elementId) ?? [elementId];
    this.setPathSelection([...this.pathSelection(), ...steps]);
  }

  undoPathElement(): void {
    this.setPathSelection(withoutLastStep(this.pathSelection(), this.topology()));
  }

  resetPathToY(): void {
    this.startChosen = true;
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
    this.blockTimesChanged.set(savedTimingsAreStale(service, this.topology().elements));
    if (this.blockTimesChanged()) {
      this.recalculateTimings();
      this.showWarning(`Editing service #${service.id}. Block traversal times changed since it was saved. Saving applies the new times only if all scheduling checks pass.`);
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
    this.blockTimesChanged.set(false);
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
          this.showWarning(`${successMessage} ${describeConflicts(analysis.conflicts)}`);
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
    this.blockTimesChanged.set(this.originalService !== null
      && savedTimingsAreStale(this.originalService, topology.elements));
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
    const blockers: string[] = [...pathLengthProblems(path), ...pathEndpointProblems(path, elements)];
    const conflictIds = new Set<string>();
    const blocked: Record<string, string> = {};
    let vehicleRulesBroken = false;
    const lowBatteryNotes: string[] = [];
    const alertVehicles = new Set<string>();
    const batteryAlerts = new Set<string>();
    const saved = this.services().map(timedService);
    const draft: TimedService | null = timeline !== null && timeline.length > 0 && vehicleId
      ? { serviceId: editingId, vehicleId, timeline }
      : null;
    const pathEnd = timeline !== null && timeline.length > 0
      ? timeline[timeline.length - 1].end
      : Date.parse(`${this.serviceForm.startTime}+08:00`);
    if (timeline !== null && vehicleId) {
      const range = (start: number, end: number) => `${this.slotTime(start)} to ${this.axisTime(end, start)}`;
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
        const problems = vehicleProblems(candidate, this.services().map(savedWindow));
        vehicleRulesBroken = problems.length > 0;
        blockers.push(...problems.map(describe));
      } else {
        // Before a path exists only the start instant can be judged.
        const busy = this.busyAtStart;
        if (busy !== null) {
          blockers.push(`${vehicleId} is running service #${busy.serviceId} at this time (${range(busy.start, busy.end)}).`);
        }
      }
      const held = (conflict: TrackConflict) =>
        (conflict.group === null
          ? `block ${conflict.elementId} is occupied by`
          : `interlocking group ${conflict.group} is held by`)
        + ` ${conflict.vehicleId} service #${conflict.serviceId}, ${range(conflict.start, conflict.end)}`;
      for (const conflict of trackConflicts(timeline, vehicleId, this.services(), elements, editingId)) {
        conflictIds.add(conflict.elementId);
        alertVehicles.add(conflict.vehicleId);
        blockers.push(`${conflict.elementId} (step ${conflict.pathIndex + 1}): ${held(conflict)}.`);
      }
      // The battery is only worked out for a schedule the vehicle can drive:
      // across an overlap or a jump between stops the numbers mean nothing,
      // and the backend rejects those first as well.
      const draftBatteryConflicts = draft !== null && timeline.length >= 2 && !vehicleRulesBroken
        ? newBatteryConflicts(draft, saved, elements)
        : [];
      for (const conflict of draftBatteryConflicts) {
        batteryAlerts.add(conflict.vehicleId);
        if (conflict.allowed) {
          lowBatteryNotes.push(`${conflict.vehicleId} is below 30 battery units from ${conflict.elementId} `
            + `(step ${conflict.pathIndex! + 1}) at ${this.slotTime(conflict.start)} until it reaches the yard.`);
        } else {
          blockers.push(this.describeBatteryConflict(conflict, draft!));
        }
      }
      for (const [elementId, conflict] of blockedNextElements(path, pathEnd, vehicleId, this.services(), this.topology(), editingId)) {
        alertVehicles.add(conflict.vehicleId);
        blocked[elementId] = `on the way through ${conflict.elementId}, ${held(conflict)}`;
      }
      // A next stop is also blocked when the way there would break a battery
      // rule. Only this path's own steps count: what the unfinished path does
      // to later services is judged once the stop is added. Once the path
      // itself breaks a rule, every next stop would repeat it.
      if (draftBatteryConflicts.every((conflict) => conflict.allowed)) {
        for (const [elementId, intervals] of nextStepTimelines(path, pathEnd, this.topology())) {
          const extended: TimedService = { serviceId: editingId, vehicleId, timeline: [...timeline, ...intervals] };
          const conflict = elementId in blocked
            ? undefined
            : newBatteryConflicts(extended, saved, elements)
              .find((found) => found.service === extended && !found.allowed);
          // No alarm on the vehicle for this: the path itself is fine, for
          // example it has just reached the yard and has to charge first.
          if (conflict !== undefined) {
            blocked[elementId] = this.describeBatteryConflict(conflict, extended);
          }
        }
      }
    }
    const shown = draft === null ? saved : withCandidate(saved, draft);
    // The timeline bar spans every saved service and the draft.
    const starts = shown.flatMap((service) => service.timeline.slice(0, 1).map((interval) => interval.start));
    const ends = shown.flatMap((service) => service.timeline.slice(-1).map((interval) => interval.end));
    // The span is taken from the saved services so it stays still while the
    // draft is dragged; it only grows when the draft leaves it.
    const savedStarts = saved.flatMap((service) => service.timeline.slice(0, 1).map((interval) => interval.start));
    const savedEnds = saved.flatMap((service) => service.timeline.slice(-1).map((interval) => interval.end));
    const base = savedStarts.length > 0
      ? { start: Math.min(...savedStarts) - TIMELINE_MARGIN_MS, end: Math.max(...savedEnds) + TIMELINE_MARGIN_MS }
      : this.mapRange() ?? { start: pathEnd - 3 * TIMELINE_MARGIN_MS, end: pathEnd + 3 * TIMELINE_MARGIN_MS };
    const range = Number.isFinite(pathEnd)
      // Room is kept after the path end, so the bar can always be dragged later.
      ? { start: Math.min(pathEnd, base.start, ...starts), end: Math.max(pathEnd + TIMELINE_MARGIN_MS, base.end, ...ends) }
      : null;
    this.mapSchedule = range === null ? null : scheduleUntil(shown, elements, range.end);
    this.mapDraftVehicleId = draft === null ? null : vehicleId;
    this.pathEndInstant = range === null ? null : pathEnd;
    const span = range === null ? 0 : range.end - range.start;
    const range2 = (start: number, end: number) => `${this.slotTime(start)} and ${this.axisTime(end, start)}`;
    // The map redraws whenever an input changes identity, so keep unchanged values.
    const setIfChanged = <T>(target: { (): T; set(value: T): void }, value: T) => {
      if (JSON.stringify(target()) !== JSON.stringify(value)) {
        target.set(value);
      }
    };
    const endRow = this.endPlatformRow();
    setIfChanged(this.endDwell, endRow === undefined || endRow.dwellSeconds === null
      ? null
      : { elementId: endRow.platformId, seconds: endRow.dwellSeconds });
    setIfChanged(this.blockers, blockers);
    setIfChanged(this.lowBatteryNotes, lowBatteryNotes);
    setIfChanged(this.conflictElementIds, [...conflictIds]);
    setIfChanged(this.blockedNext, blocked);
    setIfChanged(this.mapRange, span > 0 ? range : null);
    setIfChanged(this.draftBar, span > 0 && draft !== null
      ? {
          leftPercent: ((draft.timeline[0].start - range!.start) / span) * 100,
          widthPercent: ((pathEnd - draft.timeline[0].start) / span) * 100,
        }
      : null);
    const percent = (span: { start: number; end: number }) => ({
      leftPercent: ((span.start - range!.start) / (range!.end - range!.start)) * 100,
      widthPercent: ((span.end - span.start) / (range!.end - range!.start)) * 100,
    });
    setIfChanged(this.unavailableBars, range === null || draft === null ? [] : unavailableSpans(
      { vehicleId, serviceId: editingId, timeline: timeline!, followsVehicle: editingId === null && path.length <= 1 && !this.startChosen },
      range, this.services(), elements,
    ).map((span) => ({
      ...percent(span),
      battery: span.reason === 'battery',
      title: (span.reason === 'battery' ? 'Not enough battery to leave the yard: cannot end between ' : 'Cannot end between ')
        + range2(span.start, span.end),
    })));
    const previousInstant = this.mapInstant();
    const extended = path.length > this.mapPath.length
      && this.mapPath.length > 0
      && this.mapPath.every((elementId, index) => elementId === path[index]);
    this.mapPath = path;
    this.stopMapAdvance();
    if (range !== null && extended && previousInstant !== null && previousInstant < pathEnd
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.advanceMap(previousInstant, pathEnd);
    } else {
      this.showMapAt(pathEnd);
    }
    setIfChanged(this.alertVehicleIds, [...alertVehicles]);
    setIfChanged(this.batteryAlertVehicleIds, [...batteryAlerts]);
  }

  // Dragging the timeline bar moves the whole service in time: the bar is the
  // instant the path ends, so the start time moves by the same amount.
  moveServiceTo(seconds: number | string): void {
    const start = Date.parse(`${this.serviceForm.startTime}+08:00`);
    if (this.pathEndInstant === null || !Number.isFinite(start)) {
      return;
    }
    const moved = start + Number(seconds) * 1000 - this.pathEndInstant;
    this.setStartTime(taipeiLocal(moved));
    if (!this.followVehicleAt(moved)) {
      this.recalculateTimings();
    }
  }

  moveServiceFromAxis(event: MouseEvent): void {
    const range = this.mapRange();
    if (range !== null) {
      const axis = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - axis.left) / axis.width));
      this.moveServiceTo(Math.round((range.start + (range.end - range.start) * fraction) / 1000));
    }
  }

  // A click that extends the path takes time. The map advances through it, so
  // every vehicle is seen moving to where it is when the path ends.
  private advanceMap(from: number, to: number): void {
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / MAP_ADVANCE_MS);
      this.showMapAt(from + (to - from) * progress);
      this.mapAdvanceFrame = progress < 1 ? requestAnimationFrame(step) : null;
    };
    this.mapAdvanceFrame = requestAnimationFrame(step);
  }

  private stopMapAdvance(): void {
    if (this.mapAdvanceFrame !== null) {
      cancelAnimationFrame(this.mapAdvanceFrame);
      this.mapAdvanceFrame = null;
    }
  }

  private showMapAt(instant: number): void {
    const vehicles = this.mapSchedule === null ? [] : vehicleStatesAt(this.mapSchedule, this.topology(), instant);
    const draftVehicleId = this.mapDraftVehicleId;
    const draftState = vehicles.find((vehicle) => vehicle.vehicleId === draftVehicleId);
    // The map redraws whenever an input changes identity, so keep unchanged values.
    if (JSON.stringify(this.mapVehicles()) !== JSON.stringify(vehicles)) {
      this.mapVehicles.set(vehicles);
    }
    this.mapInstant.set(this.mapSchedule === null ? null : instant);
    this.draftBattery.set(draftState === undefined
      ? ''
      : `${draftVehicleId} is at ${draftState.elementId} with ${this.batteryUnits(draftState.battery)} battery units left.`);
  }

  private batteryUnits(battery: number): string {
    return String(Math.floor(battery * 10) / 10);
  }

  private describeBatteryConflict(conflict: BatteryConflict, draft: TimedService): string {
    const where = conflict.service === draft
      ? `step ${conflict.pathIndex! + 1}`
      : conflict.service !== null ? `service #${conflict.service.serviceId}` : 'while waiting';
    const at = `${conflict.elementId} (${where}) at ${this.slotTime(conflict.start)}`;
    if (conflict.kind === 'EMPTY_BATTERY') {
      return `${conflict.vehicleId} would run out of battery: it cannot cross ${at} with `
        + `${this.batteryUnits(conflict.battery)} battery units left.`;
    }
    return conflict.kind === 'INSUFFICIENT_CHARGE'
      ? `${conflict.vehicleId} would leave the yard for ${at} with ${this.batteryUnits(conflict.battery)} battery units; `
        + `${MINIMUM_DEPARTURE_BATTERY} are required, which takes ${secondsToDepartureCharge(conflict.battery)} more seconds in the yard.`
      : `${conflict.vehicleId} would drop below 30 battery units outside the yard, on ${at}.`;
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
