from datetime import datetime, timedelta, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

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


class TimelineOutput(BaseModel):
    pathIndex: int
    elementId: str
    startTime: datetime
    endTime: datetime


class ServiceOutput(ServiceInput):
    id: int
    timeline: list[TimelineOutput]
