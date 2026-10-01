import type { ScheduleAnalysis, ServiceResponse } from './models';
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
}

export function serviceEndTime(service: ServiceResponse): string {
  return service.timeline.at(-1)?.endTime ?? service.startTime;
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
    };
  });
}
