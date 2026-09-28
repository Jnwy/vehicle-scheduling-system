from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Sequence

from app.domain.models import RailwayTopology, TrackElement, TrackElementType


class TimelineConfigurationError(ValueError):
    def __init__(self, element_id: str, configuration_name: str) -> None:
        self.element_id = element_id
        self.configuration_name = configuration_name
        super().__init__(
            f"Track element '{element_id}' requires a non-negative "
            f"'{configuration_name}' value."
        )


class PlatformTimingError(ValueError):
    def __init__(self, path_index: int, message: str) -> None:
        self.path_index = path_index
        super().__init__(message)


@dataclass(frozen=True)
class PlatformTiming:
    path_index: int
    arrival_time: datetime
    departure_time: datetime


@dataclass(frozen=True)
class TimelineInterval:
    element_id: str
    start_time: datetime
    end_time: datetime

    def contains(self, instant: datetime) -> bool:
        return self.start_time <= instant < self.end_time


def calculate_timeline(
    path: Sequence[str],
    start_time: datetime,
    topology: RailwayTopology,
    platform_timings: Sequence[PlatformTiming] = (),
) -> tuple[TimelineInterval, ...]:
    timings_by_path_index = _index_platform_timings(
        path,
        topology,
        platform_timings,
    )
    intervals: list[TimelineInterval] = []
    current_time = start_time

    for path_index, element_id in enumerate(path):
        element = topology.elements[element_id]

        if element.element_type is TrackElementType.BLOCK:
            interval = _block_interval(element, current_time)
        elif element.element_type is TrackElementType.PLATFORM:
            interval = _platform_interval(
                element,
                path_index,
                current_time,
                timings_by_path_index,
            )
        else:
            interval = TimelineInterval(
                element_id=element.id,
                start_time=current_time,
                end_time=current_time,
            )

        intervals.append(interval)
        current_time = interval.end_time

    return tuple(intervals)


def _index_platform_timings(
    path: Sequence[str],
    topology: RailwayTopology,
    platform_timings: Sequence[PlatformTiming],
) -> dict[int, PlatformTiming]:
    timings_by_path_index: dict[int, PlatformTiming] = {}

    for timing in platform_timings:
        if timing.path_index in timings_by_path_index:
            raise PlatformTimingError(
                timing.path_index,
                f"Path index {timing.path_index} has duplicate platform timing.",
            )

        if timing.path_index < 0 or timing.path_index >= len(path):
            raise PlatformTimingError(
                timing.path_index,
                f"Platform timing path index {timing.path_index} is outside the path.",
            )

        element = topology.elements[path[timing.path_index]]
        if element.element_type is not TrackElementType.PLATFORM:
            raise PlatformTimingError(
                timing.path_index,
                f"Track element '{element.id}' at path index {timing.path_index} "
                "is not a platform.",
            )

        _require_comparable_datetimes(
            timing.path_index,
            timing.arrival_time,
            timing.departure_time,
        )
        if timing.departure_time < timing.arrival_time:
            raise PlatformTimingError(
                timing.path_index,
                f"Platform departure at path index {timing.path_index} "
                "cannot be earlier than arrival.",
            )

        timings_by_path_index[timing.path_index] = timing

    return timings_by_path_index


def _block_interval(
    element: TrackElement,
    start_time: datetime,
) -> TimelineInterval:
    traversal_seconds = element.traversal_seconds
    if traversal_seconds is None or traversal_seconds < 0:
        raise TimelineConfigurationError(element.id, "traversal_seconds")

    return TimelineInterval(
        element_id=element.id,
        start_time=start_time,
        end_time=start_time + timedelta(seconds=traversal_seconds),
    )


def _platform_interval(
    element: TrackElement,
    path_index: int,
    expected_arrival_time: datetime,
    timings_by_path_index: dict[int, PlatformTiming],
) -> TimelineInterval:
    timing = timings_by_path_index.get(path_index)
    if timing is None:
        raise PlatformTimingError(
            path_index,
            f"Platform '{element.id}' at path index {path_index} requires timing.",
        )

    _require_comparable_datetimes(
        path_index,
        expected_arrival_time,
        timing.arrival_time,
    )
    if timing.arrival_time != expected_arrival_time:
        raise PlatformTimingError(
            path_index,
            f"Platform '{element.id}' arrival at path index {path_index} must be "
            f"{expected_arrival_time.isoformat()}, received "
            f"{timing.arrival_time.isoformat()}.",
        )

    return TimelineInterval(
        element_id=element.id,
        start_time=timing.arrival_time,
        end_time=timing.departure_time,
    )


def _require_comparable_datetimes(
    path_index: int,
    first: datetime,
    second: datetime,
) -> None:
    try:
        _ = first <= second
    except TypeError as error:
        raise PlatformTimingError(
            path_index,
            f"Platform timing at path index {path_index} contains "
            "incomparable datetime values.",
        ) from error
