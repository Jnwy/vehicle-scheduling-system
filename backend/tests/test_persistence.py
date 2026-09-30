from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.domain.timeline import TimelineInterval
from app.domain.vehicle_schedule import ServiceSchedule
from app.persistence.database import engine
from app.persistence.models import (
    ServicePathElementRecord,
    ServiceRecord,
    TrackConnectionRecord,
    TrackElementRecord,
    VehicleRecord,
)
from app.persistence.repositories import (
    BlockConfigurationError,
    ServiceRepository,
    TopologyRepository,
)
from app.persistence.seed import seed_database


BASE_TIME = datetime(2026, 9, 29, 8, 0, tzinfo=timezone.utc)


@pytest.fixture
def session():
    with engine.connect() as connection:
        transaction = connection.begin()
        session = Session(
            bind=connection,
            join_transaction_mode="create_savepoint",
        )
        try:
            seed_database(session)
            yield session
        finally:
            session.close()
            transaction.rollback()


def make_schedule(
    *,
    service_id: int | None = None,
    vehicle_id: str = "V1",
    path: tuple[str, ...] = ("Y", "B1", "P1A"),
    durations: tuple[int, ...] = (0, 20, 30),
) -> ServiceSchedule:
    current_time = BASE_TIME
    intervals = []

    for element_id, duration in zip(path, durations, strict=True):
        end_time = current_time + timedelta(seconds=duration)
        intervals.append(TimelineInterval(element_id, current_time, end_time))
        current_time = end_time

    return ServiceSchedule(
        service_id=service_id,
        vehicle_id=vehicle_id,
        path=path,
        timeline=tuple(intervals),
    )


def test_seed_creates_expected_vehicles_and_topology(session):
    assert session.scalars(select(VehicleRecord.id).order_by(VehicleRecord.id)).all() == [
        "V1",
        "V2",
    ]
    assert session.scalar(select(func.count()).select_from(TrackElementRecord)) == 21
    assert session.scalar(select(func.count()).select_from(TrackConnectionRecord)) == 28


def test_seed_is_idempotent_and_preserves_block_configuration(session):
    block = session.get(TrackElementRecord, "B1")
    block.traversal_seconds = 42
    session.flush()

    seed_database(session)

    assert session.get(TrackElementRecord, "B1").traversal_seconds == 42
    assert session.scalar(select(func.count()).select_from(TrackElementRecord)) == 21
    assert session.scalar(select(func.count()).select_from(TrackConnectionRecord)) == 28


def test_topology_repository_loads_mutable_block_configuration(session):
    repository = TopologyRepository(session)
    repository.update_block_traversal_time("B1", 25)

    topology = repository.get()

    assert topology.elements["B1"].traversal_seconds == 25
    assert topology.has_connection("Y", "B1")


@pytest.mark.parametrize(
    ("element_id", "traversal_seconds"),
    [("UNKNOWN", 20), ("P1A", 20), ("B1", -1)],
)
def test_topology_repository_rejects_invalid_block_configuration(
    session,
    element_id,
    traversal_seconds,
):
    repository = TopologyRepository(session)

    with pytest.raises(BlockConfigurationError):
        repository.update_block_traversal_time(element_id, traversal_seconds)


def test_service_repository_creates_and_reads_timeline_snapshot(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())
    session.get(TrackElementRecord, "B1").traversal_seconds = 99
    session.flush()

    loaded = repository.get(created.service_id)

    assert created.service_id is not None
    assert loaded == created
    assert loaded.timeline[1].end_time == BASE_TIME + timedelta(seconds=20)


def test_service_repository_lists_services_in_id_order(session):
    repository = ServiceRepository(session)
    first = repository.create(make_schedule(vehicle_id="V1"))
    second = repository.create(make_schedule(vehicle_id="V2"))

    services = repository.list()

    assert [service.service_id for service in services] == [
        first.service_id,
        second.service_id,
    ]


def test_service_repository_update_replaces_path_snapshot(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())
    replacement = make_schedule(
        service_id=created.service_id,
        path=("P1A", "B3"),
        durations=(10, 15),
    )

    updated = repository.update(replacement)

    assert updated == replacement
    assert repository.get(created.service_id) == replacement
    child_count = session.scalar(
        select(func.count())
        .select_from(ServicePathElementRecord)
        .where(ServicePathElementRecord.service_id == created.service_id)
    )
    assert child_count == 2


def test_service_repository_delete_cascades_path_snapshot(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())

    assert repository.delete(created.service_id)
    assert repository.get(created.service_id) is None
    assert session.scalar(
        select(func.count())
        .select_from(ServicePathElementRecord)
        .where(ServicePathElementRecord.service_id == created.service_id)
    ) == 0


@pytest.mark.parametrize("read_method", ["get", "list"])
def test_service_repository_update_refreshes_loaded_path_snapshot(session, read_method):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())
    # Retain the ORM object so its loaded relationship stays in the identity map.
    record = session.get(ServiceRecord, created.service_id)
    assert repository.get(created.service_id) == created
    assert len(record.path_elements) == 3
    replacement = make_schedule(
        service_id=created.service_id,
        path=("P1A", "B3"),
        durations=(10, 15),
    )

    repository.update(replacement)

    loaded = (
        repository.get(created.service_id)
        if read_method == "get"
        else next(
            service for service in repository.list()
            if service.service_id == created.service_id
        )
    )
    assert loaded == replacement
    assert [item.element_id for item in record.path_elements] == list(replacement.path)


def test_service_repository_refreshes_snapshot_after_successive_updates(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())
    record = session.get(ServiceRecord, created.service_id)
    assert repository.get(created.service_id) == created

    for path, durations in [
        (("P1A", "B3"), (10, 15)),
        (("Y", "B2", "P1B"), (0, 25, 40)),
    ]:
        replacement = make_schedule(
            service_id=created.service_id, path=path, durations=durations,
        )
        repository.update(replacement)
        assert repository.get(created.service_id) == replacement
        assert len(record.path_elements) == len(path)


def test_failed_service_update_restores_original_service_and_snapshot(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())
    session.commit()
    record = session.get(ServiceRecord, created.service_id)
    assert repository.get(created.service_id) == created
    invalid = make_schedule(
        service_id=created.service_id,
        vehicle_id="V2",
        path=("P1A", "UNKNOWN"),
        durations=(10, 15),
    )

    with pytest.raises(IntegrityError):
        repository.update(invalid)
    session.rollback()

    assert repository.get(created.service_id) == created
    assert record.vehicle_id == "V1"
    assert [item.path_index for item in record.path_elements] == [0, 1, 2]
    assert session.scalar(
        select(func.count()).select_from(ServicePathElementRecord)
        .where(ServicePathElementRecord.service_id == created.service_id)
    ) == 3


def test_service_repository_preserves_repeated_platform_occurrences(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule(
        path=("P1A", "B1", "Y", "B1", "P1A"),
        durations=(10, 20, 0, 20, 30),
    ))
    session.expire_all()

    loaded = repository.get(created.service_id)

    assert loaded == created
    assert loaded.timeline[0].end_time == BASE_TIME + timedelta(seconds=10)
    assert loaded.timeline[4].start_time == BASE_TIME + timedelta(seconds=50)
    assert loaded.timeline[4].end_time == BASE_TIME + timedelta(seconds=80)


def test_service_repository_does_not_commit_caller_transaction(session):
    repository = ServiceRepository(session)
    created = repository.create(make_schedule())

    session.rollback()

    assert session.get(ServiceRecord, created.service_id) is None


def test_failed_service_write_can_be_rolled_back_without_partial_rows(session):
    repository = ServiceRepository(session)
    invalid = make_schedule(vehicle_id="UNKNOWN")

    with pytest.raises(IntegrityError):
        repository.create(invalid)

    session.rollback()

    assert session.scalar(select(func.count()).select_from(ServiceRecord)) == 0
    assert session.scalar(
        select(func.count()).select_from(ServicePathElementRecord)
    ) == 0
