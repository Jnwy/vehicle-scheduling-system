import re
from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.application import (
    configure_block, configure_blocks, delete_service, list_vehicles, preview_block_changes, save_service,
)
from app.domain.models import RailwayTopology, TrackElement, TrackElementType
from app.domain.schedule_analysis import analyze_schedule
from app.domain.vehicle_schedule import ServiceSchedule
from app.persistence.database import SessionFactory
from app.persistence.repositories import ServiceNotFoundError, ServiceRepository, TopologyRepository
from app.schemas import (
    BlockChangePreviewOutput, BlockChangesInput, BlockInput, BlockOutput, StaleConflictOutput,
    StaleServiceOutput, PlatformTimingInput, ScheduleAnalysisOutput,
    ScheduleConflictOutput, ServiceInput, ServiceOutput, SimulationSegmentOutput,
    TimelineOutput, TopologyOutput, TrackConnectionOutput, TrackElementOutput,
    VehicleOutput, VehicleSimulationOutput, taipei_time,
)


router = APIRouter()


def natural_id_key(element_id: str) -> list[tuple[int, int | str]]:
    # Orders B2 before B10: digit runs compare as numbers, the rest as text.
    return [(0, int(part)) if part.isdigit() else (1, part)
            for part in re.split(r"(\d+)", element_id) if part]


def elements_in_display_order(topology: RailwayTopology) -> list[TrackElement]:
    return sorted(topology.elements.values(), key=lambda item: natural_id_key(item.id))


def get_session() -> Iterator[Session]:
    with SessionFactory() as session:
        yield session


DatabaseSession = Annotated[Session, Depends(get_session)]


def service_output(schedule: ServiceSchedule, topology: RailwayTopology) -> ServiceOutput:
    timeline = [TimelineOutput(pathIndex=index, elementId=interval.element_id,
                               startTime=taipei_time(interval.start_time),
                               endTime=taipei_time(interval.end_time))
                for index, interval in enumerate(schedule.timeline)]
    return ServiceOutput(
        id=schedule.service_id, vehicleId=schedule.vehicle_id,
        startTime=taipei_time(schedule.start_time), path=list(schedule.path),
        platformTimings=[PlatformTimingInput(pathIndex=item.pathIndex,
                                            arrivalTime=item.startTime,
                                            departureTime=item.endTime)
                         for item in timeline
                         if topology.elements[item.elementId].element_type is TrackElementType.PLATFORM],
        timeline=timeline,
    )


@router.get("/services", response_model=list[ServiceOutput])
def services(session: DatabaseSession) -> list[ServiceOutput]:
    topology = TopologyRepository(session).get()
    return [service_output(schedule, topology) for schedule in ServiceRepository(session).list()]


@router.get("/services/{service_id}", response_model=ServiceOutput)
def service(service_id: int, session: DatabaseSession) -> ServiceOutput:
    schedule = ServiceRepository(session).get(service_id)
    if schedule is None:
        raise ServiceNotFoundError(service_id)
    return service_output(schedule, TopologyRepository(session).get())


def write_service(
    data: ServiceInput, session: Session, service_id: int | None = None,
) -> ServiceOutput:
    schedule, topology = save_service(session, data.vehicleId, data.startTime, data.path,
                            [item.to_domain() for item in data.platformTimings], service_id)
    return service_output(schedule, topology)


@router.post("/services", status_code=201, response_model=ServiceOutput)
def create_service(data: ServiceInput, session: DatabaseSession) -> ServiceOutput:
    return write_service(data, session)


@router.put("/services/{service_id}", response_model=ServiceOutput)
def update_service(service_id: int, data: ServiceInput, session: DatabaseSession) -> ServiceOutput:
    return write_service(data, session, service_id)


@router.delete("/services/{service_id}", status_code=204)
def remove_service(service_id: int, session: DatabaseSession) -> Response:
    delete_service(session, service_id)
    return Response(status_code=204)


@router.get("/vehicles", response_model=list[VehicleOutput])
def vehicles(session: DatabaseSession) -> list[dict[str, str]]:
    return list_vehicles(session)


@router.get("/schedule-analysis", response_model=ScheduleAnalysisOutput)
def schedule_analysis(session: DatabaseSession) -> ScheduleAnalysisOutput:
    repository = ServiceRepository(session)
    topology = TopologyRepository(session).get()
    vehicle_ids = [item["id"] for item in list_vehicles(session)]
    analysis = analyze_schedule(repository.list(), topology, vehicle_ids)
    return ScheduleAnalysisOutput(
        startTime=taipei_time(analysis.start_time) if analysis.start_time else None,
        endTime=taipei_time(analysis.end_time) if analysis.end_time else None,
        vehicles=[
            VehicleSimulationOutput(
                vehicleId=vehicle.vehicle_id,
                segments=[
                    SimulationSegmentOutput(
                        segmentType=segment.segment_type.value,
                        serviceId=segment.service_id,
                        pathIndex=segment.path_index,
                        elementId=segment.element_id,
                        startTime=taipei_time(segment.start_time),
                        endTime=taipei_time(segment.end_time),
                        batteryStart=segment.battery_start,
                        batteryEnd=segment.battery_end,
                    )
                    for segment in vehicle.segments
                ],
            )
            for vehicle in analysis.vehicles
        ],
        conflicts=[
            ScheduleConflictOutput(
                conflictType=conflict.conflict_type.value,
                resourceId=conflict.resource_id,
                startTime=taipei_time(conflict.start_time),
                endTime=taipei_time(conflict.end_time),
                vehicleIds=list(conflict.vehicle_ids),
                serviceIds=list(conflict.service_ids),
                elementIds=list(conflict.element_ids),
                message=conflict.message,
            )
            for conflict in analysis.conflicts
        ],
    )


@router.get("/topology", response_model=TopologyOutput)
def topology(session: DatabaseSession) -> TopologyOutput:
    graph = TopologyRepository(session).get()
    return TopologyOutput(
        elements=[TrackElementOutput(id=item.id, elementType=item.element_type.value,
                                     traversalSeconds=item.traversal_seconds,
                                     interlockingGroup=item.interlocking_group)
                  for item in elements_in_display_order(graph)],
        connections=[TrackConnectionOutput(fromElementId=item.from_element_id,
                                           toElementId=item.to_element_id)
                     for item in sorted(graph.connections,
                                        key=lambda item: (natural_id_key(item.from_element_id),
                                                          natural_id_key(item.to_element_id)))],
    )


@router.get("/blocks", response_model=list[BlockOutput])
def blocks(session: DatabaseSession) -> list[BlockOutput]:
    return [BlockOutput(id=item.id, traversalSeconds=item.traversal_seconds,
                        interlockingGroup=item.interlocking_group)
            for item in elements_in_display_order(TopologyRepository(session).get())
            if item.element_type is TrackElementType.BLOCK]


@router.put("/blocks/{block_id}", response_model=BlockOutput)
def update_block(
    block_id: str, data: BlockInput, session: DatabaseSession,
) -> dict[str, str | int | None]:
    return configure_block(session, block_id, data.traversalSeconds)


@router.put("/blocks", response_model=list[BlockOutput])
def update_blocks(
    data: BlockChangesInput, session: DatabaseSession,
) -> list[dict[str, str | int | None]]:
    return configure_blocks(session, data.traversal_seconds())


@router.post("/blocks/preview", response_model=BlockChangePreviewOutput)
def preview_blocks(data: BlockChangesInput, session: DatabaseSession) -> BlockChangePreviewOutput:
    return BlockChangePreviewOutput(services=[
        StaleServiceOutput(
            id=item.saved.service_id, vehicleId=item.saved.vehicle_id,
            startTime=taipei_time(item.saved.start_time), path=list(item.saved.path),
            conflict=None if item.conflict is None else StaleConflictOutput(
                code=type(item.conflict).__name__, message=str(item.conflict)),
        )
        for item in preview_block_changes(session, data.traversal_seconds())
    ])
