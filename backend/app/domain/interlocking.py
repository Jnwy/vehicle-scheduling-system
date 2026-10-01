from typing import Iterable, Iterator

from app.domain.models import RailwayTopology, TrackElementType
from app.domain.vehicle_schedule import (
    ResourceOccupancy,
    ResourceType,
    ServiceSchedule,
    occupancies_overlap,
    service_label,
)


class InterlockingConflictError(ValueError):
    def __init__(
        self,
        interlocking_group: str,
        candidate_service_id: int | None,
        conflicting_service_id: int | None,
    ) -> None:
        self.interlocking_group = interlocking_group
        self.candidate_service_id = candidate_service_id
        self.conflicting_service_id = conflicting_service_id
        super().__init__(
            f"{service_label(candidate_service_id, sentence_start=True)} conflicts "
            f"with {service_label(conflicting_service_id)} in interlocking group "
            f"'{interlocking_group}'."
        )


def interlocking_occupancies(
    schedule: ServiceSchedule, topology: RailwayTopology,
) -> Iterator[ResourceOccupancy]:
    for interval in schedule.timeline:
        element = topology.elements[interval.element_id]
        if element.element_type == TrackElementType.BLOCK and element.interlocking_group:
            yield ResourceOccupancy(
                resource_type=ResourceType.INTERLOCKING,
                resource_id=element.interlocking_group,
                start_time=interval.start_time,
                end_time=interval.end_time,
                service_id=schedule.service_id,
            )


def validate_interlocking_schedule(
    candidate: ServiceSchedule,
    existing_services: Iterable[ServiceSchedule],
    topology: RailwayTopology,
) -> None:
    candidate_occupancies = tuple(interlocking_occupancies(candidate, topology))
    for existing in existing_services:
        if existing.vehicle_id == candidate.vehicle_id or (
            candidate.service_id is not None and existing.service_id == candidate.service_id
        ):
            continue
        for occupied in interlocking_occupancies(existing, topology):
            for requested in candidate_occupancies:
                if (
                    requested.resource_id == occupied.resource_id
                    and occupancies_overlap(requested, occupied)
                ):
                    raise InterlockingConflictError(
                        requested.resource_id, candidate.service_id, existing.service_id,
                    )
