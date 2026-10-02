export const BATTERY_SEGMENTS = 5;

// Below this the vehicle is in the low battery conflict range (Bonus 1.2).
const EMPTY_BELOW = 30;
const LOW_BELOW = 60;
const MAX_BATTERY = 100;

export type BatteryLevel = 'high' | 'low' | 'empty';

export interface BatteryGauge {
  filledSegments: number;
  level: BatteryLevel;
}

// The segmented battery icon on a vehicle marker. A partly used segment still
// counts as filled, so only a fully drained battery shows no segments.
export function batteryGauge(battery: number): BatteryGauge {
  const clamped = Math.min(MAX_BATTERY, Math.max(0, battery));
  const level = clamped < EMPTY_BELOW ? 'empty' : clamped < LOW_BELOW ? 'low' : 'high';

  return {
    filledSegments: Math.ceil(clamped / (MAX_BATTERY / BATTERY_SEGMENTS)),
    level,
  };
}
