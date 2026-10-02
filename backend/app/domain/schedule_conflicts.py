"""Write validation for block occupancy and battery conflicts.

`schedule_analysis` reports these conflicts for a persisted schedule. This
module rejects a create or update that would introduce one, so the analysis
only still reports conflicts that were saved before the rule existed.
"""

from typing import Iterable

from app.domain.models import RailwayTopology, TrackElementType
from app.domain.schedule_analysis import (
    ConflictType,
    ScheduleConflict,
    analyze_schedule,
)
from app.domain.vehicle_schedule import ServiceSchedule, service_label


BATTERY_CONFLICT_TYPES = (ConflictType.INSUFFICIENT_CHARGE, ConflictType.LOW_BATTERY)


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
        conflict_type: ConflictType,
        vehicle_id: str,
        candidate_service_id: int | None,
    ) -> None:
        self.conflict_type = conflict_type.value
        self.vehicle_id = vehicle_id
        self.candidate_service_id = candidate_service_id
        reason = (
            "leave the yard below 80 battery units"
            if conflict_type is ConflictType.INSUFFICIENT_CHARGE
            else "be below 30 battery units outside the yard"
        )
        super().__init__(
            f"With {service_label(candidate_service_id)}, vehicle {vehicle_id} would {reason}."
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
    analysis still reports that stretch.
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
    known = {_conflict_key(conflict) for conflict in _battery_conflicts(existing, affected, topology)}
    ends_in_yard = topology.elements[candidate.end_location].element_type is TrackElementType.YARD
    for conflict in _battery_conflicts(final, affected, topology):
        heading_to_charge = (
            ends_in_yard
            and conflict.conflict_type is ConflictType.LOW_BATTERY
            and conflict.vehicle_ids[0] == candidate.vehicle_id
            and conflict.start_time <= candidate.end_time
        )
        if _conflict_key(conflict) not in known and not heading_to_charge:
            raise BatteryConflictError(
                conflict.conflict_type, conflict.vehicle_ids[0], candidate.service_id,
            )


def _battery_conflicts(
    services: tuple[ServiceSchedule, ...],
    vehicle_ids: set[str],
    topology: RailwayTopology,
) -> tuple[ScheduleConflict, ...]:
    analysis = analyze_schedule(
        (service for service in services if service.vehicle_id in vehicle_ids), topology,
    )
    return tuple(
        conflict for conflict in analysis.conflicts
        if conflict.conflict_type in BATTERY_CONFLICT_TYPES
    )


def _conflict_key(conflict: ScheduleConflict) -> tuple:
    return (conflict.conflict_type, conflict.vehicle_ids, conflict.start_time)
