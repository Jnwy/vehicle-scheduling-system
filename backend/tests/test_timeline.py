from datetime import datetime, timedelta, timezone

import pytest

from app.domain.models import RailwayTopology, TrackElement, TrackElementType
from app.domain.timeline import (
    PlatformTiming,
    PlatformTimingError,
    TimelineConfigurationError,
    calculate_timeline,
)
from app.domain.topology import assignment_topology


@pytest.fixture
def start_time():
    return datetime(2026, 9, 28, 8, 0, tzinfo=timezone.utc)


@pytest.fixture
def topology():
    elements = {
        "Y": TrackElement(id="Y", element_type=TrackElementType.YARD),
        "B1": TrackElement(
            id="B1",
            element_type=TrackElementType.BLOCK,
            traversal_seconds=20,
        ),
        "P1A": TrackElement(id="P1A", element_type=TrackElementType.PLATFORM),
        "B2": TrackElement(
            id="B2",
            element_type=TrackElementType.BLOCK,
            traversal_seconds=15,
        ),
    }
    return RailwayTopology(elements=elements, connections=frozenset())


def platform_timing(path_index, start_time, arrival_seconds, departure_seconds):
    return PlatformTiming(
        path_index=path_index,
        arrival_time=start_time + timedelta(seconds=arrival_seconds),
        departure_time=start_time + timedelta(seconds=departure_seconds),
    )


def test_assignment_topology_has_no_assumed_block_traversal_time():
    topology = assignment_topology()
    block_elements = (
        element
        for element in topology.elements.values()
        if element.element_type is TrackElementType.BLOCK
    )

    assert all(element.traversal_seconds is None for element in block_elements)


def test_calculates_single_block_traversal(topology, start_time):
    timeline = calculate_timeline(["B1"], start_time, topology)

    assert timeline[0].element_id == "B1"
    assert timeline[0].start_time == start_time
    assert timeline[0].end_time == start_time + timedelta(seconds=20)


def test_calculates_block_followed_by_platform(topology, start_time):
    timing = platform_timing(1, start_time, 20, 50)

    timeline = calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert timeline[0].end_time == timing.arrival_time
    assert timeline[1].start_time == timing.arrival_time
    assert timeline[1].end_time == timing.departure_time


def test_accumulates_multiple_sequential_elements(topology, start_time):
    timing = platform_timing(1, start_time, 20, 50)

    timeline = calculate_timeline(
        ["B1", "P1A", "B2"],
        start_time,
        topology,
        [timing],
    )

    assert [interval.start_time for interval in timeline] == [
        start_time,
        start_time + timedelta(seconds=20),
        start_time + timedelta(seconds=50),
    ]
    assert [interval.end_time for interval in timeline] == [
        start_time + timedelta(seconds=20),
        start_time + timedelta(seconds=50),
        start_time + timedelta(seconds=65),
    ]


def test_yard_has_zero_duration(topology, start_time):
    timeline = calculate_timeline(["Y", "B1"], start_time, topology)

    assert timeline[0].start_time == start_time
    assert timeline[0].end_time == start_time
    assert timeline[1].start_time == start_time


def test_final_end_time_equals_accumulated_durations(topology, start_time):
    timing = platform_timing(2, start_time, 20, 50)

    timeline = calculate_timeline(
        ["Y", "B1", "P1A", "B2"],
        start_time,
        topology,
        [timing],
    )

    assert timeline[-1].end_time == start_time + timedelta(seconds=65)


def test_calculation_is_deterministic(topology, start_time):
    path = ["Y", "B1", "P1A", "B2"]
    timings = [platform_timing(2, start_time, 20, 50)]

    assert calculate_timeline(
        path,
        start_time,
        topology,
        timings,
    ) == calculate_timeline(path, start_time, topology, timings)


def test_interval_uses_half_open_semantics(topology, start_time):
    interval = calculate_timeline(["B1"], start_time, topology)[0]

    assert interval.contains(start_time)
    assert interval.contains(interval.end_time - timedelta(microseconds=1))
    assert not interval.contains(interval.end_time)


def test_repeated_platforms_use_path_index(topology, start_time):
    timings = [
        platform_timing(0, start_time, 0, 10),
        platform_timing(2, start_time, 30, 40),
    ]

    timeline = calculate_timeline(
        ["P1A", "B1", "P1A"],
        start_time,
        topology,
        timings,
    )

    assert timeline[0].end_time == start_time + timedelta(seconds=10)
    assert timeline[2].start_time == start_time + timedelta(seconds=30)
    assert timeline[2].end_time == start_time + timedelta(seconds=40)


def test_rejects_missing_platform_timing(topology, start_time):
    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology)

    assert exc_info.value.path_index == 1


def test_rejects_platform_arrival_that_breaks_accumulation(topology, start_time):
    timing = platform_timing(1, start_time, 21, 50)

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert exc_info.value.path_index == 1


def test_rejects_departure_before_arrival(topology, start_time):
    timing = platform_timing(1, start_time, 20, 19)

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert exc_info.value.path_index == 1


def test_allows_zero_platform_dwell_time(topology, start_time):
    timing = platform_timing(1, start_time, 20, 20)

    timeline = calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert timeline[1].start_time == timeline[1].end_time


def test_rejects_duplicate_platform_timing(topology, start_time):
    timing = platform_timing(1, start_time, 20, 50)

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(
            ["B1", "P1A"],
            start_time,
            topology,
            [timing, timing],
        )

    assert exc_info.value.path_index == 1


def test_rejects_platform_timing_for_non_platform(topology, start_time):
    timing = platform_timing(0, start_time, 0, 20)

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert exc_info.value.path_index == 0


def test_rejects_platform_timing_outside_path(topology, start_time):
    timing = platform_timing(2, start_time, 20, 50)

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert exc_info.value.path_index == 2


def test_rejects_incomparable_platform_datetimes(topology, start_time):
    timing = PlatformTiming(
        path_index=1,
        arrival_time=start_time + timedelta(seconds=20),
        departure_time=datetime(2026, 9, 28, 8, 0, 50),
    )

    with pytest.raises(PlatformTimingError) as exc_info:
        calculate_timeline(["B1", "P1A"], start_time, topology, [timing])

    assert exc_info.value.path_index == 1


@pytest.mark.parametrize("traversal_seconds", [None, -1])
def test_rejects_invalid_block_traversal_time(traversal_seconds, start_time):
    block = TrackElement(
        id="B1",
        element_type=TrackElementType.BLOCK,
        traversal_seconds=traversal_seconds,
    )
    topology = RailwayTopology(elements={block.id: block}, connections=frozenset())

    with pytest.raises(TimelineConfigurationError) as exc_info:
        calculate_timeline([block.id], start_time, topology)

    assert exc_info.value.element_id == block.id
    assert exc_info.value.configuration_name == "traversal_seconds"
