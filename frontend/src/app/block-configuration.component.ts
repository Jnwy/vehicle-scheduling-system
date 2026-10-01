import { CommonModule } from '@angular/common';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';

import { SchedulingApi } from './scheduling-api.service';
import { BlockRequest, BlockResponse, TopologyResponse } from './models';
import { errorMessage } from './page-helpers';

@Component({
  selector: 'app-block-configuration',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  readonly blocks = signal<BlockResponse[]>([]);
  readonly blockDrafts = signal<Record<string, string>>({});
  readonly savingBlockId = signal<string | null>(null);
  readonly isBusy = computed(() => this.loadingInitial() || this.savingBlockId() !== null);
  readonly topologyGroups = computed(() => {
    const elements = this.topology().elements;

    return [
      { label: 'Yards', elements: elements.filter((element) => element.elementType === 'YARD') },
      { label: 'Platforms', elements: elements.filter((element) => element.elementType === 'PLATFORM') },
      { label: 'Blocks', elements: elements.filter((element) => element.elementType === 'BLOCK') },
    ];
  });

  ngOnInit(): void {
    this.refreshAll();
  }

  refreshAll(): void {
    this.loadingInitial.set(true);
    this.clearNotice();
    forkJoin({
      topology: this.api.getTopology(),
      blocks: this.api.getBlocks(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ topology, blocks }) => {
        this.topology.set(topology);
        this.applyBlocks(blocks);
        this.loadingInitial.set(false);
      },
      error: (error: unknown) => {
        this.loadingInitial.set(false);
        this.showError(error);
      },
    });
  }

  private reloadBlocks(successMessage: string): void {
    forkJoin({
      topology: this.api.getTopology(),
      blocks: this.api.getBlocks(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ topology, blocks }) => {
        this.topology.set(topology);
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

  setBlockDraft(blockId: string, value: string | number | null): void {
    this.blockDrafts.update((drafts) => ({
      ...drafts,
      [blockId]: value === null ? '' : String(value),
    }));
  }

  restoreEmptyBlockDraft(block: BlockResponse): void {
    if ((this.blockDrafts()[block.id] ?? '').trim() === '') {
      this.setBlockDraft(block.id, block.traversalSeconds ?? 20);
    }
  }

  saveBlock(block: BlockResponse): void {
    const draft = this.blockDrafts()[block.id] ?? '';
    const traversalSeconds = Number(draft);

    if (draft.trim() === '' || !Number.isInteger(traversalSeconds) || traversalSeconds < 0) {
      this.showErrorMessage('Block traversal time must be a non-negative integer.');
      return;
    }

    const request: BlockRequest = { traversalSeconds };
    this.savingBlockId.set(block.id);
    this.api.saveBlock(block.id, request).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.reloadBlocks('Block traversal time saved.');
      },
      error: (error: unknown) => {
        this.savingBlockId.set(null);
        this.showError(error);
      },
    });
  }

  private applyBlocks(blocks: BlockResponse[]): void {
    this.blocks.set(blocks);
    this.blockDrafts.set(
      Object.fromEntries(blocks.map((block) => [block.id, String(block.traversalSeconds ?? 20)])),
    );
  }

  private clearNotice(): void {
    this.notice.set('');
  }

  private showSuccess(message: string): void {
    this.noticeKind.set('success');
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
