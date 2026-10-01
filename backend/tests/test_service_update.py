from dataclasses import replace

import pytest

from app.domain.vehicle_schedule import (
    ServiceScheduleError,
    VehicleLocationContinuityError,
    VehicleOverlapError,
    validate_service_update,
)
from test_vehicle_schedule import make_schedule


def chain():
    return (
        make_schedule(service_id=1, start_location="Y", end_location="P1A"),
        make_schedule(service_id=2, start_seconds=20, end_seconds=30),
        make_schedule(service_id=3, start_location="P2A", end_location="Y",
                      start_seconds=40, end_seconds=50),
    )


def test_update_in_place_preserves_bridge():
    services = chain()
    candidate = make_schedule(service_id=2, start_seconds=15, end_seconds=35)
    validate_service_update(services[1], candidate, services)


@pytest.mark.parametrize("vehicle", ["V1", "V2"])
def test_move_or_reassign_only_service(vehicle):
    target = make_schedule(service_id=1)
    candidate = make_schedule(service_id=1, vehicle_id=vehicle,
                              start_seconds=50, end_seconds=60)
    validate_service_update(target, candidate, [target])


@pytest.mark.parametrize("vehicle", ["V1", "V2"])
def test_move_or_reassign_rejects_broken_old_schedule(vehicle):
    services = chain()
    candidate = make_schedule(service_id=2, vehicle_id=vehicle,
                              start_seconds=60, end_seconds=70)
    with pytest.raises(VehicleLocationContinuityError):
        validate_service_update(services[1], candidate, services)


def test_reassignment_rejects_new_vehicle_overlap():
    target = make_schedule(service_id=1)
    other = make_schedule(service_id=2, vehicle_id="V2")
    with pytest.raises(VehicleOverlapError):
        validate_service_update(target, replace(target, vehicle_id="V2"), [target, other])


def test_unrelated_vehicle_is_not_revalidated():
    services = chain()
    unrelated = [make_schedule(service_id=4, vehicle_id="V3"),
                 make_schedule(service_id=5, vehicle_id="V3")]
    validate_service_update(services[1], services[1], [*services, *unrelated])


def test_update_requires_matching_persisted_identity():
    target = make_schedule(service_id=1)
    with pytest.raises(ServiceScheduleError):
        validate_service_update(target, replace(target, service_id=2), [target])


def test_reassign_preserves_continuous_old_and_new_schedules():
    first = make_schedule(service_id=1, end_location="P1A")
    target = make_schedule(service_id=2, start_location="P1A", end_location="P1A",
                           start_seconds=20, end_seconds=30)
    last = make_schedule(service_id=3, start_seconds=40, end_seconds=50)
    new_first = make_schedule(service_id=4, vehicle_id="V2", end_location="P1A")
    new_last = make_schedule(service_id=5, vehicle_id="V2", start_seconds=40, end_seconds=50)
    validate_service_update(target, replace(target, vehicle_id="V2"),
                            [first, target, last, new_first, new_last])


def test_zero_duration_update_uses_existing_neighbor_selection():
    target = make_schedule(service_id=1, start_location="Y", end_location="Y",
                           start_seconds=10, end_seconds=10)
    neighbor = make_schedule(service_id=2, start_location="Y", end_location="Y",
                             start_seconds=10, end_seconds=10)
    validate_service_update(target, target, [target, neighbor])
