from datetime import datetime, timedelta, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from app.domain.timeline import PlatformTiming


TAIPEI = ZoneInfo("Asia/Taipei")
OUTPUT_TIMEZONE = timezone(timedelta(hours=8))


def datetime_input(value: object) -> object:
    if not isinstance(value, (str, datetime)):
        raise ValueError("Use an ISO 8601 datetime string.")
    return value


DateTimeInput = Annotated[datetime, BeforeValidator(datetime_input)]


def taipei_time(value: datetime) -> datetime:
    try:
        if value.tzinfo is None:
            value = value.replace(tzinfo=TAIPEI)
        # A fixed offset preserves elapsed-time arithmetic even across historic
        # DST changes, and matches the API's promised +08:00 representation.
        value = value.astimezone(timezone.utc)
        return value.astimezone(OUTPUT_TIMEZONE)
    except OverflowError as error:
        raise ValueError("Datetime exceeds the supported range.") from error


class PlatformTimingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pathIndex: int = Field(strict=True, ge=0)
    arrivalTime: DateTimeInput
    departureTime: DateTimeInput

    @field_validator("arrivalTime", "departureTime")
    @classmethod
    def normalize_time(cls, value: datetime) -> datetime:
        return taipei_time(value)

    def to_domain(self) -> PlatformTiming:
        return PlatformTiming(self.pathIndex, self.arrivalTime, self.departureTime)


class ServiceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vehicleId: str
    startTime: DateTimeInput
    path: list[str]
    platformTimings: list[PlatformTimingInput] = Field(default_factory=list)

    @field_validator("startTime")
    @classmethod
    def normalize_time(cls, value: datetime) -> datetime:
        return taipei_time(value)


class BlockInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # PostgreSQL INTEGER is bounded; reject overflow as an input error.
    traversalSeconds: int = Field(strict=True, ge=0, le=2147483647)


class BlockChangeInput(BlockInput):
    id: str


class BlockChangesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: list[BlockChangeInput]

    @model_validator(mode="after")
    def reject_repeated_blocks(self) -> "BlockChangesInput":
        ids = [change.id for change in self.changes]
        if len(ids) != len(set(ids)):
            raise ValueError("Each block may appear only once.")
        return self

    def traversal_seconds(self) -> dict[str, int]:
        return {change.id: change.traversalSeconds for change in self.changes}


class VehicleOutput(BaseModel):
    id: str


class BlockOutput(BaseModel):
    id: str
    traversalSeconds: int | None
    interlockingGroup: str | None


class TrackElementOutput(BlockOutput):
    elementType: str


class TrackConnectionOutput(BaseModel):
    fromElementId: str
    toElementId: str


class TopologyOutput(BaseModel):
    elements: list[TrackElementOutput]
    connections: list[TrackConnectionOutput]


class TimelineOutput(BaseModel):
    pathIndex: int
    elementId: str
    startTime: datetime
    endTime: datetime


class ServiceOutput(ServiceInput):
    id: int
    timeline: list[TimelineOutput]


class SimulationSegmentOutput(BaseModel):
    segmentType: str
    serviceId: int | None
    pathIndex: int | None
    elementId: str
    startTime: datetime
    endTime: datetime
    batteryStart: float
    batteryEnd: float


class VehicleSimulationOutput(BaseModel):
    vehicleId: str
    segments: list[SimulationSegmentOutput]


class ScheduleConflictOutput(BaseModel):
    conflictType: str
    resourceId: str | None
    startTime: datetime
    endTime: datetime
    vehicleIds: list[str]
    serviceIds: list[int]
    elementIds: list[str]
    message: str


class ScheduleAnalysisOutput(BaseModel):
    startTime: datetime | None
    endTime: datetime | None
    vehicles: list[VehicleSimulationOutput]
    conflicts: list[ScheduleConflictOutput]


class StaleConflictOutput(BaseModel):
    code: str
    message: str


class StaleServiceOutput(BaseModel):
    id: int
    vehicleId: str
    startTime: datetime
    path: list[str]
    conflict: StaleConflictOutput | None


class BlockChangePreviewOutput(BaseModel):
    services: list[StaleServiceOutput]
