from dataclasses import dataclass, replace
from datetime import timedelta
from typing import Iterable, Mapping

from app.domain.interlocking import InterlockingConflictError
from app.domain.models import RailwayTopology, TrackElementType
from app.domain.schedule_conflicts import BatteryConflictError, BlockOccupancyConflictError
from app.domain.service_write import validate_service_write
from app.domain.timeline import PlatformTiming, calculate_timeline
from app.domain.vehicle_schedule import ServiceSchedule, ServiceScheduleError, VehicleScheduleError


SCHEDULING_CONFLICTS = (
    VehicleScheduleError, InterlockingConflictError, BlockOccupancyConflictError,
    BatteryConflictError, ServiceScheduleError,
)


@dataclass(frozen=True)
class StaleService:
    """A saved service whose snapshot no longer matches the block times."""
    saved: ServiceSchedule
    # Why updating this service alone would be rejected, or None if it would pass.
    conflict: Exception | None


def with_block_times(
    topology: RailwayTopology, traversal_seconds: Mapping[str, int],
) -> RailwayTopology:
    elements = dict(topology.elements)
    for block_id, seconds in traversal_seconds.items():
        elements[block_id] = replace(elements[block_id], traversal_seconds=seconds)
    return RailwayTopology(elements=elements, connections=topology.connections)


def recalculated_schedule(saved: ServiceSchedule, topology: RailwayTopology) -> ServiceSchedule:
    """The service as an update would save it: same start, path, and platform dwell."""
    timings: list[PlatformTiming] = []
    current = saved.start_time
    for path_index, interval in enumerate(saved.timeline):
        element = topology.elements[interval.element_id]
        if element.element_type is TrackElementType.BLOCK:
            current += timedelta(seconds=element.traversal_seconds or 0)
        elif element.element_type is TrackElementType.PLATFORM:
            departure = current + (interval.end_time - interval.start_time)
            timings.append(PlatformTiming(path_index, current, departure))
            current = departure
    timeline = calculate_timeline(saved.path, saved.start_time, topology, timings)
    return ServiceSchedule(saved.service_id, saved.vehicle_id, saved.path, timeline)


def stale_services(
    services: Iterable[ServiceSchedule], topology: RailwayTopology,
) -> tuple[StaleService, ...]:
    """Saved services that `topology` leaves stale, in the order they run.

    Each one is checked as if it alone were updated while every other service
    keeps its saved snapshot, which is what the user's next update would do.
    """
    saved_services = tuple(services)
    stale: list[StaleService] = []
    for saved in sorted(saved_services, key=lambda item: (item.start_time, item.service_id or 0)):
        conflict: Exception | None = None
        try:
            candidate = recalculated_schedule(saved, topology)
            if candidate.timeline == saved.timeline:
                continue
            validate_service_write(candidate, saved_services, topology, saved)
        except OverflowError:
            conflict = ServiceScheduleError("Calculated timeline exceeds the supported datetime range.")
        except SCHEDULING_CONFLICTS as error:
            conflict = error
        stale.append(StaleService(saved, conflict))
    return tuple(stale)
