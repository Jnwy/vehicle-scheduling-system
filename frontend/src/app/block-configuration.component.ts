import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { EMPTY, Subject, catchError, switchMap } from 'rxjs';

import { PendingBlockTimes, blockChanges, describeBlockChanges, parseTraversalSeconds, stageBlockTime } from './block-changes';
import { SchedulingApi } from './scheduling-api.service';
import { StaleService, TopologyResponse } from './models';
import { errorMessage, formatForDisplay } from './page-helpers';
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
  private readonly previewRequests = new Subject<PendingBlockTimes>();
  readonly loadingInitial = signal(false);
  readonly saving = signal(false);
  readonly notice = signal('');
  readonly noticeKind = signal<'success' | 'error' | 'warning'>('success');
  readonly topology = signal<TopologyResponse>({ elements: [], connections: [] });
  // Block times as last saved; the map shows the unsaved values on top of them.
  readonly savedSeconds = signal<Record<string, number | null>>({});
  readonly pending = signal<PendingBlockTimes>({});
  // What the backend reports for the saved block times plus the unsaved ones.
  readonly staleServices = signal<StaleService[]>([]);
  readonly pendingDescriptions = computed(() => describeBlockChanges(this.pending(), this.savedSeconds()));
  readonly hasPending = computed(() => this.pendingDescriptions().length > 0);
  readonly conflictCount = computed(() => this.staleServices().filter((service) => service.conflict).length);
  readonly formatForDisplay = formatForDisplay;

  ngOnInit(): void {
    // Only the answer to the latest set of changes is shown.
    this.previewRequests.pipe(
      // A failed preview is reported without ending the stream of later ones.
      switchMap((pending) => this.api.previewBlocks(blockChanges(pending)).pipe(
        catchError((error: unknown) => {
          this.showError(error);
          return EMPTY;
        }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((preview) => this.staleServices.set(preview.services));
    this.refreshAll();
  }

  refreshAll(): void {
    this.loadingInitial.set(true);
    this.clearNotice();
    this.api.getTopology().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (topology) => {
        this.topology.set(topology);
        this.savedSeconds.set(Object.fromEntries(
          topology.elements
            .filter((element) => element.elementType === 'BLOCK')
            .map((element) => [element.id, element.traversalSeconds]),
        ));
        this.pending.set({});
        this.previewRequests.next({});
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  // Edits are kept on the page until Save, so their effect can be seen first.
  stageBlock(change: BlockTraversalChange): void {
    const seconds = parseTraversalSeconds(change.value);
    if (typeof seconds === 'string') {
      this.showErrorMessage(seconds);
      this.redrawMap();
      return;
    }
    this.clearNotice();
    this.showOnMap(change.blockId, seconds);
    this.pending.set(stageBlockTime(this.pending(), this.savedSeconds(), change.blockId, seconds));
    this.previewRequests.next(this.pending());
  }

  saveChanges(): void {
    const changes = blockChanges(this.pending());
    if (changes.length === 0 || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.api.saveBlocks(changes).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blocks) => {
        this.saving.set(false);
        this.savedSeconds.update((saved) => ({
          ...saved, ...Object.fromEntries(blocks.map((block) => [block.id, block.traversalSeconds])),
        }));
        this.pending.set({});
        this.previewRequests.next({});
        this.showSuccess(`Saved ${blocks.length} block traversal ${blocks.length === 1 ? 'time' : 'times'}.`);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.showError(error);
      },
    });
  }

  discardChanges(): void {
    for (const blockId of Object.keys(this.pending())) {
      this.showOnMap(blockId, this.savedSeconds()[blockId]);
    }
    this.pending.set({});
    this.clearNotice();
    this.redrawMap();
    this.previewRequests.next({});
  }

  // Updated in place on purpose: replacing the topology would redraw the map
  // and discard whatever the user is already typing in another block.
  private showOnMap(blockId: string, seconds: number | null): void {
    const element = this.topology().elements.find((candidate) => candidate.id === blockId);
    if (element) {
      element.traversalSeconds = seconds;
    }
  }

  // Resets every field to the value held for it after a rejected or discarded edit.
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
