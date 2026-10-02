import { Component, computed, input } from '@angular/core';

import { ServiceResponse, TopologyResponse } from './models';
import { formatForDisplay, formatTimelineTime } from './page-helpers';
import { pathStripSegments } from './schedule-overview';

// A service path drawn like a line diagram along the service's own duration:
// the platforms and the yard are boxes, and the blocks between them are a
// line carrying their names. Each part is as wide as the time spent on it, so
// the sequence doubles as a time axis.
@Component({
  selector: 'app-service-path-strip',
  standalone: true,
  template: `
    <div class="strip" role="img" [attr.aria-label]="'Path of service #' + service().id + ': ' + service().path.join(' -> ')">
      @for (segment of segments(); track segment.pathIndex) {
        <span
          [class.block]="blockIds().has(segment.elementId)"
          [class.stop]="!blockIds().has(segment.elementId)"
          [style.flex-grow]="segment.seconds"
          [attr.title]="segment.elementId + ': ' + formatForDisplay(segment.startTime) + ' to ' + formatTimelineTime(segment.endTime, segment.startTime)"
          >
          <b>{{ segment.elementId }}</b>
          @if (blockIds().has(segment.elementId)) {
            <i></i>
          } @else {
            <div class="stop-times">
              <time [attr.datetime]="segment.startTime">{{ formatTimelineTime(segment.startTime, previousStopTime($index)) }}</time>
              @if (segment.startTime !== segment.endTime) {
                &#xff5e;<time [attr.datetime]="segment.endTime">{{ formatTimelineTime(segment.endTime, segment.startTime) }}</time>
              }
            </div>
          }
        </span>
      }
    </div>
  `,
  styles: [`
    /* The strip's content must not widen the page: its width comes from the
       panel it sits in, and the long path scrolls inside it. */
    :host { display: block; contain: inline-size; }
    /* A long path scrolls sideways rather than squeezing labels out of shape. */
    .strip { display: flex; align-items: flex-start; margin-top: 8px; overflow-x: auto; padding-bottom: 4px; }
    /* Width follows the time on the element, but never less than its label. */
    span { display: flex; flex: 0 1 0; flex-direction: column; min-width: max-content; }
    b { color: #141413; font-size: 11px; font-weight: 700; text-align: center; white-space: nowrap; }
    .stop b {
      height: 22px;
      padding: 0 6px;
      border: 1px solid #dedbd2;
      border-radius: 4px;
      background: #f0eee6;
      line-height: 20px;
    }
    .block b { padding: 0 5px; line-height: 14px; }
    .stop-times { padding: 3px 6px 0; color: #57564f; font-family: monospace; font-size: 11px; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
    .stop b { margin-top: 14px; }
    /* The rail runs through the middle of the stop boxes it joins. */
    .block i {
      position: relative;
      height: 22px;
      background: linear-gradient(#141413, #141413) center / 100% 2px no-repeat;
    }
    /* A tick where one block hands over to the next. */
    .block + .block i::before {
      position: absolute;
      top: 7px;
      left: -1px;
      width: 2px;
      height: 8px;
      background: #141413;
      content: '';
    }
  `],
})
export class ServicePathStripComponent {
  readonly service = input.required<ServiceResponse>();
  readonly topology = input.required<TopologyResponse>();

  readonly formatForDisplay = formatForDisplay;
  readonly formatTimelineTime = formatTimelineTime;
  readonly segments = computed(() => pathStripSegments(this.service()));
  readonly blockIds = computed(() => new Set(
    this.topology().elements
      .filter((element) => element.elementType === 'BLOCK')
      .map((element) => element.id),
  ));

  previousStopTime(index: number): string {
    const previousStop = this.segments().slice(0, index)
      .filter((segment) => !this.blockIds().has(segment.elementId)).at(-1);
    return previousStop?.endTime ?? this.service().startTime;
  }
}
