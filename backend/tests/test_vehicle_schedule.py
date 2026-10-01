from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.timeline import TimelineInterval
from app.domain.vehicle_schedule import (
    ResourceOccupancy,
    ResourceType,
    ServiceSchedule,
    ServiceScheduleError,
    VehicleLocationContinuityError,
    VehicleOverlapError,
    IncomparableScheduleTimeError,
    occupancies_overlap,
    validate_service_deletion,
    validate_vehicle_schedule,
    vehicle_occupancy,
)


BASE_TIME = datetime(2026, 9, 28, 8, 0, tzinfo=timezone.utc)


def make_schedule(
    *,
    service_id: int | None,
    vehicle_id: str = "V1",
    start_location: str = "P1A",
    end_location: str = "P2A",
    start_seconds: int = 0,
    end_seconds: int = 10,
) -> ServiceSchedule:
    start_time = BASE_TIME + timedelta(seconds=start_seconds)
    end_time = BASE_TIME + timedelta(seconds=end_seconds)
    path = (start_location, end_location)
    timeline = (
        TimelineInterval(start_location, start_time, start_time),
        TimelineInterval(end_location, start_time, end_time),
    )
    return ServiceSchedule(
        service_id=service_id,
        vehicle_id=vehicle_id,
        path=path,
        timeline=timeline,
    )


def test_half_open_occupancies_do_not_overlap_at_touching_endpoint():
    first = vehicle_occupancy(make_schedule(service_id=1, end_seconds=10))
    second = vehicle_occupancy(
        make_schedule(service_id=2, start_seconds=10, end_seconds=20)
    )

    assert not occupancies_overlap(first, second)


def test_half_open_occupancies_overlap_when_time_is_shared():
    first = vehicle_occupancy(make_schedule(service_id=1, end_seconds=11))
    second = vehicle_occupancy(
        make_schedule(service_id=2, start_seconds=10, end_seconds=20)
    )

    assert occupancies_overlap(first, second)
    assert occupancies_overlap(second, first)


def test_zero_duration_occupancy_does_not_overlap_nonempty_occupancy():
    empty = vehicle_occupancy(
        make_schedule(service_id=1, start_seconds=10, end_seconds=10)
    )
    nonempty = vehicle_occupancy(
        make_schedule(service_id=2, start_seconds=0, end_seconds=20)
    )

    assert not occupancies_overlap(empty, nonempty)
    assert not occupancies_overlap(nonempty, empty)


def test_zero_duration_occupancies_do_not_overlap_each_other():
    first = vehicle_occupancy(
        make_schedule(service_id=1, start_seconds=10, end_seconds=10)
    )
    second = vehicle_occupancy(
        make_schedule(service_id=2, start_seconds=10, end_seconds=10)
    )

    assert not occupancies_overlap(first, second)


def test_vehicle_occupancy_spans_the_complete_service():
    schedule = make_schedule(
        service_id=7,
        vehicle_id="V7",
        start_seconds=5,
        end_seconds=25,
    )

    occupancy = vehicle_occupancy(schedule)

    assert occupancy == ResourceOccupancy(
        resource_type=ResourceType.VEHICLE,
        resource_id="V7",
        start_time=BASE_TIME + timedelta(seconds=5),
        end_time=BASE_TIME + timedelta(seconds=25),
        service_id=7,
    )


def test_create_candidate_without_service_id_is_valid():
    candidate = make_schedule(service_id=None)

    validate_vehicle_schedule(candidate, ())


def test_update_excludes_existing_service_with_same_id():
    existing = make_schedule(service_id=10, start_seconds=0, end_seconds=20)
    candidate = make_schedule(
        service_id=10,
        start_location="P3A",
        end_location="P4A",
        start_seconds=5,
        end_seconds=15,
    )

    validate_vehicle_schedule(candidate, (existing,))


def test_other_vehicle_does_not_affect_candidate():
    existing = make_schedule(
        service_id=1,
        vehicle_id="V2",
        start_location="P9A",
        end_location="P9B",
    )
    candidate = make_schedule(service_id=None, vehicle_id="V1")

    validate_vehicle_schedule(candidate, (existing,))


def test_rejects_vehicle_time_overlap():
    existing = make_schedule(service_id=1, end_seconds=15)
    candidate = make_schedule(
        service_id=None,
        start_location="P2A",
        end_location="P3A",
        start_seconds=10,
        end_seconds=20,
    )

    with pytest.raises(VehicleOverlapError) as exc_info:
        validate_vehicle_schedule(candidate, (existing,))

    assert exc_info.value.conflicting_service_id == 1


def test_touching_services_require_matching_location():
    predecessor = make_schedule(service_id=1, end_location="P2A", end_seconds=10)
    candidate = make_schedule(
        service_id=None,
        start_location="P3A",
        end_location="P4A",
        start_seconds=10,
        end_seconds=20,
    )

    with pytest.raises(VehicleLocationContinuityError) as exc_info:
        validate_vehicle_schedule(candidate, (predecessor,))

    assert exc_info.value.from_location == "P2A"
    assert exc_info.value.to_location == "P3A"


def test_time_gap_still_requires_matching_predecessor_location():
    predecessor = make_schedule(service_id=1, end_location="P2A", end_seconds=10)
    candidate = make_schedule(
        service_id=None,
        start_location="P3A",
        end_location="P4A",
        start_seconds=20,
        end_seconds=30,
    )

    with pytest.raises(VehicleLocationContinuityError):
        validate_vehicle_schedule(candidate, (predecessor,))


def test_matching_predecessor_location_is_continuous_across_time_gap():
    predecessor = make_schedule(service_id=1, end_location="P2A", end_seconds=10)
    candidate = make_schedule(
        service_id=None,
        start_location="P2A",
        end_location="P3A",
        start_seconds=20,
        end_seconds=30,
    )

    validate_vehicle_schedule(candidate, (predecessor,))


def test_rejects_mismatched_successor_location():
    candidate = make_schedule(
        service_id=None,
        start_location="P1A",
        end_location="P2A",
        start_seconds=10,
        end_seconds=20,
    )
    successor = make_schedule(
        service_id=2,
        start_location="P3A",
        end_location="P4A",
        start_seconds=30,
        end_seconds=40,
    )

    with pytest.raises(VehicleLocationContinuityError) as exc_info:
        validate_vehicle_schedule(candidate, (successor,))

    assert exc_info.value.from_location == "P2A"
    assert exc_info.value.to_location == "P3A"


def test_matching_successor_location_is_continuous():
    candidate = make_schedule(
        service_id=None,
        start_location="P1A",
        end_location="P2A",
        start_seconds=10,
        end_seconds=20,
    )
    successor = make_schedule(
        service_id=2,
        start_location="P2A",
        end_location="P3A",
        start_seconds=30,
        end_seconds=40,
    )

    validate_vehicle_schedule(candidate, (successor,))


def test_zero_duration_candidate_still_checks_predecessor_continuity():
    predecessor = make_schedule(service_id=1, end_location="P2A", end_seconds=10)
    candidate = make_schedule(
        service_id=None,
        start_location="P3A",
        end_location="P3A",
        start_seconds=20,
        end_seconds=20,
    )

    with pytest.raises(VehicleLocationContinuityError):
        validate_vehicle_schedule(candidate, (predecessor,))


def test_zero_duration_candidate_still_checks_successor_continuity():
    candidate = make_schedule(
        service_id=None,
        start_location="P2A",
        end_location="P2A",
        start_seconds=20,
        end_seconds=20,
    )
    successor = make_schedule(
        service_id=2,
        start_location="P3A",
        end_location="P4A",
        start_seconds=30,
        end_seconds=40,
    )

    with pytest.raises(VehicleLocationContinuityError):
        validate_vehicle_schedule(candidate, (successor,))


def test_continuity_uses_only_immediately_adjacent_services():
    earlier = make_schedule(
        service_id=1,
        start_location="P0A",
        end_location="P1A",
        start_seconds=0,
        end_seconds=5,
    )
    predecessor = make_schedule(
        service_id=2,
        start_location="P1A",
        end_location="P2A",
        start_seconds=5,
        end_seconds=10,
    )
    candidate = make_schedule(
        service_id=None,
        start_location="P2A",
        end_location="P3A",
        start_seconds=20,
        end_seconds=30,
    )
    successor = make_schedule(
        service_id=3,
        start_location="P3A",
        end_location="P4A",
        start_seconds=40,
        end_seconds=50,
    )
    later = make_schedule(
        service_id=4,
        start_location="P4A",
        end_location="P5A",
        start_seconds=50,
        end_seconds=60,
    )

    validate_vehicle_schedule(
        candidate,
        (later, earlier, successor, predecessor),
    )


@pytest.mark.parametrize(
    ("path", "timeline"),
    [
        ((), ()),
        (
            ("P1A",),
            (
                TimelineInterval("P1A", BASE_TIME, BASE_TIME),
                TimelineInterval("P2A", BASE_TIME, BASE_TIME),
            ),
        ),
    ],
)
def test_rejects_empty_or_different_length_path_and_timeline(path, timeline):
    with pytest.raises(ServiceScheduleError):
        ServiceSchedule(None, "V1", path, timeline)


def test_rejects_timeline_element_that_does_not_match_path_index():
    interval = TimelineInterval("P2A", BASE_TIME, BASE_TIME)

    with pytest.raises(ServiceScheduleError) as exc_info:
        ServiceSchedule(None, "V1", ("P1A",), (interval,))

    assert exc_info.value.path_index == 0


def test_service_schedule_is_immutable():
    schedule = make_schedule(service_id=1)

    with pytest.raises(FrozenInstanceError):
        schedule.vehicle_id = "V2"


def deletion_schedule():
    return (
        make_schedule(service_id=1, end_location="P2A", end_seconds=10),
        make_schedule(
            service_id=2, start_location="P2A", end_location="P3A",
            start_seconds=20, end_seconds=30,
        ),
        make_schedule(
            service_id=3, start_location="P3A", end_location="P4A",
            start_seconds=40, end_seconds=50,
        ),
    )


def test_deletion_rejects_broken_remaining_continuity_without_mutation():
    services = deletion_schedule()
    original = tuple(services)

    with pytest.raises(VehicleLocationContinuityError) as exc_info:
        validate_service_deletion(services[1], iter(reversed(services)))

    assert exc_info.value.from_service_id == 1
    assert exc_info.value.to_service_id == 3
    assert exc_info.value.from_location == "P2A"
    assert exc_info.value.to_location == "P3A"
    assert services == original


def test_deletion_allows_matching_remaining_locations_across_time_gap():
    predecessor, _, successor = deletion_schedule()
    target = make_schedule(
        service_id=2, start_location="P2A", end_location="P2A",
        start_seconds=20, end_seconds=30,
    )
    successor = make_schedule(
        service_id=3, start_location="P2A", end_location="P4A",
        start_seconds=40, end_seconds=50,
    )

    validate_service_deletion(target, (successor, target, predecessor))


@pytest.mark.parametrize("target_index,only_service", [(0, False), (2, False), (1, True)])
def test_deletion_allows_first_last_or_only_service(target_index, only_service):
    services = deletion_schedule()
    target = services[target_index]

    validate_service_deletion(target, (target,) if only_service else services)


def test_deletion_ignores_other_vehicles():
    target = make_schedule(service_id=2, start_seconds=20, end_seconds=30)
    other_services = (
        make_schedule(service_id=1, vehicle_id="V2", end_seconds=10),
        make_schedule(service_id=3, vehicle_id="V2", start_seconds=40, end_seconds=50),
    )

    validate_service_deletion(target, (*other_services, target))


def test_deletion_checks_only_immediate_neighbors():
    predecessor = make_schedule(
        service_id=2, start_location="P1A", end_location="P2A",
        start_seconds=10, end_seconds=20,
    )
    target = make_schedule(
        service_id=3, start_location="P2A", end_location="P2A",
        start_seconds=20, end_seconds=30,
    )
    successor = make_schedule(
        service_id=4, start_location="P2A", end_location="P3A",
        start_seconds=30, end_seconds=40,
    )
    earlier = make_schedule(service_id=1, end_location="P1A", end_seconds=10)
    later = make_schedule(
        service_id=5, start_location="P3A", end_location="P4A",
        start_seconds=40, end_seconds=50,
    )

    validate_service_deletion(target, (later, predecessor, target, earlier, successor))


def test_zero_duration_deletion_still_checks_continuity():
    predecessor, _, successor = deletion_schedule()
    target = make_schedule(
        service_id=2, start_seconds=20, end_seconds=20,
    )

    with pytest.raises(VehicleLocationContinuityError):
        validate_service_deletion(target, (predecessor, target, successor))


def test_deletion_rejects_incomparable_schedule_times():
    predecessor, target, successor = deletion_schedule()
    naive_target = ServiceSchedule(
        service_id=target.service_id, vehicle_id=target.vehicle_id, path=target.path,
        timeline=tuple(
            TimelineInterval(
                interval.element_id,
                interval.start_time.replace(tzinfo=None),
                interval.end_time.replace(tzinfo=None),
            ) for interval in target.timeline
        ),
    )

    with pytest.raises(IncomparableScheduleTimeError):
        validate_service_deletion(naive_target, (predecessor, successor))


def test_deletion_requires_persisted_target_identity():
    with pytest.raises(ServiceScheduleError):
        validate_service_deletion(make_schedule(service_id=None), ())
