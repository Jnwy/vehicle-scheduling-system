import { Component, computed, input } from '@angular/core';

import { vehicleColor } from './track-map.component';

// The small car that stands for one vehicle, in the colour it has on the map.
@Component({
  selector: 'app-vehicle-icon',
  standalone: true,
  template: `
    <svg viewBox="-20 -13 40 26" [attr.width]="width()" [attr.height]="width() * 0.65" aria-hidden="true">
      <rect x="-11.5" y="-10" width="7" height="4" rx="1.5" fill="#141413" />
      <rect x="4.5" y="-10" width="7" height="4" rx="1.5" fill="#141413" />
      <rect x="-11.5" y="6" width="7" height="4" rx="1.5" fill="#141413" />
      <rect x="4.5" y="6" width="7" height="4" rx="1.5" fill="#141413" />
      <rect x="-15" y="-8" width="30" height="16" rx="4.5" [attr.fill]="color()" stroke="#ffffff" stroke-width="1.5" />
      <rect x="3" y="-5" width="6" height="10" rx="1.5" fill="#eaf2fb" />
      <rect x="-11.5" y="-4" width="3" height="8" rx="1" fill="#eaf2fb" opacity="0.7" />
      <circle cx="12.5" cy="-4.5" r="1.3" fill="#ffd966" />
      <circle cx="12.5" cy="4.5" r="1.3" fill="#ffd966" />
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; flex: none; vertical-align: middle; }
    svg { display: block; }
  `],
})
export class VehicleIconComponent {
  readonly vehicleId = input.required<string>();
  readonly width = input(28);
  readonly color = computed(() => vehicleColor(this.vehicleId()));
}
