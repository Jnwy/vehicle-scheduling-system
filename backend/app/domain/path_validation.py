from dataclasses import dataclass
from enum import StrEnum
from typing import Sequence

from app.domain.models import RailwayTopology


class PathValidationErrorCode(StrEnum):
    PATH_TOO_SHORT = "PATH_TOO_SHORT"
    UNKNOWN_ELEMENT = "UNKNOWN_ELEMENT"
    MISSING_CONNECTION = "MISSING_CONNECTION"


@dataclass(frozen=True)
class PathValidationError:
    code: PathValidationErrorCode
    message: str
    element_id: str | None = None
    from_element_id: str | None = None
    to_element_id: str | None = None


@dataclass(frozen=True)
class PathValidationResult:
    is_valid: bool
    errors: tuple[PathValidationError, ...] = ()


def validate_path(
    path: Sequence[str],
    topology: RailwayTopology,
) -> PathValidationResult:
    errors: list[PathValidationError] = []

    if len(path) < 2:
        errors.append(
            PathValidationError(
                code=PathValidationErrorCode.PATH_TOO_SHORT,
                message="A service path must contain at least two track elements.",
            )
        )

    for element_id in path:
        if not topology.has_element(element_id):
            errors.append(
                PathValidationError(
                    code=PathValidationErrorCode.UNKNOWN_ELEMENT,
                    message=f"Track element '{element_id}' does not exist.",
                    element_id=element_id,
                )
            )

    if errors:
        return PathValidationResult(is_valid=False, errors=tuple(errors))

    for from_element_id, to_element_id in zip(path, path[1:]):
        if not topology.has_connection(from_element_id, to_element_id):
            errors.append(
                PathValidationError(
                    code=PathValidationErrorCode.MISSING_CONNECTION,
                    message=(
                        f"No directed connection exists from '{from_element_id}' "
                        f"to '{to_element_id}'."
                    ),
                    from_element_id=from_element_id,
                    to_element_id=to_element_id,
                )
            )

    return PathValidationResult(is_valid=not errors, errors=tuple(errors))
