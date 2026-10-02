# Vehicle Scheduling System

A scheduling system for vehicle services on a fixed railway topology, built as
a technical assignment. A user assigns a vehicle to a path at a start time;
the system calculates the timeline and rejects a service that overlaps another
service of the same vehicle, breaks the vehicle's location continuity, or
shares an interlocking group with another vehicle at the same time.

The focus is correctness of the scheduling rules, a clear domain model, and
explicit trade-offs rather than feature volume.

## Contents

1. [Running the Project](#running-the-project)
2. [Implemented Scope](#implemented-scope)
3. [Data Model](#data-model)
4. [API Overview](#api-overview)
5. [Design Trade-offs](#design-trade-offs)
6. [Assumptions](#assumptions)
7. [Testing](#testing)
8. [Known Limitations](#known-limitations)
9. [Further Documentation](#further-documentation)

---

## Running the Project

From the repository root:

```bash
docker compose up --build
```

| What | URL |
| --- | --- |
| Application | <http://localhost:4200> |
| Interactive API docs | <http://localhost:8000/docs> |
| Backend health | <http://localhost:8000/health> |

Backend startup applies the database migrations and seeds the fixed topology
and the vehicles `V1` to `V5`. Seeding is idempotent and does not overwrite
block traversal times that were changed.

The frontend container serves the Angular production build with nginx and
forwards `/api/` to the backend. A development override with live reload and
the test tools is described under [Testing](#testing).

---

## Implemented Scope

| Requirement | Status | Notes |
| --- | --- | --- |
| Service definition and CRUD | Done | Vehicle, start time, ordered path, platform arrival and departure |
| Path connectivity validation | Done | Directed adjacency list; reverse direction is rejected |
| Same-vehicle conflicts | Done | Overlapping time windows and location discontinuity are rejected |
| Interlocking groups | Done | Treated as mandatory and rejected on write |
| Schedule Editor page | Done | `/editor` |
| Schedule Viewer page | Done | `/schedule`, read-only |
| Block Configuration page | Done | `/blocks` |
| Backend unit tests | Done | 206 tests |
| Bonus 1 — Conflict detection | Done | Block occupancy, low battery, insufficient charge; previewed in the editor and rejected on write |
| Bonus 2 — Interactive track map | Done | d3 map, click-to-build paths, playback with battery and conflicts |
| Bonus 3 — Auto-generate schedule | Not implemented | |

The three pages:

- **Schedule Editor**: build a path by clicking the next platform or yard on
  the map; the blocks on the way are added. The editor shows when the vehicle
  is free, and lists why a service would be rejected before it is saved.
- **Schedule Viewer**: a time axis per vehicle, services grouped by vehicle
  and ordered by time, and playback on the map with vehicle position, battery
  level, and active conflicts.
- **Block Configuration**: each block's traversal time is edited in place on
  the map.

---

## Data Model

PostgreSQL holds five tables. Columns and constraints are in
[`docs/PERSISTENCE_DESIGN.md`](docs/PERSISTENCE_DESIGN.md).

| Table | Purpose |
| --- | --- |
| `vehicles` | Seeded vehicle IDs (`V1` to `V5`) |
| `track_elements` | Yard, platforms, and blocks; blocks carry `traversal_seconds` and `interlocking_group` |
| `track_connections` | Directed `from_element_id -> to_element_id` edges |
| `services` | Vehicle and `start_time` of each service |
| `service_path_elements` | Ordered path occurrences, each with its saved `[start, end)` interval |

Rationale:

- **One table for yards, platforms, and blocks.** All three are nodes of the
  same directed graph, so a connection is a plain pair of foreign keys. The
  cost is that `traversal_seconds` and `interlocking_group` are null for
  non-blocks. If the types gained very different data, I would keep
  `track_elements` as the graph identity and move those fields to subtype
  tables.
- **Path and timeline share one table.** Each path occurrence stores its
  calculated interval, so a service and its timeline are saved atomically.
  Platform arrival and departure are the interval of that occurrence, keyed
  by `path_index`, so repeated visits to one platform stay distinct.
- **No occupancy table.** Vehicle, block, and interlocking occupancy are
  derived from the saved intervals when needed. This avoids a second copy of
  the schedule that could fall out of sync; at much larger scale it could be
  materialized and indexed.

---

## API Overview

Request, response, and error details are in
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md).

| Method and path | Behavior |
| --- | --- |
| `GET /services`, `GET /services/{id}` | Read saved services with their timelines |
| `POST /services` | Calculate the timeline, validate, and create |
| `PUT /services/{id}` | Replace all fields, recalculate, and validate |
| `DELETE /services/{id}` | Delete, unless the vehicle's remaining services would be disconnected |
| `GET /vehicles`, `GET /topology` | Seeded reference data |
| `GET /blocks`, `PUT /blocks/{id}` | Read and set block traversal time |
| `GET /schedule-analysis` | Bonus report: block occupancy and battery conflicts, and the playback data |

Errors:

| Status | Meaning |
| --- | --- |
| 404 | Unknown service or block |
| 422 | Invalid input: request shape, unknown vehicle, invalid path, or platform times that do not match the calculated timeline |
| 409 | Scheduling conflict: vehicle overlap, location discontinuity, interlocking, block occupancy, or battery |

A service request:

```json
{
  "vehicleId": "V1",
  "startTime": "2026-10-01T08:00:00",
  "path": ["Y", "B1", "P1A"],
  "platformTimings": [
    {"pathIndex": 2, "arrivalTime": "2026-10-01T08:00:20", "departureTime": "2026-10-01T08:00:50"}
  ]
}
```

A write is processed in one transaction: validate the vehicle and path,
calculate the timeline, check the vehicle's overlap and continuity, check
interlocking against other vehicles, then save. All writes take one PostgreSQL
advisory lock, so two conflicting requests cannot both succeed. A rejected
write changes nothing.

Scheduling rules live in `backend/app/domain` as pure functions with no
dependency on FastAPI or SQLAlchemy, so they are tested without a server or a
database.

---

## Design Trade-offs

The four decisions below had a real alternative. Smaller decisions follow in a
table.

### 1. Every detected conflict is rejected on write

**Decision.** Create and update are rejected with 409 when the service would
put two vehicles in the same interlocking group or on the same block at the
same time, run a vehicle below 30 battery units outside the yard, or have it
leave the yard below 80. One exception: a service that ends in the yard may
run low on the way there, so a vehicle can always drive home to charge; that
stretch is reported, not rejected.

**Why.** The assignment states the interlocking groups as a Track Map
constraint and lists block occupancy and the two battery conflicts under
Bonus 1, which asks to detect them. I first only reported the Bonus conflicts
after saving. That left two vehicles on `B5`, one physical track, merely
reported while `B1` and `B2`, different tracks, were rejected, and the user
could not see a conflict coming while building a service. The editor now shows
it on the map before saving and the backend rejects it.

**Cost.** A new schedule can no longer contain a conflict, so the conflict
list and markers in the Schedule Viewer only show conflicts saved before the
rule. The battery rules also restrict paths: a vehicle back in the yard must
wait there until it is charged to 80, and a path cannot pass through the yard
and continue, because the yard has no duration inside a path.

**Alternative.** Keep the Bonus conflicts as warnings and only preview them in
the editor. That keeps conflicts available for playback, but lets the user
save a schedule the system already knows cannot run.

### 2. Saved services keep a timeline snapshot

**Decision.** Each accepted service stores the calculated interval of every
path element. Changing a block's traversal time affects new services and
services that are updated afterwards. It does not recalculate saved ones.

**Why.** An accepted schedule should stay as it was accepted. Recalculating
from current block settings could move saved times and create conflicts
between services that nobody edited.

**Cost.** The timeline duplicates data that could be derived. After a block
change, the same block can appear with two traversal times in one schedule
until the older services are updated. The Schedule Editor detects such a
service when it is opened, recalculates its platform times, and shows a
warning; the Schedule Viewer does not mark it.

**Alternative.** Recalculating every affected service inside the block update
was rejected as unnecessary transaction complexity for this assignment. If
block changes had to be retroactive, I would add versioned configuration or an
explicit replanning step.

### 3. A path starts and ends at a platform or yard

**Decision.** A path whose first or last element is a block is rejected with
422. The assignment does not state this rule; it is a project decision.

**Why.** Between services a vehicle stays where its last service ended, but a
block is only occupied for its traversal interval. A vehicle left on a block
would hold no resource, so another vehicle could be scheduled through it with
no rejection and no reported conflict.

**Cost.** Some paths the adjacency list permits are not accepted, and a
journey cannot be split into two services at a block.

**Alternative.** Treating a parked vehicle as occupying its block until its
next service would keep such paths valid. I rejected it because the last
service of a vehicle has no end to that occupancy, and it would turn idle time
into an interlocking constraint the assignment does not describe.

### 4. The editor previews validation in the browser

**Decision.** The Schedule Editor works out what the backend would reject
while the path is being built: vehicle overlap, discontinuity, interlocking,
block occupancy, battery, and deletions that would disconnect a vehicle's
services. The save or delete button is disabled while a reason is listed. The
map shows every vehicle where it is, with its battery, at the instant the path
being built ends, and each click advances the map through the time it adds.
Dragging the timeline bar under the path moves the whole service in time, and
the times where saving would be rejected are hatched; a vehicle in the way and a battery that
would break a rule blink.

**Why.** A rejected save only says what was wrong afterwards. Showing the
reason on the map element it concerns lets the user fix the time or the path
first.

**Cost.** The rules exist twice: in the backend domain and in
`frontend/src/app/service-conflicts.ts` and `battery-preview.ts`. The backend validates every write and
remains the authority. The frontend copy is unit-tested, and a randomized
comparison over 700 create, update, and delete requests found no
disagreement, but that comparison predates the block occupancy and battery
previews and is not automated in the repository, so the two could drift. The previews also use the services loaded when the page
opened, so a write from another tab is not seen until the page is reopened.

**Alternative.** A validation endpoint that runs the domain checks without
saving would leave one implementation. I would add it with more rules or more
than one concurrent editor.

### Smaller decisions

| Decision | Reason | Cost |
| --- | --- | --- |
| The API receives the complete path and never searches for a route | The assignment is about scheduling and conflicts, not routing | An API client must send every block. The editor adds the blocks between two neighbouring stops, which is unique in this topology |
| Topology and vehicles are seeded, not editable | The assignment asks to manage services; only block traversal time must be configurable | No vehicle or topology management |
| Consecutive services of a vehicle must end and start at the same element | Physical continuity without inventing repositioning journeys | The user must schedule every move explicitly |
| Deleting a service is rejected if it disconnects the vehicle's remaining services | Otherwise a delete could create the discontinuity that create and update reject | A middle service must be replaced, not removed |
| One global advisory lock for all writes | Simple and correct for concurrent conflicting writes | Writes are serialized even for unrelated vehicles |

---

## Assumptions

The complete rules are in [`docs/DOMAIN_RULES.md`](docs/DOMAIN_RULES.md).

The assignment does not specify whether schedules cover a single day, repeat
daily, or vary by day of the week. Each service therefore represents one
run at explicit dates and times. Services are not restricted to a single
calendar day, and the system does not automatically repeat them daily or
weekly. Vehicle overlap and location continuity are still checked across
the saved services, including those on different dates. Recurring timetables
would require a separate template and rules for generating dated services.

- Vehicles are `V1` to `V5`, and each block defaults to 20 seconds. The
  assignment gives neither value.
- Time intervals are `[start, end)`. A vehicle may enter a resource at the
  instant another leaves it.
- A yard occurrence in a path has zero duration. Platform time comes from the
  service's own arrival and departure.
- Stations `S1`-`S3` are groupings only. Platforms of one station are not
  connected except through blocks, as the adjacency list defines.
- A path may visit the same element more than once, and has at most 200
  elements. Without a limit, one very long looping service slows every later
  validation.
- A vehicle has no position before its first service, so its first service may
  start anywhere.
- Battery (Bonus 1): each vehicle starts at 80, loses 1 per block traversed,
  and charges 1 per 12 seconds in the yard up to 100.
- Datetimes without an offset mean Asia/Taipei; responses use `+08:00`.

---

## Testing

The test tools are only in the development image, so the commands use the
development override, which also enables live reload:

```bash
alias dc='docker compose -f docker-compose.yml -f docker-compose.dev.yml'
dc up --build -d
```

Backend, against a separate test database (create and migrate it once):

```bash
dc exec database createdb -U vehicle_scheduling fastapi_scheduling_test
dc run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint alembic backend upgrade head
dc run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint python backend -m pytest tests -q
```

Frontend:

```bash
dc run --rm --no-deps frontend npm test
```

Last verified on 2026-10-02: backend **227 passed**,
frontend **175 passed**.

| Suite | Covers |
| --- | --- |
| Domain (`test_path_validation`, `test_timeline`, `test_vehicle_schedule`, `test_interlocking`, `test_service_update`, `test_schedule_analysis`, `test_schedule_conflicts`) | Path rules, timeline calculation, interval overlap, vehicle overlap and continuity, interlocking, update and delete validation, block occupancy and battery analysis and their write validation. No database needed |
| Persistence (`test_persistence`) | Migrations, idempotent seed, block configuration, repository CRUD, rollback |
| API (`test_api`) | Status codes and error bodies, rollback of rejected writes, concurrent conflicting writes |
| Frontend (Vitest) | Pure functions: platform time derivation, stale snapshot detection, path building, the editor previews, vehicle availability, playback position and battery, viewer grouping |

API tests commit real transactions and clear services, so they require a
database whose name ends in `_test`. Angular components, templates, and the d3
map have no unit tests; they were checked in the browser.

---

## Known Limitations

- Bonus 3 (automatic schedule generation) is not implemented.
- Deleting a service is not checked against the battery rules, and conflicts
  saved before block occupancy and battery were rejected stay in the database
  (see trade-off 1).
- The editor previews duplicate backend rules and do not see writes from
  another browser tab until the page is reopened (see trade-off 4).
- No vehicle or topology management, and no automatic route finding.
- Browser checks are not automated in the repository.

---

## Further Documentation

| Document | Content |
| --- | --- |
| [`docs/DOMAIN_RULES.md`](docs/DOMAIN_RULES.md) | Every scheduling rule, with examples |
| [`docs/TOPOLOGY.md`](docs/TOPOLOGY.md) | The track map, adjacency list, and interlocking groups |
| [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | Endpoints, payloads, errors, transactions |
| [`docs/PERSISTENCE_DESIGN.md`](docs/PERSISTENCE_DESIGN.md) | Schema, snapshot policy, transaction ownership |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Milestone status and verification history |
| [`docs/REVIEW_FINDINGS.md`](docs/REVIEW_FINDINGS.md) | Findings of a full review and how each was fixed |
