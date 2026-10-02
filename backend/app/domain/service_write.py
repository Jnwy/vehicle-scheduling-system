from typing import Iterable

from app.domain.interlocking import validate_interlocking_schedule
from app.domain.models import RailwayTopology
from app.domain.schedule_conflicts import validate_battery, validate_block_occupancy
from app.domain.vehicle_schedule import (
    ServiceSchedule, validate_service_update, validate_vehicle_schedule,
)


def validate_service_write(
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
    topology: RailwayTopology,
    target: ServiceSchedule | None = None,
) -> None:
    """Every scheduling check a create (no target) or an update must pass."""
    existing = tuple(existing_services)
    if target is None:
        validate_vehicle_schedule(candidate, existing)
    else:
        validate_service_update(target, candidate, existing)
    validate_interlocking_schedule(candidate, existing, topology)
    validate_block_occupancy(candidate, existing, topology)
    validate_battery(candidate, existing, topology, target)
