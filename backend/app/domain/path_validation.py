from typing import Sequence

from app.domain.models import RailwayTopology, TrackElementType


class PathValidationError(ValueError):
    """Base exception for invalid user-provided service paths."""


class PathTooShortError(PathValidationError):
    minimum_length = 2

    def __init__(self, actual_length: int) -> None:
        self.actual_length = actual_length
        super().__init__(
            "A service path must contain at least "
            f"{self.minimum_length} track elements; received {actual_length}."
        )


class PathTooLongError(PathValidationError):
    # A path may repeat elements, so it has no natural end. Unbounded paths
    # make every later validation and the schedule analysis slower for all users.
    maximum_length = 200

    def __init__(self, actual_length: int) -> None:
        self.actual_length = actual_length
        super().__init__(
            "A service path must contain at most "
            f"{self.maximum_length} track elements; received {actual_length}."
        )


class UnknownTrackElementError(PathValidationError):
    def __init__(self, element_id: str) -> None:
        self.element_id = element_id
        super().__init__(f"Track element '{element_id}' does not exist.")


class MissingTrackConnectionError(PathValidationError):
    def __init__(self, from_element_id: str, to_element_id: str) -> None:
        self.from_element_id = from_element_id
        self.to_element_id = to_element_id
        super().__init__(
            f"No directed connection exists from '{from_element_id}' "
            f"to '{to_element_id}'."
        )


class PathEndpointOnBlockError(PathValidationError):
    def __init__(self, element_id: str, path_index: int) -> None:
        self.element_id = element_id
        self.path_index = path_index
        super().__init__(
            "A service path must start and end at a platform or yard; "
            f"'{element_id}' at path index {path_index} is a block."
        )


def validate_path(
    path: Sequence[str],
    topology: RailwayTopology,
) -> None:
    if len(path) < 2:
        raise PathTooShortError(actual_length=len(path))

    if len(path) > PathTooLongError.maximum_length:
        raise PathTooLongError(actual_length=len(path))

    for element_id in path:
        if not topology.has_element(element_id):
            raise UnknownTrackElementError(element_id=element_id)

    for from_element_id, to_element_id in zip(path, path[1:]):
        if not topology.has_connection(from_element_id, to_element_id):
            raise MissingTrackConnectionError(
                from_element_id=from_element_id,
                to_element_id=to_element_id,
            )

    # A vehicle waits at a service's first and last element outside the
    # service, but block occupancy only covers traversal, so a vehicle parked
    # on a block would be invisible to block and interlocking checks.
    for path_index in (0, len(path) - 1):
        element_id = path[path_index]
        if topology.elements[element_id].element_type is TrackElementType.BLOCK:
            raise PathEndpointOnBlockError(element_id, path_index)
