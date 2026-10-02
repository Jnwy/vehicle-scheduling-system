
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import { BlockRequest, ServiceResponse, TopologyResponse } from './models';
import { errorMessage, formatForDisplay } from './page-helpers';
import { staleServices } from './service-timing';
import { BlockTraversalChange, TrackMapComponent } from './track-map.component';

@Component({
  selector: 'app-block-configuration',
  imports: [RouterLink, TrackMapComponent],
  templateUrl: './block-configuration.component.html',
  styleUrl: './scheduling-page.css',
})
export class BlockConfigurationComponent implements OnInit {
  private readonly api = inject(SchedulingApi);
  private readonly destroyRef = inject(DestroyRef);
  readonly loadingInitial = signal(false);
  readonly notice = signal('');
  readonly noticeKind = signal<'success' | 'error' | 'warning'>('success');
  readonly topology = signal<TopologyResponse>({ elements: [], connections: [] });
  readonly services = signal<ServiceResponse[]>([]);
  // Bumped on every saved block, because the topology is updated in place.
  private readonly blockRevision = signal(0);
  // Saved services keep their snapshot, so a block change leaves these behind.
  readonly staleServices = computed(() => {
    this.blockRevision();
    return staleServices(this.services(), this.topology().elements);
  });
  readonly formatForDisplay = formatForDisplay;

  ngOnInit(): void {
    this.refreshAll();
  }

  refreshAll(): void {
    this.loadingInitial.set(true);
    this.clearNotice();
    forkJoin({
      topology: this.api.getTopology(),
      services: this.api.getServices(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ topology, services }) => {
        this.topology.set(topology);
        this.services.set(services);
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  saveBlock(change: BlockTraversalChange): void {
    const traversalSeconds = Number(change.value);

    if (change.value.trim() === '' || !Number.isInteger(traversalSeconds) || traversalSeconds < 0) {
      this.showErrorMessage('Block traversal time must be a non-negative integer.');
      this.redrawMap();
      return;
    }

    const request: BlockRequest = { traversalSeconds };
    this.api.saveBlock(change.blockId, request).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (block) => {
        // Updated in place on purpose: replacing the topology would redraw the
        // map and discard whatever the user is already typing in another block.
        const element = this.topology().elements.find((candidate) => candidate.id === block.id);
        if (element) {
          element.traversalSeconds = block.traversalSeconds;
        }
        this.blockRevision.update((revision) => revision + 1);
        this.showSuccess(`${block.id} traversal time saved: ${block.traversalSeconds}s.`);
      },
      error: (error: unknown) => {
        this.showError(error);
        this.redrawMap();
      },
    });
  }

  // Restores the last saved values after a rejected edit.
  private redrawMap(): void {
    this.topology.update((topology) => ({ ...topology }));
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

  private showErrorMessage(message: string): void {
    this.noticeKind.set('error');
    this.notice.set(message);
  }

  private showError(error: unknown): void {
    this.showErrorMessage(errorMessage(error));
  }
}
