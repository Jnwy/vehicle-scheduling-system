from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier, Event

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.api import get_session
from app.application import acquire_write_lock
from app.main import app
from app.persistence.database import SessionFactory, engine
from app.persistence.models import ServiceRecord, TrackElementRecord
from app.persistence.repositories import ServiceRepository, TopologyRepository
from app.persistence.seed import seed_database


@pytest.fixture
def client():
    # These tests commit real transactions, including across independent sessions.
    # Never erase an application database accidentally.
    assert engine.url.database.endswith("_test"), "API tests require an isolated *_test database"
    with SessionFactory.begin() as session:
        session.execute(delete(ServiceRecord))
        seed_database(session)
        for block in session.scalars(select(TrackElementRecord).where(TrackElementRecord.element_type == "BLOCK")):
            block.traversal_seconds = 10
    with TestClient(app, raise_server_exceptions=False) as value:
        yield value
    app.dependency_overrides.clear()
    with SessionFactory.begin() as session:
        session.execute(delete(ServiceRecord))


def payload(path=("Y", "B1", "P1A"), start=0, vehicle="V1", traversal=10, offset=""):
    current = datetime(2026, 10, 1, 8) + timedelta(seconds=start)
    start_time = current.isoformat() + offset
    timings = []
    for index, element in enumerate(path):
        if element.startswith("B"):
            current += timedelta(seconds=traversal)
        elif element.startswith("P"):
            timings.append({"pathIndex": index, "arrivalTime": current.isoformat() + offset,
                            "departureTime": (current + timedelta(seconds=10)).isoformat() + offset})
            current += timedelta(seconds=10)
    return {"vehicleId": vehicle, "startTime": start_time, "path": list(path), "platformTimings": timings}


def create(client, **kwargs):
    response = client.post("/services", json=payload(**kwargs))
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("origin", ["http://localhost:4200", "http://127.0.0.1:4200"])
def test_allowed_angular_origins_receive_cors_headers(origin):
    with TestClient(app, raise_server_exceptions=False) as caller:
        preflight = caller.options(
            "/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        response = caller.get("/health", headers={"Origin": origin})
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == origin
    assert "GET" in preflight.headers["access-control-allow-methods"]
    assert "content-type" in preflight.headers["access-control-allow-headers"].lower()
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_unallowed_origin_does_not_receive_cors_allow_origin_header():
    with TestClient(app, raise_server_exceptions=False) as caller:
        preflight = caller.options(
            "/health",
            headers={
                "Origin": "http://localhost:4201",
                "Access-Control-Request-Method": "GET",
            },
        )
        response = caller.get("/health", headers={"Origin": "http://localhost:4201"})
    assert "access-control-allow-origin" not in preflight.headers
    assert "access-control-allow-origin" not in response.headers


def test_complete_crud_and_seed_reads(client):
    assert client.get("/vehicles").json() == [{"id": "V1"}, {"id": "V2"}]
    graph = client.get("/topology").json()
    assert len(graph["elements"]) == 21
    assert len(graph["connections"]) == 28
    assert {"fromElementId": "B3", "toElementId": "B5"} in graph["connections"]
    assert len(client.get("/blocks").json()) == 14
    assert client.put("/blocks/B1", json={"traversalSeconds": 20}).status_code == 200
    first = create(client, traversal=20)
    second = create(client, vehicle="V2", traversal=20, start=120)
    assert client.get(f'/services/{first["id"]}').json() == first
    assert [item["id"] for item in client.get("/services").json()] == [first["id"], second["id"]]
    response = client.put(f'/services/{first["id"]}', json=payload(start=60, traversal=20))
    assert response.status_code == 200
    assert response.json()["startTime"] == "2026-10-01T08:01:00+08:00"
    assert client.delete(f'/services/{first["id"]}').status_code == 204
    assert client.get(f'/services/{first["id"]}').status_code == 404


def test_empty_schedule_analysis_includes_seeded_vehicles(client):
    response = client.get("/schedule-analysis")

    assert response.status_code == 200
    assert response.json() == {
        "startTime": None,
        "endTime": None,
        "vehicles": [
            {"vehicleId": "V1", "segments": []},
            {"vehicleId": "V2", "segments": []},
        ],
        "conflicts": [],
    }


def test_schedule_analysis_reports_cross_vehicle_block_conflict(client):
    # B5 is outside every interlocking group, so the write is accepted and the
    # Bonus analysis reports the shared block instead.
    first = create(client, path=("B5", "P2A"))
    second = create(client, path=("B5", "P2A"), vehicle="V2")

    response = client.get("/schedule-analysis")

    assert response.status_code == 200
    analysis = response.json()
    assert analysis["startTime"] == "2026-10-01T08:00:00+08:00"
    assert analysis["endTime"] == "2026-10-01T08:00:20+08:00"
    assert [vehicle["vehicleId"] for vehicle in analysis["vehicles"]] == ["V1", "V2"]
    assert analysis["vehicles"][0]["segments"][0] == {
        "segmentType": "SERVICE",
        "serviceId": first["id"],
        "pathIndex": 0,
        "elementId": "B5",
        "startTime": "2026-10-01T08:00:00+08:00",
        "endTime": "2026-10-01T08:00:10+08:00",
        "batteryStart": 80.0,
        "batteryEnd": 79.0,
    }
    assert analysis["vehicles"][1]["segments"][0]["serviceId"] == second["id"]
    assert analysis["conflicts"] == [
        {
            "conflictType": "BLOCK_OCCUPANCY",
            "resourceId": "B5",
            "startTime": "2026-10-01T08:00:00+08:00",
            "endTime": "2026-10-01T08:00:10+08:00",
            "vehicleIds": ["V1", "V2"],
            "serviceIds": [first["id"], second["id"]],
            "elementIds": ["B5"],
            "message": "Block B5 is occupied by multiple vehicles.",
        }
    ]


@pytest.mark.parametrize("value", [-1, 1.5, True, "10", "", None, 2147483648])
def test_invalid_block_values(client, value):
    assert client.put("/blocks/B1", json={"traversalSeconds": value}).status_code == 422
    assert next(item for item in client.get("/blocks").json() if item["id"] == "B1")["traversalSeconds"] == 10


def test_block_traversal_time_cannot_be_omitted(client):
    assert client.put("/blocks/B1", json={}).status_code == 422
    assert next(item for item in client.get("/blocks").json() if item["id"] == "B1")["traversalSeconds"] == 10


@pytest.mark.parametrize("method,url,body", [
    ("get", "/services/999999", None),
    ("put", "/services/999999", payload()),
    ("delete", "/services/999999", None),
    ("put", "/blocks/UNKNOWN", {"traversalSeconds": 1}),
    ("put", "/blocks/P1A", {"traversalSeconds": 1}),
])
def test_missing_url_resources(client, method, url, body):
    assert client.request(method, url, json=body).status_code == 404


@pytest.mark.parametrize("change,code", [
    ({"vehicleId": "UNKNOWN"}, "UnknownVehicleError"),
    ({"path": ["Y"]}, "PathTooShortError"),
    ({"path": ["Y", "UNKNOWN"]}, "UnknownTrackElementError"),
    ({"path": ["Y", "P1A"]}, "MissingTrackConnectionError"),
    ({"platformTimings": []}, "PlatformTimingError"),
])
def test_invalid_service_domain_errors(client, change, code):
    response = client.post("/services", json=payload() | change)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == code
    assert client.get("/services").json() == []


def test_unconfigured_block_and_error_indices(client):
    with SessionFactory.begin() as session:
        session.get(TrackElementRecord, "B1").traversal_seconds = None
    response = client.post("/services", json=payload())
    assert response.status_code == 422
    assert response.json()["detail"]["element_id"] == "B1"
    client.put("/blocks/B1", json={"traversalSeconds": 10})
    data = payload()
    data["platformTimings"][0]["arrivalTime"] = "2026-10-01T08:00:09"
    response = client.post("/services", json=data)
    assert response.status_code == 422
    assert response.json()["detail"]["path_index"] == 2
    assert create(client)["id"]


def test_reject_client_snapshot_and_numeric_datetime(client):
    assert client.post("/services", json=payload() | {"timeline": []}).status_code == 422
    assert client.post("/services", json=payload() | {"startTime": 123}).status_code == 422


@pytest.mark.parametrize("start", [
    "9999-12-31T23:59:59", "9999-12-31T23:59:59Z",
    "0001-01-01T00:00:00", "0001-01-01T00:00:00+08:00",
])
def test_datetime_overflow_is_input_error(client, start):
    data = payload(path=("Y", "B1", "Y")) | {"startTime": start}
    assert client.post("/services", json=data).status_code == 422
    assert client.get("/services").json() == []


def test_overlap_and_failed_update_preserve_original(client):
    first = create(client)
    second = create(client, vehicle="V2", start=60)
    response = client.put(f'/services/{second["id"]}', json=payload())
    assert response.status_code == 409
    assert response.json()["detail"]["conflicting_service_id"] == first["id"]
    assert client.get(f'/services/{second["id"]}').json() == second
    assert client.post("/services", json=payload()).status_code == 409
    assert client.delete(f'/services/{first["id"]}').status_code == 204
    assert client.put(f'/services/{second["id"]}', json=payload()).status_code == 200


@pytest.mark.parametrize("start", [0, 1, 9])
def test_same_vehicle_overlap_create_rolls_back_nonzero_service(client, start):
    first = create(client, path=("Y", "B1", "Y"))
    assert first["timeline"][-1]["endTime"] > first["startTime"]
    before = client.get("/services").json()

    response = client.post("/services", json=payload(path=("Y", "B1", "Y"), start=start))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "VehicleOverlapError"
    assert client.get("/services").json() == before


def test_same_vehicle_overlap_update_rolls_back_and_touching_boundary_succeeds(client):
    first = create(client, path=("Y", "B1", "Y"))
    second = create(client, path=("Y", "B1", "Y"), start=30)
    before = client.get("/services").json()

    response = client.put(f'/services/{second["id"]}', json=payload(path=("Y", "B1", "Y"), start=5))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "VehicleOverlapError"
    assert client.get("/services").json() == before
    response = client.put(f'/services/{second["id"]}', json=payload(path=("Y", "B1", "Y"), start=10))
    assert response.status_code == 200
    assert response.json()["startTime"] == first["timeline"][-1]["endTime"]


@pytest.mark.parametrize("update", [False, True])
def test_location_discontinuity_rolls_back_create_and_update(client, update):
    create(client, path=("Y", "B1", "Y"))
    second = create(client, path=("Y", "B1", "Y"), start=30) if update else None
    before = client.get("/services").json()
    data = payload(path=("P1A", "B1", "Y"), start=30)

    response = (client.put(f'/services/{second["id"]}', json=data) if update
                else client.post("/services", json=data))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "VehicleLocationContinuityError"
    assert client.get("/services").json() == before


@pytest.mark.parametrize("block", ["B1", "B2"])
def test_interlocking_create_rejects_same_group_and_rolls_back(client, block):
    create(client, path=("Y", "B1", "Y"))
    before = client.get("/services").json()

    response = client.post("/services", json=payload(path=("Y", block, "Y"), vehicle="V2", start=5))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "InterlockingConflictError"
    assert response.json()["detail"]["interlocking_group"] == "IG1"
    assert client.get("/services").json() == before


def test_interlocking_update_rolls_back_and_touching_boundary_succeeds(client):
    first = create(client, path=("Y", "B1", "Y"))
    second = create(client, path=("Y", "B2", "Y"), vehicle="V2", start=30)
    before = client.get("/services").json()

    response = client.put(f'/services/{second["id"]}', json=payload(path=("Y", "B2", "Y"), vehicle="V2", start=5))

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "InterlockingConflictError"
    assert client.get("/services").json() == before
    response = client.put(f'/services/{second["id"]}', json=payload(path=("Y", "B2", "Y"), vehicle="V2", start=10))
    assert response.status_code == 200
    assert response.json()["startTime"] == first["timeline"][-1]["endTime"]


@pytest.mark.parametrize("path", [("B3", "B5"), ("B5", "P2A")])
def test_interlocking_allows_other_groups_and_ungrouped_blocks(client, path):
    create(client, path=("Y", "B1", "Y"))
    assert create(client, path=path, vehicle="V2")["id"]


def test_cross_vehicle_ungrouped_block_occupancy_does_not_reject_write(client):
    first = create(client, path=("B5", "P2A"))
    second = create(client, path=("B5", "P2A"), vehicle="V2")
    assert second["timeline"] == first["timeline"]
    assert len(client.get("/services").json()) == 2


def bridge(client):
    first = create(client)
    middle = create(client, path=("P1A", "B3", "B5", "P2A"), start=30)
    last = create(client, path=("P2A", "B6"), start=80)
    return first, middle, last


def test_delete_and_update_reject_broken_remaining_schedule(client):
    first, middle, last = bridge(client)
    response = client.delete(f'/services/{middle["id"]}')
    assert response.status_code == 409
    assert response.json()["detail"]["from_service_id"] == first["id"]
    assert response.json()["detail"]["to_service_id"] == last["id"]
    for data in [payload(path=("P1A", "B3", "B5", "P2A"), start=100),
                 payload(path=("P1A", "B3", "B5", "P2A"), start=30, vehicle="V2")]:
        assert client.put(f'/services/{middle["id"]}', json=data).status_code == 409
        assert client.get(f'/services/{middle["id"]}').json() == middle
    assert client.put(f'/services/{middle["id"]}', json=payload(path=("P1A", "B3", "B5", "P2A"), start=35)).status_code == 200
    assert client.delete(f'/services/{first["id"]}').status_code == 204
    assert client.delete(f'/services/{last["id"]}').status_code == 204
    assert client.delete(f'/services/{middle["id"]}').status_code == 204


def test_continuous_middle_delete_and_other_vehicle_independence(client):
    first = create(client, path=("Y", "B1", "Y"))
    middle = create(client, path=("Y", "B1", "Y"), start=30)
    last = create(client, path=("Y", "B1", "Y"), start=60)
    create(client, vehicle="V2", path=("P1B", "B2"))
    assert client.delete(f'/services/{middle["id"]}').status_code == 204
    assert client.get(f'/services/{first["id"]}').status_code == 200
    assert client.get(f'/services/{last["id"]}').status_code == 200


def test_repeated_platforms_and_configuration_snapshot(client):
    data = payload(path=("P1A", "B1", "Y", "B1", "P1A"))
    response = client.post("/services", json=data)
    assert response.status_code == 201
    original = response.json()
    assert [item["pathIndex"] for item in original["platformTimings"]] == [0, 4]
    client.put("/blocks/B1", json={"traversalSeconds": 20})
    assert client.get(f'/services/{original["id"]}').json() == original
    assert client.put(f'/services/{original["id"]}', json=data).status_code == 422
    assert client.get(f'/services/{original["id"]}').json() == original
    response = client.put(f'/services/{original["id"]}', json=payload(path=data["path"], traversal=20))
    assert response.status_code == 200
    assert response.json()["timeline"] != original["timeline"]


def test_offsets_represent_same_instant(client):
    first = create(client)
    data = payload(vehicle="V2", offset="+08:00")
    data["startTime"] = "2026-10-01T00:00:00Z"
    data["platformTimings"][0]["arrivalTime"] = "2026-10-01T02:00:10+02:00"
    data["platformTimings"][0]["departureTime"] = "2026-10-01T00:00:20+00:00"
    # Compare representations without creating a cross-vehicle IG1 violation.
    assert client.delete(f'/services/{first["id"]}').status_code == 204
    second = client.post("/services", json=data)
    assert second.status_code == 201
    assert second.json()["timeline"] == first["timeline"]
    assert second.json()["platformTimings"] == first["platformTimings"]
    assert client.get(f'/services/{second.json()["id"]}').json() == second.json()
    assert client.post("/services", json=data).status_code == 409


def test_offset_input_keeps_fixed_output_offset_during_historical_dst(client):
    data = payload(path=("Y", "B1", "Y")) | {"startTime": "1979-07-01T08:00:00+08:00"}
    response = client.post("/services", json=data)
    assert response.status_code == 201, response.text
    assert response.json()["startTime"] == "1979-07-01T08:00:00+08:00"
    assert response.json()["timeline"][-1]["endTime"] == "1979-07-01T08:00:10+08:00"
    assert client.get(f'/services/{response.json()["id"]}').json() == response.json()


def test_half_open_touching_services_and_create_continuity(client):
    create(client)
    assert client.post("/services", json=payload(start=20)).status_code == 409
    response = client.post("/services", json=payload(path=("P1A", "B1", "Y"), start=20))
    assert response.status_code == 201


def test_zero_duration_service_and_update(client):
    client.put("/blocks/B1", json={"traversalSeconds": 0})
    data = payload(path=("Y", "B1", "Y"), traversal=0)
    first = client.post("/services", json=data)
    second = client.post("/services", json=data)
    assert first.status_code == second.status_code == 201
    assert client.put(f'/services/{first.json()["id"]}', json=data).status_code == 200
    assert client.delete(f'/services/{second.json()["id"]}').status_code == 204


@pytest.mark.parametrize("timings", [
    [{"pathIndex": 2, "arrivalTime": "2026-10-01T08:00:10", "departureTime": "2026-10-01T08:00:09"}],
    [{"pathIndex": 99, "arrivalTime": "2026-10-01T08:00:10", "departureTime": "2026-10-01T08:00:20"}],
    [{"pathIndex": 1, "arrivalTime": "2026-10-01T08:00:10", "departureTime": "2026-10-01T08:00:20"}],
    payload()["platformTimings"] * 2,
])
def test_invalid_platform_timings(client, timings):
    response = client.post("/services", json=payload() | {"platformTimings": timings})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "PlatformTimingError"
    assert client.get("/services").json() == []


def test_database_failure_rolls_back_and_recovers(client, monkeypatch):
    original = ServiceRepository._write_path_snapshot
    def fail(repository, service_id, schedule):
        original(repository, service_id, schedule)
        repository._session.execute(text("SELECT 1 / 0"))
    saved = create(client)
    monkeypatch.setattr(ServiceRepository, "_write_path_snapshot", fail)
    response = client.put(f'/services/{saved["id"]}', json=payload(start=60))
    assert response.status_code == 500
    assert response.json()["detail"] == {"code": "DatabaseError", "message": "Database operation failed."}
    assert client.get(f'/services/{saved["id"]}').json() == saved
    assert client.post("/services", json=payload(vehicle="V2", start=60)).status_code == 500
    assert len(client.get("/services").json()) == 1
    monkeypatch.setattr(ServiceRepository, "_write_path_snapshot", original)
    assert client.put(f'/services/{saved["id"]}', json=payload(start=60)).status_code == 200
    assert create(client, vehicle="V2")["id"]


@pytest.mark.parametrize("update", [False, True])
def test_service_response_does_not_query_database_after_commit(client, monkeypatch, update):
    saved = create(client) if update else None
    original = TopologyRepository.get

    def get_within_transaction(repository):
        if not repository._session.in_transaction():
            raise SQLAlchemyError("Database unavailable after commit")
        return original(repository)

    monkeypatch.setattr(TopologyRepository, "get", get_within_transaction)
    if update:
        response = client.put(f'/services/{saved["id"]}', json=payload(start=60))
        assert response.status_code == 200, response.text
    else:
        response = client.post("/services", json=payload())
        assert response.status_code == 201, response.text
    monkeypatch.setattr(TopologyRepository, "get", original)
    assert client.get(f'/services/{response.json()["id"]}').json() == response.json()


@pytest.mark.parametrize("interlocking", [False, True])
def test_concurrent_conflicting_writes_use_distinct_sessions(client, interlocking):
    barrier = Barrier(2)
    sessions = []
    def independent_session():
        with SessionFactory() as session:
            sessions.append(session)
            barrier.wait(timeout=10)
            yield session
    app.dependency_overrides[get_session] = independent_session
    def write(data):
        with TestClient(app, raise_server_exceptions=False) as caller:
            return caller.post("/services", json=data).status_code
    data = ([payload(path=("Y", "B1", "Y")),
             payload(path=("Y", "B2", "Y"), vehicle="V2")]
            if interlocking else [payload(), payload()])
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(write, data))
    app.dependency_overrides.clear()
    assert len(sessions) == 2 and sessions[0] is not sessions[1]
    assert sorted(results) == [201, 409]
    assert len(client.get("/services").json()) == 1
    assert create(client, vehicle="V2", path=("Y", "B2", "Y"), start=60)["id"]


def test_block_write_waits_for_shared_lock(client):
    started = Event()
    def write():
        started.set()
        with TestClient(app) as caller:
            return caller.put("/blocks/B1", json={"traversalSeconds": 42})
    with ThreadPoolExecutor(max_workers=1) as workers:
        with SessionFactory.begin() as session:
            acquire_write_lock(session)
            future = workers.submit(write)
            assert started.wait(5)
            # PostgreSQL confirms a real blocked advisory-lock waiter.
            with engine.connect() as observer:
                for _ in range(100):
                    waiting = observer.scalar(text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"))
                    if waiting:
                        break
                    observer.execute(text("SELECT pg_sleep(0.02)"))
                assert waiting == 1
            assert not future.done()
        assert future.result(timeout=10).status_code == 200
    assert next(item for item in client.get("/blocks").json() if item["id"] == "B1")["traversalSeconds"] == 42
