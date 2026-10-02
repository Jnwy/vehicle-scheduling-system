import pytest

from app.domain.path_validation import (
    MissingTrackConnectionError,
    PathEndpointOnBlockError,
    PathTooLongError,
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
    assert validate_path(["P1A", "B3", "B5", "P2A"], topology) is None


def test_rejects_path_ending_on_block(topology):
    with pytest.raises(PathEndpointOnBlockError) as exc_info:
        validate_path(["P1A", "B3", "B5"], topology)

    assert exc_info.value.element_id == "B5"
    assert exc_info.value.path_index == 2


def test_rejects_path_starting_on_block(topology):
    with pytest.raises(PathEndpointOnBlockError) as exc_info:
        validate_path(["B1", "P1A"], topology)

    assert exc_info.value.element_id == "B1"
    assert exc_info.value.path_index == 0


def test_accepts_path_between_yard_and_yard(topology):
    assert validate_path(["Y", "B1", "Y"], topology) is None


def test_reports_missing_connection_before_block_endpoint(topology):
    with pytest.raises(MissingTrackConnectionError):
        validate_path(["P1A", "B5"], topology)


def test_accepts_mixed_yard_platform_block_path(topology):
    assert validate_path(["Y", "B1", "P1A"], topology) is None


def test_accepts_repeated_elements_when_each_step_is_connected(topology):
    assert validate_path(["Y", "B1", "Y", "B1", "P1A"], topology) is None


def test_accepts_path_at_maximum_length(topology):
    path = ["Y", "B1"] * 98 + ["P1A", "B3", "B5", "P2A"]

    assert len(path) == PathTooLongError.maximum_length == 200
    assert validate_path(path, topology) is None


def test_rejects_path_over_maximum_length(topology):
    path = ["Y", "B1"] * 100 + ["Y"]

    with pytest.raises(PathTooLongError) as exc_info:
        validate_path(path, topology)

    assert exc_info.value.actual_length == 201
    assert "at most 200" in str(exc_info.value)


def test_reports_length_before_inspecting_elements(topology):
    with pytest.raises(PathTooLongError):
        validate_path(["UNKNOWN"] * 201, topology)
