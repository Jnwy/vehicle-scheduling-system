import pytest

from app.domain.path_validation import (
    MissingTrackConnectionError,
    PathTooShortError,
    UnknownTrackElementError,
    validate_path,
)
from app.domain.topology import assignment_topology


@pytest.fixture
def topology():
    return assignment_topology()


def test_accepts_valid_path(topology):
    assert validate_path(["P1A", "B3", "B5", "P2A"], topology) is None


def test_rejects_empty_path(topology):
    with pytest.raises(PathTooShortError) as exc_info:
        validate_path([], topology)

    assert exc_info.value.actual_length == 0


def test_rejects_single_element_path(topology):
    with pytest.raises(PathTooShortError) as exc_info:
        validate_path(["B1"], topology)

    assert exc_info.value.actual_length == 1


def test_rejects_unknown_track_element(topology):
    with pytest.raises(UnknownTrackElementError) as exc_info:
        validate_path(["P1A", "B999"], topology)

    assert exc_info.value.element_id == "B999"


def test_rejects_missing_connection(topology):
    with pytest.raises(MissingTrackConnectionError) as exc_info:
        validate_path(["P1A", "P2A"], topology)

    assert exc_info.value.from_element_id == "P1A"
    assert exc_info.value.to_element_id == "P2A"


def test_rejects_reverse_direction(topology):
    with pytest.raises(MissingTrackConnectionError) as exc_info:
        validate_path(["P2A", "B5"], topology)

    assert exc_info.value.from_element_id == "P2A"
    assert exc_info.value.to_element_id == "B5"


def test_accepts_block_to_block_connection(topology):
    assert validate_path(["B3", "B5"], topology) is None


def test_accepts_mixed_yard_platform_block_path(topology):
    assert validate_path(["Y", "B1", "P1A"], topology) is None


def test_accepts_repeated_elements_when_each_step_is_connected(topology):
    assert validate_path(["Y", "B1", "Y", "B1", "P1A"], topology) is None
