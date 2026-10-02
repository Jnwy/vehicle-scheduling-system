import { CHARGE_SECONDS_PER_UNIT } from './battery-preview';
import type { ScheduleAnalysis, ServiceResponse, TimelineInterval } from './models';
import { scheduleRange } from './playback';

export interface OverviewBar {
  label: string;
  title: string;
  leftPercent: number;
  widthPercent: number;
}

export interface VehicleOverview {
  vehicleId: string;
  services: ServiceResponse[];
  serviceBars: OverviewBar[];
  conflictBars: OverviewBar[];
  // When the vehicle waits in the yard with its battery still rising.
  chargingBars: OverviewBar[];
}

export function serviceEndTime(service: ServiceResponse): string {
  return service.timeline.at(-1)?.endTime ?? service.startTime;
}

export interface PathStripSegment extends TimelineInterval {
  seconds: number;
}

// The service timeline with the time spent on each path element.
export function pathStripSegments(service: ServiceResponse): PathStripSegment[] {
  return service.timeline.map((interval) => ({
    ...interval,
    seconds: (Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 1000,
  }));
}

export interface ServicePosition {
  leftPercent: number;
  widthPercent: number;
}

// Where each service sits on one time axis running from the earliest start to
// the latest end of all the services, keyed by service ID.
export function servicePositions(services: ServiceResponse[]): Map<number, ServicePosition> {
  const spans = services.map((service) => ({
    id: service.id,
    start: Date.parse(service.startTime),
    end: Date.parse(serviceEndTime(service)),
  }));
  const axisStart = Math.min(...spans.map((span) => span.start));
  const axisLength = Math.max(...spans.map((span) => span.end)) - axisStart;

  return new Map(spans.map(({ id, start, end }) => [
    id,
    // Without any duration to compare, the only instant fills the axis.
    axisLength > 0
      ? { leftPercent: ((start - axisStart) / axisLength) * 100, widthPercent: ((end - start) / axisLength) * 100 }
      : { leftPercent: 0, widthPercent: 100 },
  ]));
}

// Groups the schedule by vehicle in time order and places each service and
// conflict on a shared time axis spanning the whole schedule.
export function buildVehicleOverviews(
  services: ServiceResponse[],
  analysis: ScheduleAnalysis,
): VehicleOverview[] {
  const range = scheduleRange(analysis);
  const span = range === null ? 0 : range.end - range.start;
  const bar = (label: string, title: string, start: string, end: string): OverviewBar[] => {
    if (range === null || span <= 0) {
      return [];
    }
    const from = Math.max(range.start, Date.parse(start));
    const to = Math.min(range.end, Date.parse(end));
    return [{
      label,
      title,
      leftPercent: ((from - range.start) / span) * 100,
      widthPercent: (Math.max(0, to - from) / span) * 100,
    }];
  };

  const vehicleIds = [...new Set([
    ...analysis.vehicles.map((vehicle) => vehicle.vehicleId),
    ...services.map((service) => service.vehicleId),
  ])].sort();

  return vehicleIds.map((vehicleId) => {
    const ordered = services
      .filter((service) => service.vehicleId === vehicleId)
      .sort((first, second) =>
        Date.parse(first.startTime) - Date.parse(second.startTime) || first.id - second.id);
    return {
      vehicleId,
      services: ordered,
      serviceBars: ordered.flatMap((service) => bar(
        `#${service.id}`,
        `Service #${service.id}: ${service.path[0]} -> ${service.path.at(-1)}`,
        service.startTime,
        serviceEndTime(service),
      )),
      conflictBars: analysis.conflicts
        .filter((conflict) => conflict.vehicleIds.includes(vehicleId))
        .flatMap((conflict) => bar('', conflict.message, conflict.startTime, conflict.endTime)),
      chargingBars: (analysis.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId)?.segments ?? [])
        .filter((segment) => segment.segmentType === 'IDLE' && segment.batteryEnd > segment.batteryStart)
        .flatMap((segment) => {
          // A wait longer than the charge needs ends the bar when the battery is full.
          const charged = Date.parse(segment.startTime)
            + (segment.batteryEnd - segment.batteryStart) * CHARGE_SECONDS_PER_UNIT * 1000;
          const end = new Date(Math.min(Date.parse(segment.endTime), charged)).toISOString();
          return bar(
            '',
            `Charging in the yard: ${Math.floor(segment.batteryStart)} to ${Math.floor(segment.batteryEnd)} battery units`,
            segment.startTime,
            end,
          );
        }),
    };
  });
}
