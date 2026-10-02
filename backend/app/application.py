from datetime import datetime
from typing import Mapping, Sequence

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.domain.models import RailwayTopology, TrackElementType
from app.domain.block_reconfiguration import StaleService, stale_services, with_block_times
from app.domain.path_validation import validate_path
from app.domain.service_write import validate_service_write
from app.domain.timeline import PlatformTiming, calculate_timeline
from app.domain.vehicle_schedule import ServiceSchedule, ServiceScheduleError, validate_service_deletion
from app.persistence.models import VehicleRecord
from app.persistence.repositories import ServiceNotFoundError, ServiceRepository, TopologyRepository


# All application schedule/configuration writers must use this transaction lock.
SCHEDULE_WRITE_LOCK = 72634001


class ResourceNotFoundError(ValueError):
    pass


class UnknownVehicleError(ValueError):
    def __init__(self, vehicle_id: str) -> None:
        self.vehicle_id = vehicle_id
        super().__init__(f"Vehicle '{vehicle_id}' does not exist.")


def acquire_write_lock(session: Session) -> None:
    session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SCHEDULE_WRITE_LOCK})


def save_service(
    session: Session,
    vehicle_id: str,
    start_time: datetime,
    path: Sequence[str],
    platform_timings: Sequence[PlatformTiming],
    service_id: int | None = None,
) -> tuple[ServiceSchedule, RailwayTopology]:
    with session.begin():
        acquire_write_lock(session)
        repository = ServiceRepository(session)
        target = repository.get(service_id) if service_id is not None else None
        if service_id is not None and target is None:
            raise ServiceNotFoundError(service_id)
        if session.get(VehicleRecord, vehicle_id) is None:
            raise UnknownVehicleError(vehicle_id)
        topology = TopologyRepository(session).get()
        validate_path(path, topology)
        try:
            timeline = calculate_timeline(path, start_time, topology, platform_timings)
        except OverflowError as error:
            raise ServiceScheduleError("Calculated timeline exceeds the supported datetime range.") from error
        candidate = ServiceSchedule(service_id, vehicle_id, tuple(path), timeline)
        validate_service_write(candidate, repository.list(), topology, target)
        if target is None:
            return repository.create(candidate), topology
        return repository.update(candidate), topology


def delete_service(session: Session, service_id: int) -> None:
    with session.begin():
        acquire_write_lock(session)
        repository = ServiceRepository(session)
        target = repository.get(service_id)
        if target is None:
            raise ServiceNotFoundError(service_id)
        validate_service_deletion(target, repository.list())
        repository.delete(service_id)


def configure_block(
    session: Session, block_id: str, traversal_seconds: int,
) -> dict[str, str | int | None]:
    with session.begin():
        acquire_write_lock(session)
        repository = TopologyRepository(session)
        block = repository.get().elements.get(block_id)
        if block is None or block.element_type is not TrackElementType.BLOCK:
            raise ResourceNotFoundError(f"Block '{block_id}' does not exist.")
        repository.update_block_traversal_time(block_id, traversal_seconds)
        return {"id": block_id, "traversalSeconds": traversal_seconds,
                "interlockingGroup": block.interlocking_group}


def _require_blocks(topology: RailwayTopology, block_ids: Sequence[str]) -> None:
    for block_id in block_ids:
        block = topology.elements.get(block_id)
        if block is None or block.element_type is not TrackElementType.BLOCK:
            raise ResourceNotFoundError(f"Block '{block_id}' does not exist.")


def preview_block_changes(
    session: Session, traversal_seconds: Mapping[str, int],
) -> tuple[StaleService, ...]:
    """Which saved services the block times would leave stale. Saves nothing."""
    topology = TopologyRepository(session).get()
    _require_blocks(topology, list(traversal_seconds))
    return stale_services(
        ServiceRepository(session).list(), with_block_times(topology, traversal_seconds),
    )


def configure_blocks(
    session: Session, traversal_seconds: Mapping[str, int],
) -> list[dict[str, str | int | None]]:
    """Saves every block time or none of them."""
    with session.begin():
        acquire_write_lock(session)
        repository = TopologyRepository(session)
        topology = repository.get()
        _require_blocks(topology, list(traversal_seconds))
        for block_id, seconds in traversal_seconds.items():
            repository.update_block_traversal_time(block_id, seconds)
        return [{"id": block_id, "traversalSeconds": seconds,
                 "interlockingGroup": topology.elements[block_id].interlocking_group}
                for block_id, seconds in traversal_seconds.items()]


def list_vehicles(session: Session) -> list[dict[str, str]]:
    return [{"id": value} for value in session.scalars(select(VehicleRecord.id).order_by(VehicleRecord.id))]
