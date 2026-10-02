from datetime import datetime, timedelta, timezone

from app.domain.block_reconfiguration import recalculated_schedule, stale_services, with_block_times
from app.domain.interlocking import InterlockingConflictError
from app.domain.timeline import TimelineInterval
from app.domain.topology import assignment_topology
from app.domain.vehicle_schedule import ServiceSchedule, VehicleOverlapError


BASE_TIME = datetime(2026, 10, 3, 8, tzinfo=timezone.utc)
# Every block takes 10 seconds, as the schedules below were saved.
SAVED_TOPOLOGY = with_block_times(
    assignment_topology(), {f"B{number}": 10 for number in range(1, 15)},
)


def schedule(elements, *, start=0, vehicle="V1", service_id=1, dwell=30):
    current = BASE_TIME + timedelta(seconds=start)
    timeline = []
    for element_id in elements:
        seconds = 10 if element_id.startswith("B") else dwell if element_id.startswith("P") else 0
        end = current + timedelta(seconds=seconds)
        timeline.append(TimelineInterval(element_id, current, end))
        current = end
    return ServiceSchedule(service_id, vehicle, tuple(elements), tuple(timeline))


def test_with_block_times_changes_only_the_named_blocks():
    changed = with_block_times(SAVED_TOPOLOGY, {"B1": 25})

    assert changed.elements["B1"].traversal_seconds == 25
    assert changed.elements["B2"].traversal_seconds == 10
    assert SAVED_TOPOLOGY.elements["B1"].traversal_seconds == 10


def test_recalculation_keeps_the_start_and_platform_dwell_and_shifts_what_follows():
    saved = schedule(("Y", "B1", "P1A", "B3", "B5", "P2A"))

    recalculated = recalculated_schedule(saved, with_block_times(SAVED_TOPOLOGY, {"B1": 25}))

    assert recalculated.start_time == saved.start_time
    platform = recalculated.timeline[2]
    assert platform.start_time == BASE_TIME + timedelta(seconds=25)
    assert platform.end_time - platform.start_time == timedelta(seconds=30)
    assert recalculated.end_time == saved.end_time + timedelta(seconds=15)


def test_nothing_is_stale_while_the_block_times_match_the_snapshots():
    services = [schedule(("Y", "B1", "P1A")), schedule(("Y", "B2", "P1B"), vehicle="V2", service_id=2, start=60)]

    assert stale_services(services, SAVED_TOPOLOGY) == ()


def test_only_services_passing_a_changed_block_are_stale_in_running_order():
    services = [
        schedule(("Y", "B1", "Y"), service_id=3, start=600),
        schedule(("Y", "B2", "Y"), vehicle="V2", service_id=2, start=300),
        schedule(("Y", "B1", "Y"), service_id=1),
    ]

    stale = stale_services(services, with_block_times(SAVED_TOPOLOGY, {"B1": 25}))

    assert [item.saved.service_id for item in stale] == [1, 3]
    assert [item.conflict for item in stale] == [None, None]


def test_a_stale_service_that_would_enter_another_vehicles_interlocking_group_is_flagged():
    first = schedule(("Y", "B1", "Y"))
    other = schedule(("Y", "B2", "Y"), vehicle="V2", service_id=2, start=15)

    stale = stale_services([first, other], with_block_times(SAVED_TOPOLOGY, {"B1": 20}))

    assert [item.saved.service_id for item in stale] == [1]
    assert isinstance(stale[0].conflict, InterlockingConflictError)
    assert stale[0].conflict.conflicting_service_id == 2


def test_a_touching_interval_after_recalculation_is_not_a_conflict():
    first = schedule(("Y", "B1", "Y"))
    other = schedule(("Y", "B2", "Y"), vehicle="V2", service_id=2, start=20)

    stale = stale_services([first, other], with_block_times(SAVED_TOPOLOGY, {"B1": 20}))

    assert [item.conflict for item in stale] == [None]


def test_a_stale_service_that_would_run_into_the_vehicles_next_service_is_flagged():
    first = schedule(("Y", "B1", "Y"))
    following = schedule(("Y", "B2", "Y"), service_id=2, start=10)

    stale = stale_services([first, following], with_block_times(SAVED_TOPOLOGY, {"B1": 20}))

    assert [item.saved.service_id for item in stale] == [1]
    assert isinstance(stale[0].conflict, VehicleOverlapError)


def test_each_stale_service_is_checked_against_the_saved_snapshots_of_the_others():
    # Both pass B1. Updated alone, the first runs into the second's saved
    # snapshot; the second, starting later, only moves its own end.
    first = schedule(("Y", "B1", "Y"))
    second = schedule(("Y", "B1", "Y"), service_id=2, start=10)

    stale = stale_services([first, second], with_block_times(SAVED_TOPOLOGY, {"B1": 20}))

    assert [item.saved.service_id for item in stale] == [1, 2]
    assert isinstance(stale[0].conflict, VehicleOverlapError)
    assert stale[1].conflict is None
