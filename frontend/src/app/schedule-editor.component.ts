import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import { ServiceRequest, ServiceResponse, TopologyResponse, VehicleResponse } from './models';
import { errorMessage, formatForDisplay, fromDatetimeLocal, toDatetimeLocal } from './page-helpers';
import { TrackMapComponent } from './track-map.component';
import { derivePlatformTimings, nextStartTime, savedTimingsAreStale } from './service-timing';

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
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TrackMapComponent],
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
  readonly loadingServices = signal(false);
  readonly savingService = signal(false);
  readonly timingError = signal('');
  readonly missingBlockIds = signal<string[]>([]);
  readonly editingServiceId = signal<number | null>(null);
  readonly pathSelection = signal<string[]>(['Y']);
  readonly isBusy = computed(() => this.loadingInitial() || this.loadingServices() || this.savingService());
  readonly formatForDisplay = formatForDisplay;
  readonly pathEndpointLabel = computed(() => {
    const path = this.pathSelection();
    if (path.length === 0) {
      return 'Choose a starting track element for the editable service path.';
    }
    const start = path[0];
    const end = path[path.length - 1];
    return `Editing path endpoints: ${start} -> ${end}`;
  });

  serviceForm: ServiceForm = this.createEmptyForm();

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
        }
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  loadServices(): void {
    this.loadingServices.set(true);
    this.api.getServices().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (services) => {
        this.services.set(services);
        this.loadingServices.set(false);
      },
      error: (error: unknown) => {
        this.loadingServices.set(false);
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

  onStartTimeChange(value: string): void {
    this.serviceForm.startTime = value;
    this.recalculateTimings();
  }

  setDwellSeconds(row: TimingFormRow, value: number | null): void {
    row.dwellSeconds = value;
    this.recalculateTimings();
  }

  selectPathElement(elementId: string): void {
    const next = [...this.pathSelection(), elementId];
    this.setPathSelection(next);
  }

  undoPathElement(): void {
    this.setPathSelection(this.pathSelection().slice(0, -1));
  }

  resetPathToY(): void {
    this.setPathSelection(['Y']);
  }

  choosePathStart(): void {
    this.setPathSelection([]);
  }

  onPathTextChange(value: string): void {
    this.serviceForm.pathText = value;
    this.pathSelection.set(this.parsePathText());
    this.fillPlatformRowsFromPath();
  }

  submitService(): void {
    if (this.isBusy()) {
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
    this.pathSelection.set(['Y']);
    this.recalculateTimings();
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

  trackTimingRow(index: number): number {
    return index;
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

  private clearNotice(): void {
    this.notice.set('');
  }

  private showSuccess(message: string): void {
    this.noticeKind.set('success');
    this.notice.set(message);
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
