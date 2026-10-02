import { Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import { ScheduleAnalysis, ServiceResponse, TopologyResponse, ScheduleConflict } from './models';
import { errorMessage, formatClockTime, formatDuration, formatForDisplay, formatServiceDate, formatTimelineTime } from './page-helpers';
import { conflictsAt, playbackSliderPosition, scheduleRange, vehicleStatesAt } from './playback';
import { buildVehicleOverviews, serviceEndTime, servicePositions } from './schedule-overview';
import { ServicePathStripComponent } from './service-path-strip.component';
import { taipeiLocal } from './service-timing';
import { TrackMapComponent } from './track-map.component';
import { VehicleIconComponent } from './vehicle-icon.component';

@Component({
  selector: 'app-schedule-viewer',
  imports: [FormsModule, ServicePathStripComponent, TrackMapComponent, VehicleIconComponent],
  templateUrl: './schedule-viewer.component.html',
  styleUrl: './scheduling-page.css',
})
export class ScheduleViewerComponent implements OnInit, OnDestroy {
  private readonly api = inject(SchedulingApi);
  private readonly destroyRef = inject(DestroyRef);
  readonly loadingInitial = signal(false);
  readonly notice = signal('');
  readonly noticeKind = signal<'success' | 'error' | 'warning'>('success');
  private animationFrameId: number | null = null;
  private previousFrameTime: number | null = null;
  readonly topology = signal<TopologyResponse>({ elements: [], connections: [] });
  readonly services = signal<ServiceResponse[]>([]);
  readonly analysis = signal<ScheduleAnalysis>({ startTime: null, endTime: null, vehicles: [], conflicts: [] });
  readonly expandedServiceIds = signal<Set<number>>(new Set<number>());
  readonly collapsedVehicleIds = signal<Set<string>>(new Set<string>());
  readonly playbackTimeMs = signal<number | null>(null);
  readonly playbackSpeed = signal(60);
  readonly isPlaying = signal(false);
  readonly formatForDisplay = formatForDisplay;
  readonly formatServiceDate = formatServiceDate;
  readonly formatClockTime = formatClockTime;
  readonly formatTimelineTime = formatTimelineTime;
  readonly formatDuration = formatDuration;
  readonly serviceEndTime = serviceEndTime;
  readonly servicePositions = computed(() => servicePositions(this.services()));
  readonly vehicleOverviews = computed(() => buildVehicleOverviews(this.services(), this.analysis()));
  readonly currentVehicleStates = computed(() =>
    vehicleStatesAt(this.analysis(), this.topology(), this.playbackTimeMs()),
  );
  readonly activeConflicts = computed(() =>
    conflictsAt(this.analysis(), this.playbackTimeMs()),
  );
  readonly activeConflictElementIds = computed(() => [
    ...new Set(this.activeConflicts().flatMap((conflict) => conflict.elementIds)),
  ]);
  readonly playbackPosition = computed(() => {
    return playbackSliderPosition(scheduleRange(this.analysis()), this.playbackTimeMs());
  });
  // The label above the cursor: the clock time, with the date once playback leaves the first day.
  readonly playbackAxisTime = computed(() => {
    const instant = this.playbackTimeMs();
    const start = this.analysis().startTime;
    return instant === null || start === null ? '' : formatTimelineTime(taipeiLocal(instant), start);
  });
  readonly playbackClock = computed(() => {
    const instant = this.playbackTimeMs();
    return instant === null ? 'No schedule loaded' : new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(instant));
  });

  ngOnInit(): void {
    this.refreshAll();
  }

  ngOnDestroy(): void {
    this.stopPlayback();
  }

  refreshAll(): void {
    this.stopPlayback();
    this.loadingInitial.set(true);
    this.clearNotice();
    forkJoin({
      topology: this.api.getTopology(),
      services: this.api.getServices(),
      analysis: this.api.getAnalysis(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ topology, services, analysis }) => {
        this.topology.set(topology);
        this.services.set(services);
        this.applyAnalysis(analysis);
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  togglePlayback(): void {
    if (this.isPlaying()) {
      this.stopPlayback();
      return;
    }
    const range = scheduleRange(this.analysis());
    if (range === null) {
      return;
    }
    if (this.playbackTimeMs() === null || this.playbackTimeMs()! >= range.end) {
      this.playbackTimeMs.set(range.start);
    }
    this.isPlaying.set(true);
    this.previousFrameTime = null;
    this.animationFrameId = requestAnimationFrame((time) => this.advancePlayback(time));
  }

  resetPlayback(): void {
    this.stopPlayback();
    this.playbackTimeMs.set(scheduleRange(this.analysis())?.start ?? null);
  }

  seekFromAxis(event: MouseEvent): void {
    const axis = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.seekPlayback(((event.clientX - axis.left) / axis.width) * 1000);
  }

  seekPlayback(value: number | string): void {
    const range = scheduleRange(this.analysis());
    if (range === null) {
      return;
    }
    const position = Math.max(0, Math.min(1000, Number(value)));
    this.playbackTimeMs.set(range.start + ((range.end - range.start) * position) / 1000);
  }

  setPlaybackSpeed(value: number | string): void {
    this.playbackSpeed.set(Number(value));
  }

  conflictLabel(conflict: ScheduleConflict): string {
    const vehicles = conflict.vehicleIds.join(', ');
    return `${conflict.conflictType.replaceAll('_', ' ')}: ${vehicles}`;
  }

  toggleVehicle(vehicleId: string): void {
    this.collapsedVehicleIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(vehicleId)) {
        next.add(vehicleId);
      }
      return next;
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

  private applyAnalysis(analysis: ScheduleAnalysis): void {
    this.analysis.set(analysis);
    const range = scheduleRange(analysis);
    const current = this.playbackTimeMs();
    if (range === null) {
      this.stopPlayback();
      this.playbackTimeMs.set(null);
    } else if (current === null || current < range.start || current > range.end) {
      this.playbackTimeMs.set(range.start);
    }
  }

  private advancePlayback(frameTime: number): void {
    if (!this.isPlaying()) {
      return;
    }
    const range = scheduleRange(this.analysis());
    if (range === null) {
      this.stopPlayback();
      return;
    }
    if (this.previousFrameTime === null) {
      this.previousFrameTime = frameTime;
    }
    const elapsed = frameTime - this.previousFrameTime;
    this.previousFrameTime = frameTime;
    const next = Math.min(range.end, (this.playbackTimeMs() ?? range.start) + elapsed * this.playbackSpeed());
    this.playbackTimeMs.set(next);
    if (next >= range.end) {
      this.stopPlayback();
      return;
    }
    this.animationFrameId = requestAnimationFrame((time) => this.advancePlayback(time));
  }

  private stopPlayback(): void {
    this.isPlaying.set(false);
    this.previousFrameTime = null;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private clearNotice(): void {
    this.notice.set('');
  }

  private showErrorMessage(message: string): void {
    this.noticeKind.set('error');
    this.notice.set(message);
  }

  private showError(error: unknown): void {
    this.showErrorMessage(errorMessage(error));
  }
}
