import pytest

from app.domain.path_validation import PathValidationErrorCode, validate_path
from app.domain.topology import assignment_topology


@pytest.fixture
def topology():
    return assignment_topology()


def error_codes(result):
    return [error.code for error in result.errors]


def test_accepts_valid_directed_path_with_block_to_block_connection(topology):
    result = validate_path(["Y", "B1", "P1A", "B3", "B5", "P2A"], topology)

    assert result.is_valid
    assert result.errors == ()


@pytest.mark.parametrize("path", [[], ["B1"]])
def test_rejects_path_with_fewer_than_two_elements(path, topology):
    result = validate_path(path, topology)

    assert not result.is_valid
    assert PathValidationErrorCode.PATH_TOO_SHORT in error_codes(result)


def test_rejects_unknown_track_element(topology):
    result = validate_path(["P1A", "B999"], topology)

    assert not result.is_valid
    assert result.errors[0].code == PathValidationErrorCode.UNKNOWN_ELEMENT
    assert result.errors[0].element_id == "B999"


def test_rejects_missing_directed_connection(topology):
    result = validate_path(["P1A", "P2A"], topology)

    assert not result.is_valid
    assert result.errors[0].code == PathValidationErrorCode.MISSING_CONNECTION
    assert result.errors[0].from_element_id == "P1A"
    assert result.errors[0].to_element_id == "P2A"


def test_does_not_infer_reverse_connection(topology):
    result = validate_path(["P2A", "B5", "B3", "P1A"], topology)

    assert not result.is_valid
    assert result.errors[0].code == PathValidationErrorCode.MISSING_CONNECTION
    assert result.errors[0].from_element_id == "P2A"
    assert result.errors[0].to_element_id == "B5"


def test_allows_platform_start_when_connections_are_valid(topology):
    result = validate_path(["P1A", "B3", "B5"], topology)

    assert result.is_valid


def test_allows_repeated_elements_when_each_step_is_connected(topology):
    result = validate_path(["Y", "B1", "Y", "B1", "P1A"], topology)

    assert result.is_valid
