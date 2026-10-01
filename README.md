# Vehicle Scheduling System

A vehicle scheduling system for managing services on a predefined railway topology.

The system allows users to assign vehicles to routes at specific times while
preventing mandatory same-vehicle overlap, location discontinuity, and
cross-vehicle interlocking conflicts. General block occupancy and battery
conflicts are assignment Bonus reports, not write rejection rules.

> This project is implemented as a technical assignment. The primary focus is correctness, domain modeling, scheduling rules, and clear engineering trade-offs rather than feature volume or UI complexity.

---

## Overview

The railway network is represented as a directed graph consisting of:

- yards
- platforms
- track blocks

Users create a `Service` by specifying:

- a vehicle
- a start time
- an ordered path through the railway network
- arrival and departure time for each platform occurrence in the path

Example:

```json
{
  "vehicleId": "V1",
  "startTime": "2026-09-27T08:00:00",
  "path": [
    "Y",
    "B1",
    "P1A",
    "B3",
    "B5",
    "P2A"
  ],
  "platformTimings": [
    {
      "pathIndex": 2,
      "arrivalTime": "2026-09-27T08:00:20",
      "departureTime": "2026-09-27T08:00:50"
    },
    {
      "pathIndex": 5,
      "arrivalTime": "2026-09-27T08:01:45",
      "departureTime": "2026-09-27T08:02:15"
    }
  ]
}
```

Before a service is accepted, the system validates the path and checks whether it conflicts with existing services.

---

## Running the Project

Build and start the complete application from the repository root:

```bash
docker compose up --build
```

After the first build, start the existing containers in the background with:

```bash
docker compose up -d
```

The frontend is available at `http://localhost:4200`, and the backend health
endpoint is available at `http://localhost:8000/health`.

Backend startup applies pending Alembic migrations and runs an idempotent seed
for the fixed topology and vehicles `V1`/`V2`. Seed execution does not overwrite
configured block traversal times. Seeded blocks B1-B14 default to 20 seconds;
existing null values are filled with 20. This is a project product default,
not a duration supplied by the assignment. Block updates require a non-negative
integer and cannot clear the value.

Backend application and test files, and frontend source files, are mounted into
their containers. FastAPI reloads when backend application code changes, and
Angular rebuilds when frontend source code changes. Rebuild the relevant image
after changing dependencies, a Dockerfile, or build configuration:

```bash
docker compose up --build -d backend
docker compose up --build -d frontend
```

---

## Running Tests

Run domain tests inside the running backend container:

```bash
docker compose exec backend python -m pytest tests/test_path_validation.py tests/test_timeline.py tests/test_vehicle_schedule.py tests/test_service_update.py
```

Because the tests directory is mounted into the container, test-only changes do
not require rebuilding the backend image.

For the complete suite, create and migrate an independent test database once:

```bash
docker compose exec database createdb -U vehicle_scheduling fastapi_scheduling_test
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint alembic backend upgrade head
```

Then run all domain, PostgreSQL, API, and concurrency tests:

```bash
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint python backend -m pytest tests -q
```

API tests commit transactions and clear services in the designated test
database. A database name ending in `_test` is required. Do not use an
application database or run parallel suites against the same test database.
Last verified result: **178 passed**.

---

## Implemented Scope

### Core Requirements

- service CRUD
- predefined railway topology
- predefined vehicles
- directed path validation
- timeline calculation
- vehicle scheduling conflicts
- vehicle location continuity
- interlocking group exclusivity across vehicles
- unit-tested domain logic
- three Angular pages: Schedule Editor, Schedule Viewer, Block Configuration

Interlocking exclusivity belongs to the assignment's Track Map rules and is
treated as mandatory, not as a Bonus.

### Bonus Features

| Bonus | Status | What is included |
| --- | --- | --- |
| 1 — Conflict Detection | Implemented | `GET /schedule-analysis` reports cross-vehicle block occupancy, low battery, and insufficient charge on yard departure. These are warnings and do not reject writes. |
| 2 — Interactive Track Map | Implemented | A d3 SVG map of the topology. The Schedule Editor builds a path by clicking elements, enabling only legal next elements. The Schedule Viewer plays the schedule back with vehicle positions, battery state, and conflict highlighting. |
| 3 — Auto-Generate Schedule | Not implemented | — |

---

## Scheduling Flow

A service passes through the following process:

```text
Service Request
      ↓
Validate Vehicle
      ↓
Validate Path
      ↓
Calculate Timeline
      ↓
Derive Vehicle Occupancy
      ↓
Detect Vehicle Overlap
      ↓
Validate Vehicle Continuity
      ↓
Validate Interlocking Exclusivity
      ↓
Persist Service
```

An invalid service is rejected before persistence.

---

## Railway Topology

The railway network is modeled as a directed graph.

Each railway object is represented as a `TrackElement`.

Current element types:

```text
YARD
PLATFORM
BLOCK
```

Connections are directional:

```text
P1A -> B3
```

does not imply:

```text
B3 -> P1A
```

The topology may also contain direct block-to-block connections.

---

## Resource-Based Conflict Model

Scheduling conflicts are represented as resource occupancy over time.

Examples of resources:

```text
vehicle:V1
interlocking:IG1
```

Mandatory validation uses full-service vehicle occupancy and per-block
interlocking group occupancy. Create/update returns 409 for same-vehicle
overlap, location discontinuity, or cross-vehicle group overlap. Failed creates
leave no service; failed updates preserve the original input and snapshot.
Different blocks within the same group share one exclusive resource. Touching
endpoints are allowed. Blocks outside a group are not rejected for general
block occupancy, which remains Bonus detection/reporting.

All scheduling intervals use half-open semantics:

```text
[start, end)
```

Two intervals overlap when:

```text
startA < endB
and
startB < endA
```

Therefore:

```text
08:00 - 08:10
08:10 - 08:20
```

does not represent a conflict.

---

# Design Decisions and Trade-offs

## Unified TrackElement Model

### Decision

Yards, platforms, and blocks share a single `TrackElement` abstraction.

### Why

All three participate in the same railway graph.

Using one common element identity makes connections straightforward:

```text
TrackConnection(from_element_id, to_element_id)
```

and allows normal foreign-key relationships.

### Trade-off

Some configuration fields only apply to certain element types.

For example:

- traversal time mainly applies to blocks
- interlocking groups apply to blocks

This may result in nullable subtype-specific fields.

Platform arrival and departure times are not topology configuration. They
belong to each service and are associated with a zero-based path index so
repeated visits to the same platform remain distinguishable.

### When I Would Change It

If element types gained significantly different data and behavior, I would keep `TrackElement` as the graph identity and move subtype-specific properties into dedicated tables.

---

## User-Defined Paths Instead of Automatic Routing

### Decision

Users provide the complete ordered service path.

The application validates that path against the topology.

### Why

The assignment focuses on service scheduling and conflict handling.

Automatic route finding introduces a separate graph-search problem that is not necessary for the core scheduling requirements.

### Trade-off

The user must provide a valid route rather than selecting only an origin and destination.

### When I Would Change It

If route selection became part of the product requirements, route finding could be added as a separate component without changing the scheduling model.

---

## Seeded Topology and Vehicles

### Decision

Railway topology and vehicles are loaded as predefined data.

### Why

The assignment primarily requires managing services rather than infrastructure configuration.

### Trade-off

Users cannot dynamically create or delete vehicles or railway topology.
Block traversal time remains editable because Block
Configuration is a mandatory assignment page. Existing services retain their
saved timeline snapshot when traversal configuration changes.

### When I Would Change It

If infrastructure management became part of the requirements, dedicated management APIs and validation rules could be introduced.

---

## Domain Logic Independent from FastAPI

### Decision

Core scheduling behavior is implemented separately from HTTP and persistence infrastructure.

### Why

Rules such as path validation and time overlap are deterministic domain behavior.

Keeping them independent makes them easier to understand and test.

### Trade-off

This introduces a small amount of separation between API orchestration and domain logic.

### Benefit

The core behavior can be tested without:

- running FastAPI
- starting a database
- constructing HTTP requests

---

## Derived Resource Occupancy

### Decision

Resource occupancy is treated as data derived from a service and its timeline rather than as the primary persisted representation.

### Why

Occupancy can always be reconstructed from the saved service timeline.

Avoiding duplicated persisted state reduces synchronization concerns.

### Trade-off

Conflict queries may need to derive occupancy from saved timeline rows.

### When I Would Change It

At substantially larger scale, occupancy could be materialized or indexed as a performance optimization.

---

## Persisted Timeline Snapshots

### Decision

Each accepted service stores the calculated interval for every path occurrence
as a timeline snapshot.

Changing a block's traversal time affects services created afterward and
services that are explicitly updated. It does not silently recalculate existing
services.

### Why

An accepted railway schedule should remain deterministic. Recalculating every
read from current block configuration could change historical service times or
create vehicle conflicts without any service edit.

### Trade-off

The timeline is derived data, so storing it duplicates information that could
otherwise be recalculated. The write workflow must save the path and timeline
snapshot atomically to prevent divergence.

### Alternative Considered

Recalculating timelines from current block configuration would keep the schema
more normalized, but would make existing schedules unstable when configuration
changes. Recalculating every affected service during a configuration update was
also rejected as unnecessary transaction complexity for this assignment.

### When I Would Change It

If product requirements explicitly defined block configuration changes as
retroactive, I would introduce a versioned configuration or a transactional
replanning workflow instead of silently recalculating on read.

---

## Vehicle Continuity

### Decision

Consecutive services assigned to the same vehicle must connect directly:

```text
previous_service.end_location
==
next_service.start_location
```

### Why

This provides deterministic physical continuity without introducing automatic vehicle repositioning.

### Trade-off

The model does not automatically create deadheading or repositioning journeys.

### When I Would Change It

A production system could model repositioning as explicit services or introduce a dedicated planning mechanism.

---

## Interlocking as a Write-Time Rule, Block Occupancy as a Report

### Decision

Cross-vehicle interlocking violations are rejected on create and update with
409. General block occupancy, low battery, and insufficient charge are
detected and reported by the schedule analysis, and do not reject writes.

A violation requires different vehicles, blocks in the same interlocking
group, and overlapping `[start, end)` intervals. Touching intervals and
services of the same vehicle are not interlocking violations.

### Why

The assignment places the interlocking groups in the Track Map section, next
to the connectivity rule, and states them as a constraint: only one vehicle
may occupy any block of a group at a time. Path connectivity in the same
section is validated on write, so I treat interlocking the same way.

Block occupancy, low battery, and insufficient charge are listed under
Bonus 1, which asks the system to detect and report conflicts. Interlocking is
not in that list. I followed the assignment's own categorization rather than
reclassifying requirements.

Because interlocking violations can never be persisted, the schedule analysis
does not report a separate interlocking warning.

### Trade-off

This creates an asymmetry. Two vehicles on the same ungrouped block, for
example B5 at the same time, are accepted and only reported, even though they
share one physical track. Two vehicles on B1 and B2, which are different
tracks in the same group, are rejected.

So the weaker physical risk is enforced while the stronger one is only
reported. I accepted this to stay faithful to the assignment's separation of
mandatory rules and Bonus detection, and to keep same-block conflicts visible
in schedule playback.

### Alternative Considered

Treating interlocking like block occupancy, as a reported warning, would
remove the asymmetry. I rejected it because it would leave a stated Track Map
constraint unenforced in the mandatory scope.

### When I Would Change It

In a production system I would reject both cases on write, because a shared
block is at least as unsafe as a shared interlocking group. Playback would
then show only conflicts in imported or legacy data.

---

## Architecture

```text
Angular
   ↓
FastAPI
   ↓
Application Layer
   ↓
Domain Logic
   ↓
Persistence
```

Core scheduling rules remain below the HTTP layer.

The backend service CRUD, seeded reads, block configuration, error responses,
timezone handling, and transaction lock are documented in
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). Try the API through
`http://localhost:8000/docs`. The Angular interface at
`http://localhost:4200` has three pages: Schedule Editor (`/editor`, service
CRUD and validation feedback), Schedule Viewer (`/schedule`, read-only
timelines and playback), and Block Configuration (`/blocks`).

The implemented PostgreSQL schema, timeline snapshot policy, mapping rules, and
transaction ownership are documented in
[`docs/PERSISTENCE_DESIGN.md`](docs/PERSISTENCE_DESIGN.md).

---

## Data Model

PostgreSQL holds five tables. Full columns and constraints are in
[`docs/PERSISTENCE_DESIGN.md`](docs/PERSISTENCE_DESIGN.md).

| Table | Purpose |
| --- | --- |
| `vehicles` | Seeded vehicle IDs (`V1`, `V2`) |
| `track_elements` | Yard, platforms, and blocks; blocks carry `traversal_seconds` and `interlocking_group` |
| `track_connections` | Directed `from_element_id -> to_element_id` edges |
| `services` | Vehicle and `start_time` of each service |
| `service_path_elements` | Ordered path occurrences with their saved `[start, end)` interval snapshot |

Platform arrival and departure are the saved interval of that platform
occurrence, keyed by `path_index`, so repeated visits stay distinct.

Rationale, detailed under Design Decisions and Trade-offs:

- One `track_elements` table for yards, platforms, and blocks keeps the graph
  a single node type, so `track_connections` uses plain foreign keys
  (Unified TrackElement Model).
- A service's path and timeline share `service_path_elements`, so an accepted
  schedule is saved atomically and stays stable when block configuration
  changes (Persisted Timeline Snapshots).
- Vehicle and interlocking occupancy have no table; they are derived from the
  saved intervals to avoid duplicated state (Derived Resource Occupancy).

---

## API Overview

Full request, response, and error details are in
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md); interactive docs are at
`http://localhost:8000/docs`.

| Method and path | Behavior |
| --- | --- |
| `GET /services`, `GET /services/{id}` | Read saved services with timelines |
| `POST /services`, `PUT /services/{id}` | Calculate, validate, and create or fully replace |
| `DELETE /services/{id}` | Delete if the vehicle's remaining services stay continuous |
| `GET /vehicles`, `GET /topology` | Seeded reference data |
| `GET /blocks`, `PUT /blocks/{id}` | Read and set block traversal time |
| `GET /schedule-analysis` | Bonus report: block occupancy and battery warnings |

Errors: 404 unknown service or block, 422 invalid input or path, 409
scheduling conflict (vehicle overlap, continuity, interlocking).

---

## Assumptions

The complete rules are in [`docs/DOMAIN_RULES.md`](docs/DOMAIN_RULES.md).

- The user supplies the complete path; the system validates it and never
  searches for a route.
- Stations (`S1`-`S3`) are descriptive groupings only. Platforms of the same
  station are not directly connected; moving between them requires a path
  through blocks as defined by the adjacency list.
- Intervals are `[start, end)`; touching intervals do not conflict.
- A yard occurrence has zero duration; platform time comes from the service's
  own arrival and departure input.
- Consecutive services of one vehicle must end and start at the same element;
  deleting a service must not break that continuity.
- Interlocking exclusivity is mandatory and rejected on write; general block
  occupancy and battery issues are only reported.
- Vehicles are `V1` and `V2`, and blocks default to 20 seconds. Neither value
  is given by the assignment.
- Changing a block's traversal time does not recalculate saved services.
- Datetimes without an offset mean Asia/Taipei; responses use `+08:00`.

---

## Testing

Core business rules are tested using `pytest`.

The test suite covers path validation, including:

- valid path
- empty path
- single-element path
- unknown track element
- missing connection
- reverse-direction connection
- valid block-to-block connection
- mixed yard/platform/block path

It also covers:

- timeline calculation
- interval overlap
- vehicle conflicts
- vehicle continuity
- PostgreSQL migrations and deterministic seed behavior
- block traversal configuration persistence
- service repository CRUD and transaction rollback

Targeted tests cover mandatory interlocking exclusivity, touching intervals,
create/update rollback, and concurrent cross-vehicle writes. General block
occupancy and battery reports remain separate Bonus behavior.

---

## Known Limitations

The implementation intentionally does not include:

- automatic route finding
- automatic schedule generation (Bonus 3)
- vehicle management
- topology structure management; block traversal configuration is mandatory
- write rejection for general block occupancy or battery conflicts (reported
  only)
- production-scale scheduling optimization

These are kept out of scope to prioritize correctness of the core scheduling model.

Development history and milestone verification records are in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
