import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api import router
from app.application import ResourceNotFoundError, UnknownVehicleError
from app.domain.path_validation import PathValidationError
from app.domain.timeline import PlatformTimingError, TimelineConfigurationError
from app.domain.vehicle_schedule import (
    IncomparableScheduleTimeError, ServiceScheduleError,
    VehicleLocationContinuityError, VehicleOverlapError,
)
from app.persistence.repositories import BlockConfigurationError, ServiceNotFoundError

app = FastAPI(title="Vehicle Scheduling System")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(router)


ERROR_STATUS = {
    ResourceNotFoundError: 404,
    ServiceNotFoundError: 404,
    UnknownVehicleError: 422,
    PathValidationError: 422,
    PlatformTimingError: 422,
    TimelineConfigurationError: 422,
    ServiceScheduleError: 422,
    IncomparableScheduleTimeError: 422,
    BlockConfigurationError: 422,
    VehicleOverlapError: 409,
    VehicleLocationContinuityError: 409,
}


async def domain_error(request: Request, error: Exception) -> JSONResponse:
    status = next(value for kind, value in ERROR_STATUS.items() if isinstance(error, kind))
    detail = {"code": type(error).__name__, "message": str(error), **vars(error)}
    return JSONResponse(status_code=status, content={"detail": detail})


for error_type in ERROR_STATUS:
    app.add_exception_handler(error_type, domain_error)


@app.exception_handler(SQLAlchemyError)
async def database_error(request: Request, error: SQLAlchemyError) -> JSONResponse:
    logging.getLogger(__name__).error("Database operation failed", exc_info=error)
    return JSONResponse(status_code=500, content={
        "detail": {"code": "DatabaseError", "message": "Database operation failed."}
    })


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
