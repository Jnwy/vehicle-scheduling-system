from datetime import datetime, timedelta, timezone

import pytest

from app.domain.interlocking import InterlockingConflictError, validate_interlocking_schedule
from app.domain.timeline import TimelineInterval
from app.domain.topology import assignment_topology
from app.domain.vehicle_schedule import ServiceSchedule


BASE_TIME = datetime(2026, 10, 2, 8, tzinfo=timezone.utc)


def schedule(block, *, start=0, end=20, vehicle="V1", service_id=1):
    return ServiceSchedule(
        service_id, vehicle, (block,),
        (TimelineInterval(block, BASE_TIME + timedelta(seconds=start),
                          BASE_TIME + timedelta(seconds=end)),),
    )


@pytest.mark.parametrize("block", ["B1", "B2"])
def test_interlocking_rejects_cross_vehicle_overlap_in_same_group(block):
    existing = schedule("B1")
    candidate = schedule(block, start=10, end=30, vehicle="V2", service_id=None)

    with pytest.raises(InterlockingConflictError) as error:
        validate_interlocking_schedule(candidate, [existing], assignment_topology())

    assert error.value.interlocking_group == "IG1"
    assert error.value.candidate_service_id is None
    assert error.value.conflicting_service_id == 1


@pytest.mark.parametrize("start,end", [(20, 40), (-20, 0), (10, 10)])
def test_interlocking_allows_touching_and_empty_intervals(start, end):
    validate_interlocking_schedule(
        schedule("B2", start=start, end=end, vehicle="V2", service_id=None),
        [schedule("B1")], assignment_topology(),
    )


@pytest.mark.parametrize("existing,candidate", [("B1", "B3"), ("B1", "B5"), ("B5", "B5")])
def test_interlocking_does_not_block_other_groups_or_ungrouped_blocks(existing, candidate):
    validate_interlocking_schedule(
        schedule(candidate, vehicle="V2", service_id=None),
        [schedule(existing)], assignment_topology(),
    )


def test_interlocking_update_excludes_original_service():
    validate_interlocking_schedule(
        schedule("B2", vehicle="V2"), [schedule("B1")], assignment_topology(),
    )


def test_interlocking_checks_block_intervals_not_whole_service():
    existing = ServiceSchedule(1, "V1", ("B1", "P1A"), (
        TimelineInterval("B1", BASE_TIME, BASE_TIME + timedelta(seconds=20)),
        TimelineInterval("P1A", BASE_TIME + timedelta(seconds=20),
                         BASE_TIME + timedelta(seconds=60)),
    ))
    validate_interlocking_schedule(
        schedule("B2", start=20, end=40, vehicle="V2", service_id=None),
        [existing], assignment_topology(),
    )
