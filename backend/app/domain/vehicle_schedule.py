from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Iterable, Sequence

from app.domain.timeline import TimelineInterval


class ServiceScheduleError(ValueError):
    def __init__(self, message: str, path_index: int | None = None) -> None:
        self.path_index = path_index
        super().__init__(message)


class VehicleScheduleError(ValueError):
    pass


def service_label(service_id: int | None, *, sentence_start: bool = False) -> str:
    # A candidate has no ID until it is persisted; messages are shown to users.
    label = "the new service" if service_id is None else f"service {service_id}"
    return label[0].upper() + label[1:] if sentence_start else label


class VehicleOverlapError(VehicleScheduleError):
    def __init__(
        self,
        candidate_service_id: int | None,
        conflicting_service_id: int | None,
    ) -> None:
        self.candidate_service_id = candidate_service_id
        self.conflicting_service_id = conflicting_service_id
        super().__init__(
            f"{service_label(candidate_service_id, sentence_start=True)} overlaps "
            f"{service_label(conflicting_service_id)} assigned to the same vehicle."
        )


class VehicleLocationContinuityError(VehicleScheduleError):
    def __init__(
        self,
        from_service_id: int | None,
        to_service_id: int | None,
        from_location: str,
        to_location: str,
    ) -> None:
        self.from_service_id = from_service_id
        self.to_service_id = to_service_id
        self.from_location = from_location
        self.to_location = to_location
        super().__init__(
            f"Vehicle cannot continue from {service_label(from_service_id)} at "
            f"'{from_location}' to {service_label(to_service_id)} at '{to_location}'."
        )


class IncomparableScheduleTimeError(VehicleScheduleError):
    def __init__(self) -> None:
        super().__init__(
            "Vehicle schedule contains datetime values that cannot be compared."
        )


class ResourceType(StrEnum):
    VEHICLE = "VEHICLE"
    INTERLOCKING = "INTERLOCKING"


@dataclass(frozen=True)
class ServiceSchedule:
    service_id: int | None
    vehicle_id: str
    path: tuple[str, ...]
    timeline: tuple[TimelineInterval, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", tuple(self.path))
        object.__setattr__(self, "timeline", tuple(self.timeline))

        if not self.path or not self.timeline:
            raise ServiceScheduleError("Service path and timeline must not be empty.")

        if len(self.path) != len(self.timeline):
            raise ServiceScheduleError(
                "Service path and timeline must contain the same number of elements."
            )

        for path_index, (element_id, interval) in enumerate(
            zip(self.path, self.timeline, strict=True)
        ):
            if interval.element_id != element_id:
                raise ServiceScheduleError(
                    f"Timeline element '{interval.element_id}' at path index "
                    f"{path_index} does not match path element '{element_id}'.",
                    path_index=path_index,
                )

    @property
    def start_time(self) -> datetime:
        return self.timeline[0].start_time

    @property
    def end_time(self) -> datetime:
        return self.timeline[-1].end_time

    @property
    def start_location(self) -> str:
        return self.path[0]

    @property
    def end_location(self) -> str:
        return self.path[-1]


@dataclass(frozen=True)
class ResourceOccupancy:
    resource_type: ResourceType
    resource_id: str
    start_time: datetime
    end_time: datetime
    service_id: int | None


def vehicle_occupancy(schedule: ServiceSchedule) -> ResourceOccupancy:
    return ResourceOccupancy(
        resource_type=ResourceType.VEHICLE,
        resource_id=schedule.vehicle_id,
        start_time=schedule.start_time,
        end_time=schedule.end_time,
        service_id=schedule.service_id,
    )


def occupancies_overlap(
    first: ResourceOccupancy,
    second: ResourceOccupancy,
) -> bool:
    if first.start_time == first.end_time or second.start_time == second.end_time:
        return False

    return first.start_time < second.end_time and second.start_time < first.end_time


def validate_vehicle_schedule(
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
) -> None:
    same_vehicle_services = tuple(
        service
        for service in existing_services
        if service.vehicle_id == candidate.vehicle_id
        and not (
            candidate.service_id is not None
            and service.service_id == candidate.service_id
        )
    )

    try:
        _validate_vehicle_schedule(candidate, same_vehicle_services)
    except TypeError as error:
        raise IncomparableScheduleTimeError() from error


def validate_service_update(
    target: ServiceSchedule,
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
) -> None:
    if target.service_id is None or candidate.service_id != target.service_id:
        raise ServiceScheduleError("An update must retain the target service ID.")

    # Replace in place to retain the existing tie behavior for equal times.
    final_services = tuple(
        candidate if service.service_id == target.service_id else service
        for service in existing_services
    )
    validate_vehicle_schedule(candidate, final_services)
    for service in final_services:
        if service.vehicle_id in (target.vehicle_id, candidate.vehicle_id):
            validate_vehicle_schedule(service, final_services)


def validate_service_deletion(
    target: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
) -> None:
    if target.service_id is None:
        raise ServiceScheduleError("A service to delete must have an ID.")

    remaining_services = tuple(
        service for service in existing_services
        if service.vehicle_id == target.vehicle_id
        and service.service_id != target.service_id
    )
    try:
        predecessor = max(
            (service for service in remaining_services
             if service.end_time <= target.start_time),
            key=lambda service: service.end_time,
            default=None,
        )
        successor = min(
            (service for service in remaining_services
             if service.start_time >= target.end_time),
            key=lambda service: service.start_time,
            default=None,
        )
    except TypeError as error:
        raise IncomparableScheduleTimeError() from error

    if (
        predecessor is not None
        and successor is not None
        and predecessor.end_location != successor.start_location
    ):
        raise VehicleLocationContinuityError(
            predecessor.service_id,
            successor.service_id,
            predecessor.end_location,
            successor.start_location,
        )


def _validate_vehicle_schedule(
    candidate: ServiceSchedule,
    existing_services: Sequence[ServiceSchedule],
) -> None:
    candidate_occupancy = vehicle_occupancy(candidate)

    for existing in existing_services:
        if occupancies_overlap(candidate_occupancy, vehicle_occupancy(existing)):
            raise VehicleOverlapError(
                candidate.service_id,
                existing.service_id,
            )

    predecessor = max(
        (
            service
            for service in existing_services
            if service.end_time <= candidate.start_time
        ),
        key=lambda service: service.end_time,
        default=None,
    )
    successor = min(
        (
            service
            for service in existing_services
            if service.start_time >= candidate.end_time
        ),
        key=lambda service: service.start_time,
        default=None,
    )

    if (
        predecessor is not None
        and predecessor.end_location != candidate.start_location
    ):
        raise VehicleLocationContinuityError(
            predecessor.service_id,
            candidate.service_id,
            predecessor.end_location,
            candidate.start_location,
        )

    if successor is not None and candidate.end_location != successor.start_location:
        raise VehicleLocationContinuityError(
            candidate.service_id,
            successor.service_id,
            candidate.end_location,
            successor.start_location,
        )
