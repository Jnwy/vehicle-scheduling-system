from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.application import configure_block, delete_service, list_vehicles, save_service
from app.domain.models import RailwayTopology, TrackElementType
from app.domain.schedule_analysis import analyze_schedule
from app.domain.vehicle_schedule import ServiceSchedule
from app.persistence.database import SessionFactory
from app.persistence.repositories import ServiceNotFoundError, ServiceRepository, TopologyRepository
from app.schemas import (
    BlockInput, PlatformTimingInput, ScheduleAnalysisOutput, ScheduleConflictOutput,
    ServiceInput, ServiceOutput, SimulationSegmentOutput, TimelineOutput,
    VehicleSimulationOutput, taipei_time,
)


router = APIRouter()


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


@router.get("/vehicles")
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


@router.get("/topology")
def topology(session: DatabaseSession) -> dict[str, list[dict[str, str | int | None]]]:
    graph = TopologyRepository(session).get()
    return {
        "elements": [{"id": item.id, "elementType": item.element_type.value,
                      "traversalSeconds": item.traversal_seconds,
                      "interlockingGroup": item.interlocking_group}
                     for item in graph.elements.values()],
        "connections": [{"fromElementId": item.from_element_id, "toElementId": item.to_element_id}
                        for item in sorted(graph.connections,
                                           key=lambda item: (item.from_element_id, item.to_element_id))],
    }


@router.get("/blocks")
def blocks(session: DatabaseSession) -> list[dict[str, str | int | None]]:
    return [{"id": item.id, "traversalSeconds": item.traversal_seconds,
             "interlockingGroup": item.interlocking_group}
            for item in TopologyRepository(session).get().elements.values()
            if item.element_type is TrackElementType.BLOCK]


@router.put("/blocks/{block_id}")
def update_block(
    block_id: str, data: BlockInput, session: DatabaseSession,
) -> dict[str, str | int | None]:
    return configure_block(session, block_id, data.traversalSeconds)
