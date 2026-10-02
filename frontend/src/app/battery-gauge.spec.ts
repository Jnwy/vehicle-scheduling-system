import { describe, expect, it } from 'vitest';

import { batteryGauge } from './battery-gauge';

describe('batteryGauge', () => {
  it('shows a high battery in the high level', () => {
    expect(batteryGauge(100)).toEqual({ filledSegments: 5, level: 'high' });
    expect(batteryGauge(80)).toEqual({ filledSegments: 4, level: 'high' });
    expect(batteryGauge(60)).toEqual({ filledSegments: 3, level: 'high' });
  });

  it('shows a battery below 60 as low', () => {
    expect(batteryGauge(59.9)).toEqual({ filledSegments: 3, level: 'low' });
    expect(batteryGauge(30)).toEqual({ filledSegments: 2, level: 'low' });
  });

  it('shows a battery below the low battery threshold of 30 as empty', () => {
    expect(batteryGauge(29.9)).toEqual({ filledSegments: 2, level: 'empty' });
    expect(batteryGauge(1)).toEqual({ filledSegments: 1, level: 'empty' });
  });

  it('counts a partly used segment as filled', () => {
    expect(batteryGauge(79.75)).toEqual({ filledSegments: 4, level: 'high' });
    expect(batteryGauge(80.1)).toEqual({ filledSegments: 5, level: 'high' });
  });

  it('shows no segments only when fully drained, and clamps out-of-range values', () => {
    expect(batteryGauge(0)).toEqual({ filledSegments: 0, level: 'empty' });
    expect(batteryGauge(-5)).toEqual({ filledSegments: 0, level: 'empty' });
    expect(batteryGauge(120)).toEqual({ filledSegments: 5, level: 'high' });
  });
});
