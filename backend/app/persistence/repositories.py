from dataclasses import replace

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.domain.models import (
    RailwayTopology,
    TrackConnection,
    TrackElement,
    TrackElementType,
)
from app.domain.timeline import TimelineInterval
from app.domain.vehicle_schedule import ServiceSchedule
from app.persistence.models import (
    ServicePathElementRecord,
    ServiceRecord,
    TrackConnectionRecord,
    TrackElementRecord,
)


class PersistenceError(ValueError):
    pass


class ServiceNotFoundError(PersistenceError):
    def __init__(self, service_id: int) -> None:
        self.service_id = service_id
        super().__init__(f"Service {service_id} does not exist.")


class BlockConfigurationError(PersistenceError):
    def __init__(self, element_id: str, message: str) -> None:
        self.element_id = element_id
        super().__init__(message)


class TopologyRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self) -> RailwayTopology:
        element_records = self._session.scalars(
            select(TrackElementRecord).order_by(TrackElementRecord.id)
        )
        connection_records = self._session.scalars(select(TrackConnectionRecord))

        elements = {
            record.id: TrackElement(
                id=record.id,
                element_type=TrackElementType(record.element_type),
                traversal_seconds=record.traversal_seconds,
                interlocking_group=record.interlocking_group,
            )
            for record in element_records
        }
        connections = frozenset(
            TrackConnection(record.from_element_id, record.to_element_id)
            for record in connection_records
        )
        return RailwayTopology(elements=elements, connections=connections)

    def update_block_traversal_time(
        self,
        element_id: str,
        traversal_seconds: int,
    ) -> None:
        record = self._session.get(TrackElementRecord, element_id)
        if record is None:
            raise BlockConfigurationError(
                element_id,
                f"Track element '{element_id}' does not exist.",
            )
        if record.element_type != TrackElementType.BLOCK.value:
            raise BlockConfigurationError(
                element_id,
                f"Track element '{element_id}' is not a block.",
            )
        if traversal_seconds < 0:
            raise BlockConfigurationError(
                element_id,
                "Block traversal time must be non-negative.",
            )

        record.traversal_seconds = traversal_seconds
        self._session.flush()


class ServiceRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def create(self, schedule: ServiceSchedule) -> ServiceSchedule:
        if schedule.service_id is not None:
            raise PersistenceError("A new service must not already have an ID.")

        record = ServiceRecord(
            vehicle_id=schedule.vehicle_id,
            start_time=schedule.start_time,
        )
        self._session.add(record)
        self._session.flush()
        self._write_path_snapshot(record.id, schedule)
        return replace(schedule, service_id=record.id)

    def get(self, service_id: int) -> ServiceSchedule | None:
        record = self._session.scalar(
            select(ServiceRecord)
            .options(selectinload(ServiceRecord.path_elements))
            .where(ServiceRecord.id == service_id)
        )
        if record is None:
            return None
        return _schedule_from_record(record)

    def list(self) -> tuple[ServiceSchedule, ...]:
        records = self._session.scalars(
            select(ServiceRecord)
            .options(selectinload(ServiceRecord.path_elements))
            .order_by(ServiceRecord.id)
        )
        return tuple(_schedule_from_record(record) for record in records)

    def update(self, schedule: ServiceSchedule) -> ServiceSchedule:
        if schedule.service_id is None:
            raise PersistenceError("An updated service must have an ID.")

        record = self._session.get(ServiceRecord, schedule.service_id)
        if record is None:
            raise ServiceNotFoundError(schedule.service_id)

        record.vehicle_id = schedule.vehicle_id
        record.start_time = schedule.start_time
        self._session.execute(
            delete(ServicePathElementRecord).where(
                ServicePathElementRecord.service_id == schedule.service_id
            )
        )
        self._session.flush()
        self._write_path_snapshot(schedule.service_id, schedule)
        # Bulk child replacement does not refresh an already loaded relationship.
        self._session.expire(record, ["path_elements"])
        return schedule

    def delete(self, service_id: int) -> bool:
        record = self._session.get(ServiceRecord, service_id)
        if record is None:
            return False

        self._session.delete(record)
        self._session.flush()
        return True

    def _write_path_snapshot(
        self,
        service_id: int,
        schedule: ServiceSchedule,
    ) -> None:
        self._session.add_all(
            ServicePathElementRecord(
                service_id=service_id,
                path_index=path_index,
                element_id=element_id,
                interval_start_time=interval.start_time,
                interval_end_time=interval.end_time,
            )
            for path_index, (element_id, interval) in enumerate(
                zip(schedule.path, schedule.timeline, strict=True)
            )
        )
        self._session.flush()


def _schedule_from_record(record: ServiceRecord) -> ServiceSchedule:
    path_elements = sorted(record.path_elements, key=lambda item: item.path_index)
    return ServiceSchedule(
        service_id=record.id,
        vehicle_id=record.vehicle_id,
        path=tuple(item.element_id for item in path_elements),
        timeline=tuple(
            TimelineInterval(
                element_id=item.element_id,
                start_time=item.interval_start_time,
                end_time=item.interval_end_time,
            )
            for item in path_elements
        ),
    )
