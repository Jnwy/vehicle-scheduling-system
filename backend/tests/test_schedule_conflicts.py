from datetime import datetime, timedelta, timezone

import pytest

from app.domain.schedule_analysis import ConflictType
from app.domain.schedule_conflicts import (
    BatteryConflictError,
    BlockOccupancyConflictError,
    validate_battery,
    validate_block_occupancy,
)
from app.domain.timeline import TimelineInterval
from app.domain.topology import assignment_topology
from app.domain.vehicle_schedule import ServiceSchedule


BASE_TIME = datetime(2026, 10, 2, 8, tzinfo=timezone.utc)
TOPOLOGY = assignment_topology()


def schedule(elements, *, start=0, seconds=10, vehicle="V1", service_id=1):
    """Every block takes `seconds`; yards and platforms take no time."""
    current = BASE_TIME + timedelta(seconds=start)
    timeline = []
    for element_id in elements:
        end = current + timedelta(seconds=seconds if element_id.startswith("B") else 0)
        timeline.append(TimelineInterval(element_id, current, end))
        current = end
    return ServiceSchedule(service_id, vehicle, tuple(elements), tuple(timeline))


def laps(count, start="P1A"):
    return (start, "B1") * count + ("P1A",)


def test_block_occupancy_rejects_another_vehicle_on_the_same_ungrouped_block():
    existing = schedule(("B5",))
    candidate = schedule(("B5",), start=5, vehicle="V2", service_id=None)

    with pytest.raises(BlockOccupancyConflictError) as error:
        validate_block_occupancy(candidate, [existing], TOPOLOGY)

    assert error.value.block_id == "B5"
    assert error.value.conflicting_service_id == 1
    assert "The new service" in str(error.value)


@pytest.mark.parametrize(("start", "seconds"), [(10, 10), (-10, 10), (5, 0)])
def test_block_occupancy_allows_touching_and_empty_intervals(start, seconds):
    existing = schedule(("B5",))
    candidate = schedule(("B5",), start=start, seconds=seconds, vehicle="V2", service_id=None)

    validate_block_occupancy(candidate, [existing], TOPOLOGY)


def test_block_occupancy_ignores_other_blocks_platforms_and_the_same_vehicle():
    existing = schedule(("P2A", "B6"))

    validate_block_occupancy(schedule(("B5",), vehicle="V2", service_id=None), [existing], TOPOLOGY)
    validate_block_occupancy(schedule(("P2A", "B6"), service_id=None), [existing], TOPOLOGY)
    # Two vehicles may stand at the same platform.
    validate_block_occupancy(schedule(("P2A",), vehicle="V2", service_id=None), [existing], TOPOLOGY)


def test_block_occupancy_update_excludes_the_original_service():
    existing = schedule(("B5",), vehicle="V1", service_id=7)
    other_vehicle_update = schedule(("B5",), start=5, vehicle="V2", service_id=7)

    validate_block_occupancy(other_vehicle_update, [existing], TOPOLOGY)


def test_battery_rejects_leaving_the_yard_below_80():
    existing = schedule(("Y", "B1", "Y"))
    # 79 units after one block, and 11 seconds charge less than one unit.
    candidate = schedule(("Y", "B1", "Y"), start=21, service_id=None)

    with pytest.raises(BatteryConflictError) as error:
        validate_battery(candidate, [existing], TOPOLOGY)

    assert error.value.conflict_type == ConflictType.INSUFFICIENT_CHARGE.value
    assert error.value.vehicle_id == "V1"


def test_battery_allows_leaving_the_yard_once_charged_to_80():
    existing = schedule(("Y", "B1", "Y"))

    validate_battery(schedule(("Y", "B1", "Y"), start=22, service_id=None), [existing], TOPOLOGY)


def test_battery_rejects_passing_through_the_yard_below_80():
    # Yard duration is zero, so a path through the yard cannot charge there.
    candidate = schedule(("P1A", "B1", "Y", "B2", "P1B"), service_id=None)

    with pytest.raises(BatteryConflictError) as error:
        validate_battery(candidate, [], TOPOLOGY)

    assert error.value.conflict_type == ConflictType.INSUFFICIENT_CHARGE.value


def test_battery_at_exactly_30_is_allowed_and_one_block_more_is_low():
    validate_battery(schedule(laps(50), service_id=None), [], TOPOLOGY)

    with pytest.raises(BatteryConflictError) as error:
        validate_battery(schedule(laps(51), service_id=None), [], TOPOLOGY)

    assert error.value.conflict_type == ConflictType.LOW_BATTERY.value


def test_low_battery_on_the_way_to_the_yard_is_allowed():
    # At exactly 30 every further block is low, including the one home.
    at_threshold = schedule(laps(50))

    validate_battery(schedule(("P1A", "B1", "Y"), start=1000, service_id=None), [at_threshold], TOPOLOGY)
    validate_battery(schedule(laps(55)[:-1] + ("P1A", "B1", "Y"), service_id=None), [], TOPOLOGY)
    with pytest.raises(BatteryConflictError):
        validate_battery(schedule(("P1A", "B1", "P1A"), start=1000, service_id=None), [at_threshold], TOPOLOGY)


def test_running_out_of_battery_before_the_yard_is_rejected():
    def home_after(blocks):
        return schedule(("P1A", "B1") * (blocks - 1) + ("P1A", "B1", "Y"), service_id=None)

    # 80 blocks arrive in the yard with exactly nothing left.
    validate_battery(home_after(80), [], TOPOLOGY)
    with pytest.raises(BatteryConflictError) as error:
        validate_battery(home_after(81), [], TOPOLOGY)

    assert error.value.conflict_type == "EMPTY_BATTERY"
    assert "run out of battery" in str(error.value)


def test_ending_in_the_yard_does_not_excuse_leaving_it_uncharged_afterwards():
    later = schedule(("Y", "B1", "P1A"), start=1000)
    home = schedule(("P1A", "B1", "Y"), start=990, service_id=None)

    with pytest.raises(BatteryConflictError) as error:
        validate_battery(home, [later], TOPOLOGY)

    assert error.value.conflict_type == ConflictType.INSUFFICIENT_CHARGE.value


def test_battery_rejects_a_service_inserted_before_others_that_drains_them():
    later = schedule(laps(50), start=1000)
    earlier = schedule(("P1A", "B1", "P1A"), service_id=None)

    with pytest.raises(BatteryConflictError):
        validate_battery(earlier, [later], TOPOLOGY)


def test_battery_checks_only_the_vehicles_the_write_touches():
    saved_low = schedule(laps(51), vehicle="V2", service_id=2)

    validate_battery(schedule(("Y", "B1", "P1A"), service_id=None), [saved_low], TOPOLOGY)


def test_battery_conflict_saved_before_the_rule_does_not_block_the_way_home():
    saved_low = schedule(laps(51))
    home = schedule(("P1A", "B1", "Y"), start=1000, service_id=None)

    validate_battery(home, [saved_low], TOPOLOGY)


def test_battery_update_replaces_the_original_instead_of_adding_to_it():
    original = schedule(laps(50), service_id=4)

    validate_battery(schedule(laps(50), start=5, service_id=4), [original], TOPOLOGY, original)
    with pytest.raises(BatteryConflictError):
        validate_battery(schedule(laps(51), service_id=4), [original], TOPOLOGY, original)
