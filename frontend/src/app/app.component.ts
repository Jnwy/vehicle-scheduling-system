import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

const API_BASE_URL = 'http://localhost:8000';

type ElementType = 'YARD' | 'PLATFORM' | 'BLOCK';

interface VehicleResponse {
  id: string;
}

interface TrackElementResponse {
  id: string;
  elementType: ElementType;
  traversalSeconds: number | null;
  interlockingGroup: string | null;
}

interface TrackConnectionResponse {
  fromElementId: string;
  toElementId: string;
}

interface TopologyResponse {
  elements: TrackElementResponse[];
  connections: TrackConnectionResponse[];
}

interface BlockResponse {
  id: string;
  traversalSeconds: number | null;
  interlockingGroup: string | null;
}

interface BlockRequest {
  traversalSeconds: number;
}

interface PlatformTiming {
  pathIndex: number;
  arrivalTime: string;
  departureTime: string;
}

interface TimelineInterval {
  pathIndex: number;
  elementId: string;
  startTime: string;
  endTime: string;
}

interface ServiceResponse {
  id: number;
  vehicleId: string;
  startTime: string;
  path: string[];
  platformTimings: PlatformTiming[];
  timeline: TimelineInterval[];
}

interface ServiceRequest {
  vehicleId: string;
  startTime: string;
  path: string[];
  platformTimings: PlatformTiming[];
}

interface TimingFormRow {
  pathIndex: number | null;
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
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <main>
      <header class="page-header">
        <div>
          <p class="eyebrow">Vehicle Scheduling System</p>
          <h1>Schedule editor</h1>
        </div>
        <button type="button" class="secondary" [disabled]="isBusy()" (click)="refreshAll()">
          Refresh
        </button>
      </header>

      <section *ngIf="notice()" class="notice" [class.error]="noticeKind() === 'error'" [class.success]="noticeKind() === 'success'">
        {{ notice() }}
      </section>

      <section class="layout">
        <div class="left-column">
          <section class="panel">
            <div class="section-header">
              <div>
                <h2>Topology reference</h2>
                <p>{{ topology().elements.length }} elements | {{ topology().connections.length }} directed connections</p>
              </div>
            </div>

            <div class="element-groups">
              <div *ngFor="let group of topologyGroups()" class="element-group">
                <h3>{{ group.label }}</h3>
                <div class="chips">
                  <span *ngFor="let element of group.elements" class="chip" [class.block]="element.elementType === 'BLOCK'">
                    {{ element.id }}
                    <small *ngIf="element.elementType === 'BLOCK'">
                      {{ element.traversalSeconds === null ? 'unset' : element.traversalSeconds + 's' }}
                    </small>
                  </span>
                </div>
              </div>
            </div>

            <div class="connection-list">
              <span *ngFor="let edge of topology().connections" class="connection">
                {{ edge.fromElementId }} -> {{ edge.toElementId }}
              </span>
            </div>
          </section>

          <section class="panel">
            <div class="section-header">
              <div>
                <h2>Block traversal times</h2>
                <p>Saved services keep their existing timeline snapshots.</p>
              </div>
            </div>

            <div class="block-table" role="table" aria-label="Block traversal configuration">
              <div class="table-row table-head" role="row">
                <span role="columnheader">Block</span>
                <span role="columnheader">Seconds</span>
                <span role="columnheader">Group</span>
                <span role="columnheader"></span>
              </div>
              <div *ngFor="let block of blocks()" class="table-row" role="row">
                <strong role="cell">{{ block.id }}</strong>
                <label role="cell" class="inline-input">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    [name]="'block-' + block.id"
                    [ngModel]="blockDrafts()[block.id] ?? ''"
                    (ngModelChange)="setBlockDraft(block.id, $event)"
                    placeholder="unset"
                  />
                </label>
                <span role="cell">{{ block.interlockingGroup ?? '-' }}</span>
                <button
                  role="cell"
                  type="button"
                  class="small"
                  [disabled]="savingBlockId() === block.id"
                  (click)="saveBlock(block)"
                >
                  {{ savingBlockId() === block.id ? 'Saving' : 'Save' }}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div class="right-column">
          <section class="panel form-panel">
            <div class="section-header">
              <div>
                <h2>{{ editingServiceId() === null ? 'Create service' : 'Update service #' + editingServiceId() }}</h2>
                <p>Use a complete ordered path; the backend validates direction and schedule rules.</p>
              </div>
              <button *ngIf="editingServiceId() !== null" type="button" class="secondary" (click)="cancelEdit()">
                Cancel edit
              </button>
            </div>

            <form (ngSubmit)="submitService()" class="service-form">
              <div class="form-grid">
                <label>
                  Vehicle
                  <select name="vehicleId" required [(ngModel)]="serviceForm.vehicleId">
                    <option value="" disabled>Select vehicle</option>
                    <option *ngFor="let vehicle of vehicles()" [value]="vehicle.id">{{ vehicle.id }}</option>
                  </select>
                </label>

                <label>
                  Start time
                  <input
                    name="startTime"
                    type="datetime-local"
                    step="1"
                    required
                    [(ngModel)]="serviceForm.startTime"
                  />
                </label>
              </div>

              <label>
                Ordered path
                <input
                  name="pathText"
                  type="text"
                  required
                  [(ngModel)]="serviceForm.pathText"
                  placeholder="Y, B1, P1A"
                />
              </label>

              <div class="timing-header">
                <h3>Platform timings</h3>
                <div class="timing-actions">
                  <button type="button" class="secondary small" (click)="fillPlatformRowsFromPath()">
                    Use path platforms
                  </button>
                  <button type="button" class="secondary small" (click)="addPlatformTiming()">
                    Add row
                  </button>
                </div>
              </div>

              <div *ngIf="serviceForm.platformTimings.length === 0" class="empty muted">
                No platform timing rows.
              </div>

              <div *ngFor="let timing of serviceForm.platformTimings; let index = index; trackBy: trackTimingRow" class="timing-row">
                <label>
                  Path index
                  <input
                    type="number"
                    min="0"
                    step="1"
                    [name]="'pathIndex-' + index"
                    [(ngModel)]="timing.pathIndex"
                    required
                  />
                </label>
                <label>
                  Arrival
                  <input
                    type="datetime-local"
                    step="1"
                    [name]="'arrival-' + index"
                    [(ngModel)]="timing.arrivalTime"
                    required
                  />
                </label>
                <label>
                  Departure
                  <input
                    type="datetime-local"
                    step="1"
                    [name]="'departure-' + index"
                    [(ngModel)]="timing.departureTime"
                    required
                  />
                </label>
                <button type="button" class="icon-button" [attr.aria-label]="'Delete timing row ' + (index + 1)" (click)="removePlatformTiming(index)">
                  x
                </button>
              </div>

              <div class="form-actions">
                <button type="submit" [disabled]="savingService()">
                  {{ savingService() ? 'Saving' : editingServiceId() === null ? 'Create service' : 'Update service' }}
                </button>
                <button type="button" class="secondary" (click)="resetForm()">Reset</button>
              </div>
            </form>
          </section>

          <section class="panel">
            <div class="section-header">
              <div>
                <h2>Services</h2>
                <p>{{ services().length }} saved</p>
              </div>
              <button type="button" class="secondary" [disabled]="loadingServices()" (click)="loadServices()">
                {{ loadingServices() ? 'Refreshing' : 'Refresh list' }}
              </button>
            </div>

            <div *ngIf="services().length === 0 && !loadingServices()" class="empty">
              No services have been scheduled yet.
            </div>

            <article *ngFor="let service of services()" class="service-item">
              <div class="service-summary">
                <div>
                  <h3>#{{ service.id }} | {{ service.vehicleId }}</h3>
                  <p>{{ formatForDisplay(service.startTime) }} | {{ service.path.join(' -> ') }}</p>
                </div>
                <div class="service-actions">
                  <button type="button" class="secondary small" (click)="toggleTimeline(service.id)">
                    {{ expandedServiceIds().has(service.id) ? 'Hide timeline' : 'Timeline' }}
                  </button>
                  <button type="button" class="small" (click)="startEdit(service)">Edit</button>
                  <button type="button" class="danger small" (click)="confirmDelete(service)">Delete</button>
                </div>
              </div>

              <div *ngIf="expandedServiceIds().has(service.id)" class="timeline">
                <div class="table-row table-head">
                  <span>Index</span>
                  <span>Element</span>
                  <span>Start</span>
                  <span>End</span>
                </div>
                <div *ngFor="let interval of service.timeline" class="table-row">
                  <span>{{ interval.pathIndex }}</span>
                  <strong>{{ interval.elementId }}</strong>
                  <span>{{ formatForDisplay(interval.startTime) }}</span>
                  <span>{{ formatForDisplay(interval.endTime) }}</span>
                </div>
              </div>
            </article>
          </section>
        </div>
      </section>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #17202a;
        background: #eef2f6;
      }

      * {
        box-sizing: border-box;
      }

      main {
        width: min(1420px, 100%);
        padding: 24px;
        margin: 0 auto;
      }

      .page-header,
      .section-header,
      .service-summary,
      .form-actions,
      .timing-header,
      .timing-actions,
      .service-actions {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .page-header,
      .section-header,
      .service-summary,
      .timing-header {
        justify-content: space-between;
      }

      .page-header {
        margin-bottom: 18px;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 30px;
        line-height: 1.1;
      }

      h2 {
        font-size: 18px;
      }

      h3 {
        font-size: 14px;
      }

      p,
      .muted,
      small {
        color: #607080;
      }

      .eyebrow {
        margin-bottom: 4px;
        color: #356570;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(320px, 0.95fr) minmax(520px, 1.35fr);
        gap: 18px;
        align-items: start;
      }

      .left-column,
      .right-column {
        display: grid;
        gap: 18px;
      }

      .panel {
        padding: 18px;
        border: 1px solid #d6dee7;
        border-radius: 8px;
        background: #ffffff;
      }

      .form-panel {
        border-top: 4px solid #2d6f8f;
      }

      .notice {
        margin-bottom: 16px;
        padding: 12px 14px;
        border: 1px solid #b8d8c7;
        border-radius: 8px;
        background: #edf8f1;
        color: #1d5f36;
      }

      .notice.error {
        border-color: #efc3c0;
        background: #fff1f0;
        color: #9c2f24;
      }

      .notice.success {
        border-color: #b8d8c7;
        background: #edf8f1;
      }

      button {
        min-height: 38px;
        padding: 0 14px;
        border: 1px solid #235f7a;
        border-radius: 6px;
        background: #235f7a;
        color: #ffffff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      button:hover:not(:disabled) {
        background: #194d65;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.58;
      }

      button.secondary {
        border-color: #b6c4d2;
        background: #f8fafc;
        color: #23313f;
      }

      button.secondary:hover:not(:disabled) {
        background: #e9eef4;
      }

      button.small {
        min-height: 32px;
        padding: 0 10px;
        font-size: 13px;
      }

      button.danger {
        border-color: #a63a32;
        background: #a63a32;
      }

      button.danger:hover:not(:disabled) {
        background: #842920;
      }

      .icon-button {
        width: 34px;
        min-width: 34px;
        height: 34px;
        min-height: 34px;
        padding: 0;
        border-color: #c9d3dd;
        background: #ffffff;
        color: #34495e;
        font-size: 22px;
        line-height: 1;
      }

      label {
        display: grid;
        gap: 6px;
        color: #435466;
        font-size: 13px;
        font-weight: 700;
      }

      input,
      select {
        width: 100%;
        min-width: 0;
        height: 38px;
        padding: 0 10px;
        border: 1px solid #bcc9d6;
        border-radius: 6px;
        background: #ffffff;
        color: #17202a;
        font: inherit;
        font-weight: 500;
      }

      input:focus,
      select:focus {
        border-color: #235f7a;
        outline: 3px solid #d6edf3;
      }

      .element-groups,
      .service-form {
        display: grid;
        gap: 14px;
        margin-top: 16px;
      }

      .element-group {
        display: grid;
        gap: 8px;
      }

      .chips,
      .connection-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .chip,
      .connection {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 28px;
        padding: 3px 8px;
        border: 1px solid #cbd6e2;
        border-radius: 6px;
        background: #f7f9fb;
        font-size: 13px;
        font-weight: 700;
      }

      .chip.block {
        background: #f4f8f0;
      }

      .connection-list {
        max-height: 170px;
        margin-top: 16px;
        overflow: auto;
        padding-right: 4px;
      }

      .connection {
        font-weight: 600;
      }

      .block-table,
      .timeline {
        display: grid;
        gap: 6px;
        margin-top: 16px;
      }

      .table-row {
        display: grid;
        grid-template-columns: 0.75fr 1fr 0.75fr auto;
        gap: 10px;
        align-items: center;
        min-width: 0;
        padding: 8px 0;
        border-bottom: 1px solid #edf1f5;
      }

      .table-row > * {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .table-head {
        color: #657487;
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
      }

      .timeline .table-row {
        grid-template-columns: 58px minmax(68px, 0.8fr) minmax(150px, 1fr) minmax(150px, 1fr);
      }

      .inline-input input {
        max-width: 130px;
      }

      .form-grid {
        display: grid;
        grid-template-columns: minmax(150px, 0.6fr) minmax(220px, 1fr);
        gap: 12px;
      }

      .timing-row {
        display: grid;
        grid-template-columns: minmax(90px, 0.7fr) minmax(170px, 1fr) minmax(170px, 1fr) auto;
        gap: 10px;
        align-items: end;
      }

      .empty {
        margin-top: 16px;
        padding: 14px;
        border: 1px dashed #b9c7d4;
        border-radius: 8px;
        background: #fbfcfe;
      }

      .service-item {
        padding: 14px 0;
        border-bottom: 1px solid #e5ebf0;
      }

      .service-item:last-child {
        border-bottom: 0;
      }

      .service-summary p {
        margin-top: 4px;
        max-width: 680px;
        overflow-wrap: anywhere;
        font-size: 13px;
      }

      .service-actions,
      .timing-actions,
      .form-actions {
        flex-wrap: wrap;
      }

      @media (max-width: 980px) {
        main {
          padding: 16px;
        }

        .layout {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 680px) {
        .page-header,
        .section-header,
        .service-summary,
        .timing-header {
          align-items: stretch;
          flex-direction: column;
        }

        .form-grid,
        .timing-row,
        .table-row,
        .timeline .table-row {
          grid-template-columns: 1fr;
        }

        .service-actions,
        .timing-actions,
        .form-actions {
          display: grid;
          grid-template-columns: 1fr;
        }

        button,
        button.small {
          width: 100%;
        }

        .icon-button {
          width: 100%;
        }
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly vehicles = signal<VehicleResponse[]>([]);
  readonly topology = signal<TopologyResponse>({ elements: [], connections: [] });
  readonly blocks = signal<BlockResponse[]>([]);
  readonly services = signal<ServiceResponse[]>([]);
  readonly blockDrafts = signal<Record<string, string>>({});
  readonly expandedServiceIds = signal<Set<number>>(new Set<number>());
  readonly loadingInitial = signal(false);
  readonly loadingServices = signal(false);
  readonly savingBlockId = signal<string | null>(null);
  readonly savingService = signal(false);
  readonly notice = signal('');
  readonly noticeKind = signal<'success' | 'error'>('success');
  readonly editingServiceId = signal<number | null>(null);

  readonly isBusy = computed(() => this.loadingInitial() || this.loadingServices() || this.savingService());
  readonly topologyGroups = computed(() => {
    const elements = this.topology().elements;

    return [
      { label: 'Yards', elements: elements.filter((element) => element.elementType === 'YARD') },
      { label: 'Platforms', elements: elements.filter((element) => element.elementType === 'PLATFORM') },
      { label: 'Blocks', elements: elements.filter((element) => element.elementType === 'BLOCK') },
    ];
  });

  serviceForm: ServiceForm = this.createEmptyForm();

  ngOnInit(): void {
    this.refreshAll();
  }

  refreshAll(): void {
    this.loadingInitial.set(true);
    this.clearNotice();

    forkJoin({
      vehicles: this.http.get<VehicleResponse[]>(`${API_BASE_URL}/vehicles`),
      topology: this.http.get<TopologyResponse>(`${API_BASE_URL}/topology`),
      blocks: this.http.get<BlockResponse[]>(`${API_BASE_URL}/blocks`),
      services: this.http.get<ServiceResponse[]>(`${API_BASE_URL}/services`),
    }).subscribe({
      next: ({ vehicles, topology, blocks, services }) => {
        this.vehicles.set(vehicles);
        this.topology.set(topology);
        this.services.set(services);
        this.applyBlocks(blocks);
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
    this.http.get<ServiceResponse[]>(`${API_BASE_URL}/services`).subscribe({
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

  setBlockDraft(blockId: string, value: string | number): void {
    this.blockDrafts.update((drafts) => ({
      ...drafts,
      [blockId]: String(value),
    }));
  }

  saveBlock(block: BlockResponse): void {
    const draft = this.blockDrafts()[block.id] ?? '';
    const traversalSeconds = Number(draft);

    if (!Number.isInteger(traversalSeconds) || traversalSeconds < 0) {
      this.showErrorMessage('Block traversal time must be a non-negative integer.');
      return;
    }

    const request: BlockRequest = { traversalSeconds };
    this.savingBlockId.set(block.id);
    this.http.put<BlockResponse>(`${API_BASE_URL}/blocks/${encodeURIComponent(block.id)}`, request).subscribe({
      next: () => {
        this.reloadBlocks('Block traversal time saved.');
      },
      error: (error: unknown) => {
        this.savingBlockId.set(null);
        this.showError(error);
      },
    });
  }

  addPlatformTiming(row: TimingFormRow = { pathIndex: null, arrivalTime: '', departureTime: '' }): void {
    this.serviceForm.platformTimings = [...this.serviceForm.platformTimings, row];
  }

  removePlatformTiming(index: number): void {
    this.serviceForm.platformTimings = this.serviceForm.platformTimings.filter((_, rowIndex) => rowIndex !== index);
  }

  fillPlatformRowsFromPath(): void {
    const platformIds = new Set(
      this.topology()
        .elements.filter((element) => element.elementType === 'PLATFORM')
        .map((element) => element.id),
    );
    const existingByIndex = new Map(
      this.serviceForm.platformTimings
        .filter((timing): timing is TimingFormRow & { pathIndex: number } => timing.pathIndex !== null)
        .map((timing) => [timing.pathIndex, timing]),
    );
    const rows = this.parsePathText()
      .map((elementId, pathIndex) => ({ elementId, pathIndex }))
      .filter(({ elementId }) => platformIds.has(elementId))
      .map(({ pathIndex }) => existingByIndex.get(pathIndex) ?? { pathIndex, arrivalTime: '', departureTime: '' });

    this.serviceForm.platformTimings = rows;
  }

  submitService(): void {
    const request = this.buildServiceRequest();
    if (request === null) {
      return;
    }

    this.savingService.set(true);
    const editingId = this.editingServiceId();
    const operation =
      editingId === null
        ? this.http.post<ServiceResponse>(`${API_BASE_URL}/services`, request)
        : this.http.put<ServiceResponse>(`${API_BASE_URL}/services/${editingId}`, request);

    operation.subscribe({
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
    this.editingServiceId.set(service.id);
    this.serviceForm = {
      vehicleId: service.vehicleId,
      startTime: this.toDatetimeLocal(service.startTime),
      pathText: service.path.join(', '),
      platformTimings: service.platformTimings.map((timing) => ({
        pathIndex: timing.pathIndex,
        arrivalTime: this.toDatetimeLocal(timing.arrivalTime),
        departureTime: this.toDatetimeLocal(timing.departureTime),
      })),
    };
    this.showSuccess(`Editing service #${service.id}.`);
  }

  cancelEdit(): void {
    this.editingServiceId.set(null);
    this.resetForm();
  }

  resetForm(): void {
    const vehicleId = this.vehicles()[0]?.id ?? '';
    this.serviceForm = this.createEmptyForm(vehicleId);
  }

  confirmDelete(service: ServiceResponse): void {
    const confirmed = window.confirm(`Delete service #${service.id}?`);
    if (!confirmed) {
      return;
    }

    this.http.delete<void>(`${API_BASE_URL}/services/${service.id}`).subscribe({
      next: () => {
        this.expandedServiceIds.update((ids) => {
          const next = new Set(ids);
          next.delete(service.id);
          return next;
        });
        this.loadAfterServiceWrite(`Service #${service.id} deleted.`);
      },
      error: (error: unknown) => {
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

  formatForDisplay(value: string): string {
    return value.replace('T', ' ').replace('+08:00', '');
  }

  trackTimingRow(index: number): number {
    return index;
  }

  private createEmptyForm(vehicleId = ''): ServiceForm {
    return {
      vehicleId,
      startTime: '',
      pathText: '',
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

    const platformTimings: PlatformTiming[] = [];
    for (const row of this.serviceForm.platformTimings) {
      if (row.pathIndex === null || !Number.isInteger(Number(row.pathIndex)) || Number(row.pathIndex) < 0) {
        this.showErrorMessage('Every platform timing row needs a non-negative integer path index.');
        return null;
      }

      if (!row.arrivalTime || !row.departureTime) {
        this.showErrorMessage('Every platform timing row needs arrival and departure times.');
        return null;
      }

      platformTimings.push({
        pathIndex: Number(row.pathIndex),
        arrivalTime: this.fromDatetimeLocal(row.arrivalTime),
        departureTime: this.fromDatetimeLocal(row.departureTime),
      });
    }

    return {
      vehicleId: this.serviceForm.vehicleId,
      startTime: this.fromDatetimeLocal(this.serviceForm.startTime),
      path,
      platformTimings,
    };
  }

  private parsePathText(): string[] {
    return this.serviceForm.pathText
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  private toDatetimeLocal(value: string): string {
    const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/);
    if (match === null) {
      return value;
    }

    return match[1].length === 16 ? `${match[1]}:00` : match[1];
  }

  private fromDatetimeLocal(value: string): string {
    return value.length === 16 ? `${value}:00` : value;
  }

  private reloadBlocks(successMessage: string): void {
    this.http.get<BlockResponse[]>(`${API_BASE_URL}/blocks`).subscribe({
      next: (blocks) => {
        this.applyBlocks(blocks);
        this.savingBlockId.set(null);
        this.showSuccess(successMessage);
      },
      error: (error: unknown) => {
        this.savingBlockId.set(null);
        this.showError(error);
      },
    });
  }

  private loadAfterServiceWrite(successMessage: string): void {
    forkJoin({
      services: this.http.get<ServiceResponse[]>(`${API_BASE_URL}/services`),
      blocks: this.http.get<BlockResponse[]>(`${API_BASE_URL}/blocks`),
      topology: this.http.get<TopologyResponse>(`${API_BASE_URL}/topology`),
    }).subscribe({
      next: ({ services, blocks, topology }) => {
        this.services.set(services);
        this.topology.set(topology);
        this.applyBlocks(blocks);
        this.savingService.set(false);
        this.editingServiceId.set(null);
        this.resetForm();
        this.showSuccess(successMessage);
      },
      error: (error: unknown) => {
        this.savingService.set(false);
        this.showError(error);
      },
    });
  }

  private applyBlocks(blocks: BlockResponse[]): void {
    this.blocks.set(blocks);
    this.blockDrafts.set(
      Object.fromEntries(blocks.map((block) => [block.id, block.traversalSeconds === null ? '' : String(block.traversalSeconds)])),
    );
  }

  private clearNotice(): void {
    this.notice.set('');
  }

  private showSuccess(message: string): void {
    this.noticeKind.set('success');
    this.notice.set(message);
  }

  private showError(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      this.showErrorMessage(this.formatHttpError(error));
      return;
    }

    this.showErrorMessage('Unexpected frontend error.');
  }

  private showErrorMessage(message: string): void {
    this.noticeKind.set('error');
    this.notice.set(message);
  }

  private formatHttpError(error: HttpErrorResponse): string {
    if (error.status === 0) {
      return 'Connection error. Confirm the FastAPI backend is running at http://localhost:8000.';
    }

    const detail = error.error?.detail;
    const detailText = this.formatErrorDetail(detail);

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

  private formatErrorDetail(detail: unknown): string {
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (this.isRecord(item)) {
            const location = Array.isArray(item['loc']) ? item['loc'].join('.') : 'request';
            const message = typeof item['msg'] === 'string' ? item['msg'] : 'Invalid value';
            return `${location}: ${message}`;
          }

          return String(item);
        })
        .join('; ');
    }

    if (this.isRecord(detail)) {
      const code = typeof detail['code'] === 'string' ? detail['code'] : 'Error';
      const message = typeof detail['message'] === 'string' ? detail['message'] : JSON.stringify(detail);
      return `${code}: ${message}`;
    }

    if (typeof detail === 'string') {
      return detail;
    }

    return 'No additional detail returned.';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
