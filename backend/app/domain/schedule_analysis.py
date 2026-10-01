from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from itertools import combinations
from typing import Iterable

from app.domain.models import RailwayTopology, TrackElementType
from app.domain.vehicle_schedule import ServiceSchedule


INITIAL_BATTERY = 80.0
MAX_BATTERY = 100.0
BLOCK_BATTERY_COST = 1.0
CHARGE_SECONDS_PER_UNIT = 12.0
LOW_BATTERY_THRESHOLD = 30.0
MINIMUM_DEPARTURE_BATTERY = 80.0


class ConflictType(StrEnum):
    BLOCK_OCCUPANCY = "BLOCK_OCCUPANCY"
    INTERLOCKING = "INTERLOCKING"
    LOW_BATTERY = "LOW_BATTERY"
    INSUFFICIENT_CHARGE = "INSUFFICIENT_CHARGE"


class SegmentType(StrEnum):
    SERVICE = "SERVICE"
    IDLE = "IDLE"


@dataclass(frozen=True)
class SimulationSegment:
    segment_type: SegmentType
    vehicle_id: str
    service_id: int | None
    path_index: int | None
    element_id: str
    start_time: datetime
    end_time: datetime
    battery_start: float
    battery_end: float


@dataclass(frozen=True)
class VehicleSimulation:
    vehicle_id: str
    segments: tuple[SimulationSegment, ...]


@dataclass(frozen=True)
class ScheduleConflict:
    conflict_type: ConflictType
    resource_id: str | None
    start_time: datetime
    end_time: datetime
    vehicle_ids: tuple[str, ...]
    service_ids: tuple[int, ...]
    element_ids: tuple[str, ...]
    message: str


@dataclass(frozen=True)
class ScheduleAnalysis:
    start_time: datetime | None
    end_time: datetime | None
    vehicles: tuple[VehicleSimulation, ...]
    conflicts: tuple[ScheduleConflict, ...]


def analyze_schedule(
    services: Iterable[ServiceSchedule],
    topology: RailwayTopology,
    vehicle_ids: Iterable[str] = (),
) -> ScheduleAnalysis:
    schedules = tuple(services)
    known_vehicle_ids = sorted({*vehicle_ids, *(service.vehicle_id for service in schedules)})
    vehicles = tuple(
        _analyze_vehicle(
            vehicle_id,
            tuple(service for service in schedules if service.vehicle_id == vehicle_id),
            topology,
        )
        for vehicle_id in known_vehicle_ids
    )
    segments = tuple(segment for vehicle in vehicles for segment in vehicle.segments)
    conflicts = (
        *_resource_conflicts(schedules, topology),
        *_battery_conflicts(segments),
    )
    non_empty_segments = tuple(segment for segment in segments if segment.start_time != segment.end_time)
    return ScheduleAnalysis(
        start_time=min((segment.start_time for segment in non_empty_segments), default=None),
        end_time=max((segment.end_time for segment in non_empty_segments), default=None),
        vehicles=vehicles,
        conflicts=tuple(sorted(conflicts, key=_conflict_sort_key)),
    )


def _analyze_vehicle(
    vehicle_id: str,
    services: tuple[ServiceSchedule, ...],
    topology: RailwayTopology,
) -> VehicleSimulation:
    ordered = sorted(
        enumerate(services),
        key=lambda item: (item[1].start_time, item[0]),
    )
    battery = INITIAL_BATTERY
    segments: list[SimulationSegment] = []
    previous: ServiceSchedule | None = None

    for _, service in ordered:
        if previous is not None and previous.end_time < service.start_time:
            idle_end_battery = battery
            if previous.end_location == "Y":
                idle_seconds = (service.start_time - previous.end_time).total_seconds()
                idle_end_battery = min(MAX_BATTERY, battery + idle_seconds / CHARGE_SECONDS_PER_UNIT)
            segments.append(
                SimulationSegment(
                    SegmentType.IDLE,
                    vehicle_id,
                    None,
                    None,
                    previous.end_location,
                    previous.end_time,
                    service.start_time,
                    battery,
                    idle_end_battery,
                )
            )
            battery = idle_end_battery

        for path_index, interval in enumerate(service.timeline):
            element = topology.elements[interval.element_id]
            next_battery = battery
            if element.element_type is TrackElementType.BLOCK:
                next_battery = battery - BLOCK_BATTERY_COST
            segments.append(
                SimulationSegment(
                    SegmentType.SERVICE,
                    vehicle_id,
                    service.service_id,
                    path_index,
                    interval.element_id,
                    interval.start_time,
                    interval.end_time,
                    battery,
                    next_battery,
                )
            )
            battery = next_battery
        previous = service

    return VehicleSimulation(vehicle_id, tuple(segments))


def _resource_conflicts(
    services: tuple[ServiceSchedule, ...],
    topology: RailwayTopology,
) -> tuple[ScheduleConflict, ...]:
    block_segments = [
        (service, path_index, interval)
        for service in services
        for path_index, interval in enumerate(service.timeline)
        if topology.elements[interval.element_id].element_type is TrackElementType.BLOCK
        and interval.start_time != interval.end_time
    ]
    conflicts: list[ScheduleConflict] = []
    for (first_service, _, first), (second_service, _, second) in combinations(block_segments, 2):
        if first_service.vehicle_id == second_service.vehicle_id:
            continue
        overlap = _overlap(first.start_time, first.end_time, second.start_time, second.end_time)
        if overlap is None:
            continue
        service_ids = _service_ids(first_service, second_service)
        vehicle_ids = tuple(sorted((first_service.vehicle_id, second_service.vehicle_id)))
        if first.element_id == second.element_id:
            conflicts.append(
                ScheduleConflict(
                    ConflictType.BLOCK_OCCUPANCY,
                    first.element_id,
                    *overlap,
                    vehicle_ids,
                    service_ids,
                    (first.element_id,),
                    f"Block {first.element_id} is occupied by multiple vehicles.",
                )
            )
            continue
        first_group = topology.elements[first.element_id].interlocking_group
        second_group = topology.elements[second.element_id].interlocking_group
        if first_group is not None and first_group == second_group:
            conflicts.append(
                ScheduleConflict(
                    ConflictType.INTERLOCKING,
                    first_group,
                    *overlap,
                    vehicle_ids,
                    service_ids,
                    tuple(sorted((first.element_id, second.element_id))),
                    f"Interlocking group {first_group} is occupied by multiple vehicles.",
                )
            )
    return tuple(conflicts)


def _battery_conflicts(segments: tuple[SimulationSegment, ...]) -> tuple[ScheduleConflict, ...]:
    conflicts: list[ScheduleConflict] = []
    by_vehicle: dict[str, list[SimulationSegment]] = {}
    for segment in segments:
        by_vehicle.setdefault(segment.vehicle_id, []).append(segment)

    for vehicle_id, vehicle_segments in by_vehicle.items():
        for index, segment in enumerate(vehicle_segments):
            if (
                segment.segment_type is SegmentType.SERVICE
                and segment.element_id != "Y"
                and index > 0
                and vehicle_segments[index - 1].element_id == "Y"
                and segment.battery_start < MINIMUM_DEPARTURE_BATTERY
            ):
                conflicts.append(
                    ScheduleConflict(
                        ConflictType.INSUFFICIENT_CHARGE,
                        "Y",
                        segment.start_time,
                        segment.end_time,
                        (vehicle_id,),
                        _non_null_ids((segment.service_id,)),
                        ("Y", segment.element_id),
                        f"Vehicle {vehicle_id} left the yard below 80 battery units.",
                    )
                )

        low_ranges = [_low_battery_range(segment) for segment in vehicle_segments]
        active = [item for item in low_ranges if item is not None]
        if not active:
            continue
        start, end, service_ids, element_ids = active[0]
        for next_start, next_end, next_services, next_elements in active[1:]:
            if next_start <= end:
                end = max(end, next_end)
                service_ids.update(next_services)
                element_ids.update(next_elements)
                continue
            conflicts.append(_low_battery_conflict(vehicle_id, start, end, service_ids, element_ids))
            start, end, service_ids, element_ids = next_start, next_end, next_services, next_elements
        conflicts.append(_low_battery_conflict(vehicle_id, start, end, service_ids, element_ids))
    return tuple(conflicts)


def _low_battery_range(
    segment: SimulationSegment,
) -> tuple[datetime, datetime, set[int], set[str]] | None:
    if segment.element_id == "Y" or min(segment.battery_start, segment.battery_end) >= LOW_BATTERY_THRESHOLD:
        return None
    start_time = segment.start_time
    if (
        segment.battery_start >= LOW_BATTERY_THRESHOLD
        and segment.battery_end < LOW_BATTERY_THRESHOLD
        and segment.start_time != segment.end_time
    ):
        battery_drop = segment.battery_start - segment.battery_end
        fraction = (segment.battery_start - LOW_BATTERY_THRESHOLD) / battery_drop
        start_time += (segment.end_time - segment.start_time) * fraction
    return (
        start_time,
        segment.end_time,
        set(_non_null_ids((segment.service_id,))),
        {segment.element_id},
    )


def _low_battery_conflict(
    vehicle_id: str,
    start_time: datetime,
    end_time: datetime,
    service_ids: set[int],
    element_ids: set[str],
) -> ScheduleConflict:
    return ScheduleConflict(
        ConflictType.LOW_BATTERY,
        vehicle_id,
        start_time,
        end_time,
        (vehicle_id,),
        tuple(sorted(service_ids)),
        tuple(sorted(element_ids)),
        f"Vehicle {vehicle_id} is below 30 battery units outside the yard.",
    )


def _overlap(
    first_start: datetime,
    first_end: datetime,
    second_start: datetime,
    second_end: datetime,
) -> tuple[datetime, datetime] | None:
    start = max(first_start, second_start)
    end = min(first_end, second_end)
    return (start, end) if start < end else None


def _service_ids(*services: ServiceSchedule) -> tuple[int, ...]:
    return _non_null_ids(service.service_id for service in services)


def _non_null_ids(values: Iterable[int | None]) -> tuple[int, ...]:
    return tuple(sorted(value for value in values if value is not None))


def _conflict_sort_key(conflict: ScheduleConflict) -> tuple[datetime, str, str]:
    return (conflict.start_time, conflict.conflict_type.value, conflict.resource_id or "")
