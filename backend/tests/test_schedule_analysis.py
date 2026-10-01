from datetime import datetime, timedelta, timezone

import pytest

from app.domain.models import RailwayTopology, TrackConnection, TrackElement, TrackElementType
from app.domain.schedule_analysis import ConflictType, SegmentType, analyze_schedule
from app.domain.timeline import TimelineInterval
from app.domain.vehicle_schedule import ServiceSchedule


BASE_TIME = datetime(2026, 10, 1, 8, tzinfo=timezone(timedelta(hours=8)))


@pytest.fixture
def topology() -> RailwayTopology:
    elements = {
        "Y": TrackElement("Y", TrackElementType.YARD),
        "P1": TrackElement("P1", TrackElementType.PLATFORM),
        "P2": TrackElement("P2", TrackElementType.PLATFORM),
        "B1": TrackElement("B1", TrackElementType.BLOCK, interlocking_group="IG1"),
        "B2": TrackElement("B2", TrackElementType.BLOCK, interlocking_group="IG1"),
        "B3": TrackElement("B3", TrackElementType.BLOCK),
    }
    return RailwayTopology(
        elements=elements,
        connections=frozenset(
            {
                TrackConnection("Y", "B1"),
                TrackConnection("B1", "Y"),
                TrackConnection("B1", "P1"),
                TrackConnection("P1", "B2"),
                TrackConnection("B2", "P2"),
            }
        ),
    )


def schedule(
    service_id: int,
    vehicle_id: str,
    elements: tuple[str, ...],
    start_second: int,
    durations: tuple[int, ...],
) -> ServiceSchedule:
    current = BASE_TIME + timedelta(seconds=start_second)
    timeline = []
    for element_id, duration in zip(elements, durations, strict=True):
        end = current + timedelta(seconds=duration)
        timeline.append(TimelineInterval(element_id, current, end))
        current = end
    return ServiceSchedule(service_id, vehicle_id, elements, tuple(timeline))


def conflict_types(analysis) -> list[ConflictType]:
    return [conflict.conflict_type for conflict in analysis.conflicts]


def test_detects_overlapping_block_occupancy(topology):
    first = schedule(1, "V1", ("B1",), 0, (20,))
    second = schedule(2, "V2", ("B1",), 10, (20,))

    analysis = analyze_schedule((first, second), topology)

    assert ConflictType.BLOCK_OCCUPANCY in conflict_types(analysis)
    conflict = next(item for item in analysis.conflicts if item.conflict_type is ConflictType.BLOCK_OCCUPANCY)
    assert conflict.start_time == BASE_TIME + timedelta(seconds=10)
    assert conflict.end_time == BASE_TIME + timedelta(seconds=20)
    assert conflict.vehicle_ids == ("V1", "V2")
    assert conflict.element_ids == ("B1",)


def test_half_open_block_intervals_that_only_touch_do_not_conflict(topology):
    first = schedule(1, "V1", ("B1",), 0, (20,))
    second = schedule(2, "V2", ("B1",), 20, (20,))

    analysis = analyze_schedule((first, second), topology)

    assert ConflictType.BLOCK_OCCUPANCY not in conflict_types(analysis)


def test_interlocking_groups_are_left_to_write_validation(topology):
    # Different blocks in one group are rejected at create/update time, so the
    # Bonus analysis does not emit a second, redundant interlocking warning.
    first = schedule(1, "V1", ("B1",), 0, (20,))
    second = schedule(2, "V2", ("B2",), 10, (20,))

    analysis = analyze_schedule((first, second), topology)

    assert conflict_types(analysis) == []


def test_same_grouped_block_reports_one_block_conflict(topology):
    first = schedule(1, "V1", ("B1",), 0, (20,))
    second = schedule(2, "V2", ("B1",), 10, (20,))

    analysis = analyze_schedule((first, second), topology)

    assert conflict_types(analysis) == [ConflictType.BLOCK_OCCUPANCY]


def test_derives_block_consumption_and_yard_charging(topology):
    first = schedule(1, "V1", ("B1", "Y"), 0, (12, 0))
    second = schedule(2, "V1", ("Y", "B1"), 132, (0, 12))

    analysis = analyze_schedule((first, second), topology, vehicle_ids=("V1", "V2"))
    vehicle = next(item for item in analysis.vehicles if item.vehicle_id == "V1")

    assert [(segment.segment_type, segment.element_id) for segment in vehicle.segments] == [
        (SegmentType.SERVICE, "B1"),
        (SegmentType.SERVICE, "Y"),
        (SegmentType.IDLE, "Y"),
        (SegmentType.SERVICE, "Y"),
        (SegmentType.SERVICE, "B1"),
    ]
    assert vehicle.segments[0].battery_start == 80
    assert vehicle.segments[0].battery_end == 79
    assert vehicle.segments[2].battery_end == 89
    assert vehicle.segments[-1].battery_end == 88
    assert next(item for item in analysis.vehicles if item.vehicle_id == "V2").segments == ()


def test_yard_charging_is_fractional_and_capped_at_100(topology):
    first = schedule(1, "V1", ("B1", "Y"), 0, (12, 0))
    second = schedule(2, "V1", ("Y", "B1"), 18, (0, 12))
    third = schedule(3, "V1", ("B1", "Y"), 30, (12, 0))
    fourth = schedule(4, "V1", ("Y", "B1"), 312, (0, 12))

    analysis = analyze_schedule((first, second, third, fourth), topology)
    idle_segments = [
        segment for segment in analysis.vehicles[0].segments
        if segment.segment_type is SegmentType.IDLE
    ]

    assert idle_segments[0].battery_start == 79
    assert idle_segments[0].battery_end == 79.5
    assert idle_segments[-1].battery_end == 100


def test_battery_never_drops_below_zero(topology):
    blocks = tuple("B1" for _ in range(90))
    service = schedule(1, "V1", blocks, 0, tuple(1 for _ in blocks))

    analysis = analyze_schedule((service,), topology)

    assert analysis.vehicles[0].segments[-1].battery_end == 0


def test_reports_insufficient_charge_when_leaving_yard_below_80(topology):
    first = schedule(1, "V1", ("B1", "Y"), 0, (12, 0))
    second = schedule(2, "V1", ("Y", "B1"), 18, (0, 12))

    analysis = analyze_schedule((first, second), topology)

    conflict = next(item for item in analysis.conflicts if item.conflict_type is ConflictType.INSUFFICIENT_CHARGE)
    assert conflict.vehicle_ids == ("V1",)
    assert conflict.service_ids == (2,)
    assert conflict.start_time == BASE_TIME + timedelta(seconds=18)
    assert conflict.end_time == BASE_TIME + timedelta(seconds=30)


def test_reports_low_battery_from_threshold_crossing_until_yard(topology):
    blocks = tuple("B1" if index % 2 == 0 else "B3" for index in range(52))
    service = schedule(1, "V1", (*blocks, "P1", "Y"), 0, (*((10,) * 52), 20, 0))

    analysis = analyze_schedule((service,), topology)

    low = next(item for item in analysis.conflicts if item.conflict_type is ConflictType.LOW_BATTERY)
    assert low.start_time == BASE_TIME + timedelta(seconds=500, microseconds=1)
    assert low.end_time == BASE_TIME + timedelta(seconds=540)
    assert low.vehicle_ids == ("V1",)
    assert low.service_ids == (1,)
    assert {"B1", "B3", "P1"}.issubset(set(low.element_ids))


def test_battery_at_exactly_30_is_not_yet_a_low_battery_conflict(topology):
    blocks = tuple("B1" for _ in range(51))
    service = schedule(1, "V1", blocks, 0, tuple(10 for _ in blocks))

    analysis = analyze_schedule((service,), topology)
    low = next(item for item in analysis.conflicts if item.conflict_type is ConflictType.LOW_BATTERY)

    assert low.start_time == BASE_TIME + timedelta(seconds=500, microseconds=1)
    assert low.end_time == BASE_TIME + timedelta(seconds=510)


def test_empty_schedule_has_no_bounds_or_conflicts(topology):
    analysis = analyze_schedule((), topology, vehicle_ids=("V1", "V2"))

    assert analysis.start_time is None
    assert analysis.end_time is None
    assert analysis.conflicts == ()
    assert [vehicle.vehicle_id for vehicle in analysis.vehicles] == ["V1", "V2"]
