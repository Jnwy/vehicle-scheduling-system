"""Write validation for block occupancy and battery conflicts.

`schedule_analysis` reports these conflicts for a persisted schedule. This
module rejects a create or update that would introduce one, so the analysis
only still reports conflicts that were saved before the rule existed.
"""

from datetime import datetime
from typing import Iterable

from app.domain.models import RailwayTopology, TrackElementType
from app.domain.schedule_analysis import (
    BLOCK_BATTERY_COST,
    ConflictType,
    ScheduleAnalysis,
    ScheduleConflict,
    SegmentType,
    analyze_schedule,
)
from app.domain.vehicle_schedule import ServiceSchedule, service_label


BATTERY_CONFLICT_TYPES = (ConflictType.INSUFFICIENT_CHARGE, ConflictType.LOW_BATTERY)
# Not an analysis conflict type: schedule analysis clamps the battery at zero
# and reports the stretch as low battery. Only write validation tells it apart.
EMPTY_BATTERY = "EMPTY_BATTERY"
BATTERY_REJECTIONS = {
    ConflictType.INSUFFICIENT_CHARGE.value: "leave the yard below 80 battery units",
    ConflictType.LOW_BATTERY.value: "be below 30 battery units outside the yard",
    EMPTY_BATTERY: "run out of battery before it can cross a block",
}


class BlockOccupancyConflictError(ValueError):
    def __init__(
        self,
        block_id: str,
        candidate_service_id: int | None,
        conflicting_service_id: int | None,
    ) -> None:
        self.block_id = block_id
        self.candidate_service_id = candidate_service_id
        self.conflicting_service_id = conflicting_service_id
        super().__init__(
            f"{service_label(candidate_service_id, sentence_start=True)} occupies "
            f"block '{block_id}' at the same time as {service_label(conflicting_service_id)}."
        )


class BatteryConflictError(ValueError):
    def __init__(
        self,
        conflict_type: str,
        vehicle_id: str,
        candidate_service_id: int | None,
    ) -> None:
        self.conflict_type = conflict_type
        self.vehicle_id = vehicle_id
        self.candidate_service_id = candidate_service_id
        super().__init__(
            f"With {service_label(candidate_service_id)}, vehicle {vehicle_id} would "
            f"{BATTERY_REJECTIONS[conflict_type]}."
        )


def validate_block_occupancy(
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
    topology: RailwayTopology,
) -> None:
    requested = [
        interval for interval in candidate.timeline
        if topology.elements[interval.element_id].element_type is TrackElementType.BLOCK
        and interval.start_time != interval.end_time
    ]
    for existing in existing_services:
        if existing.vehicle_id == candidate.vehicle_id or (
            candidate.service_id is not None and existing.service_id == candidate.service_id
        ):
            continue
        for occupied in existing.timeline:
            if occupied.start_time == occupied.end_time:
                continue
            for interval in requested:
                if (
                    interval.element_id == occupied.element_id
                    and interval.start_time < occupied.end_time
                    and occupied.start_time < interval.end_time
                ):
                    raise BlockOccupancyConflictError(
                        interval.element_id, candidate.service_id, existing.service_id,
                    )


def validate_battery(
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
    topology: RailwayTopology,
    target: ServiceSchedule | None = None,
) -> None:
    """Reject battery conflicts the write adds to the vehicles it touches.

    A conflict that starts at the same instant as one already saved for the
    vehicle is not new. This keeps a vehicle whose schedule was saved with a
    battery conflict editable, for example to send it back to the yard.

    A candidate that ends in the yard is not rejected for a low battery that
    begins before it gets there: the vehicle is on its way to charge. Schedule
    analysis still reports that stretch. It is rejected when the battery would
    not last: a vehicle cannot enter a block with less than the one unit the
    block costs, wherever the service ends.
    """
    existing = tuple(existing_services)
    if target is None:
        final = (*existing, candidate)
    else:
        final = tuple(
            candidate if service.service_id == target.service_id else service
            for service in existing
        )
    affected = {candidate.vehicle_id} | ({target.vehicle_id} if target is not None else set())
    before = _battery_analysis(existing, affected, topology)
    after = _battery_analysis(final, affected, topology)
    known_empty = set(_blocks_entered_empty(before, topology))
    for vehicle_id, start_time in _blocks_entered_empty(after, topology):
        if (vehicle_id, start_time) not in known_empty:
            raise BatteryConflictError(EMPTY_BATTERY, vehicle_id, candidate.service_id)
    known = {_conflict_key(conflict) for conflict in _battery_conflicts(before)}
    ends_in_yard = topology.elements[candidate.end_location].element_type is TrackElementType.YARD
    for conflict in _battery_conflicts(after):
        heading_to_charge = (
            ends_in_yard
            and conflict.conflict_type is ConflictType.LOW_BATTERY
            and conflict.vehicle_ids[0] == candidate.vehicle_id
            and conflict.start_time <= candidate.end_time
        )
        if _conflict_key(conflict) not in known and not heading_to_charge:
            raise BatteryConflictError(
                conflict.conflict_type.value, conflict.vehicle_ids[0], candidate.service_id,
            )


def _battery_analysis(
    services: tuple[ServiceSchedule, ...],
    vehicle_ids: set[str],
    topology: RailwayTopology,
) -> ScheduleAnalysis:
    return analyze_schedule(
        (service for service in services if service.vehicle_id in vehicle_ids), topology,
    )


def _battery_conflicts(analysis: ScheduleAnalysis) -> tuple[ScheduleConflict, ...]:
    return tuple(
        conflict for conflict in analysis.conflicts
        if conflict.conflict_type in BATTERY_CONFLICT_TYPES
    )


def _blocks_entered_empty(
    analysis: ScheduleAnalysis, topology: RailwayTopology,
) -> tuple[tuple[str, datetime], ...]:
    """Blocks a vehicle would enter without the battery to cross them."""
    return tuple(
        (vehicle.vehicle_id, segment.start_time)
        for vehicle in analysis.vehicles
        for segment in vehicle.segments
        if segment.segment_type is SegmentType.SERVICE
        and topology.elements[segment.element_id].element_type is TrackElementType.BLOCK
        and segment.battery_start < BLOCK_BATTERY_COST
    )


def _conflict_key(conflict: ScheduleConflict) -> tuple:
    return (conflict.conflict_type, conflict.vehicle_ids, conflict.start_time)
