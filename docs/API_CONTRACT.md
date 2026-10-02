# FastAPI Scheduling Contract

Interactive OpenAPI documentation is available at
<http://localhost:8000/docs> after Docker startup. The frontend calls the same
endpoints through its `/api/` prefix.

## Endpoints

| Method and path | Success | Behavior |
| --- | --- | --- |
| GET /services | 200 | Saved snapshots, ordered by ID |
| GET /services/{id} | 200 | Saved service snapshot |
| POST /services | 201 | Calculate, validate, and create |
| PUT /services/{id} | 200 | Full replacement, recalculation, and final-schedule validation |
| DELETE /services/{id} | 204 | Validate remaining continuity, then delete; empty body |
| GET /vehicles | 200 | Seeded IDs, ordered by ID |
| GET /topology | 200 | Fixed elements and directed connections, in natural ID order |
| GET /blocks | 200 | Block traversal configuration, in natural ID order (`B2` before `B10`) |
| PUT /blocks/{id} | 200 | Replace traversal configuration |
| PUT /blocks | 200 | Replace the traversal configuration of several blocks, all or none |
| POST /blocks/preview | 200 | Report the services a set of block times would leave stale; saves nothing |
| GET /schedule-analysis | 200 | Bonus report: per-vehicle playback segments with battery, and detected conflicts |

Vehicles, topology elements, and blocks are returned in natural ID order;
services are ordered numerically. No vehicle or topology structure CRUD is
provided. Block occupancy and battery conflicts are rejected on write; the
analysis reports any that were saved before that rule.

## Service Input and Output

POST and PUT accept the service fields `vehicleId`, `startTime`, `path`,
and `platformTimings`. Every platform timing contains a strict integer
`pathIndex`, `arrivalTime`, and `departureTime`. Indexing starts at zero and
identifies an occurrence, allowing repeated platforms. `platformTimings` may be
omitted for paths without platforms; domain validation requires every platform
occurrence to have a timing. Unknown body fields, including `id` and `timeline`,
are rejected. PUT replaces all input rather than merging fields.

Example (with B1 at its default 20 seconds):

```json
{
  "vehicleId": "V1",
  "startTime": "2026-10-01T08:00:00",
  "path": ["Y", "B1", "P1A"],
  "platformTimings": [
    {"pathIndex": 2, "arrivalTime": "2026-10-01T08:00:20",
     "departureTime": "2026-10-01T08:00:50"}
  ]
}
```

Service responses contain these same fields, the server-assigned integer `id`,
and a `timeline` array. Each timeline occurrence contains `pathIndex`,
`elementId`, `startTime`, and `endTime`. Platform inputs are reconstructed from
saved platform intervals. GET never recalculates from current block settings.

Datetime strings without an offset mean Asia/Taipei. Offset-aware strings are
interpreted as absolute instants. Every datetime response includes Taiwan's
`+08:00` offset; numeric epoch input is rejected. Time normalization occurs at
the HTTP boundary, outside the domain.
Naive input is interpreted using Asia/Taipei, then normalized to a fixed
`+08:00` offset for calculation/output, including historical DST dates. UTC
and output timestamps must fit Python's supported datetime range; otherwise
the input is rejected with 422 before saving.

## Supporting Resources

GET /vehicles returns `[{"id":"V1"},{"id":"V2"},{"id":"V3"},{"id":"V4"},{"id":"V5"}]`.

GET /topology returns `elements` with `id`, `elementType`, `traversalSeconds`,
and `interlockingGroup`, plus `connections` with `fromElementId` and
`toElementId`. Only explicitly seeded directed edges are returned.

GET /blocks returns objects with `id`, `traversalSeconds`, and
`interlockingGroup`. Seeded blocks B1-B14 default to 20 seconds as a project
product choice, not an assignment-provided value. Seed execution fills existing
null values and preserves custom values. PUT accepts
`{"traversalSeconds":20}` and returns the updated block object. Values must be
JSON integers from 0 through 2147483647 (PostgreSQL INTEGER range); booleans,
floating point values, strings (including empty strings), null, omitted values,
negative values, and overflow are rejected with 422.
Existing service snapshots remain stable after configuration writes.

PUT /blocks accepts `{"changes":[{"id":"B1","traversalSeconds":25}]}` and
returns the updated block objects in request order. Values follow the same
rules as the single-block PUT. A block listed twice or a missing `changes`
field is rejected with 422. An ID that is not a block is rejected with 404 and
no block is changed.

POST /blocks/preview accepts the same body and writes nothing. It applies the
given times on top of the saved configuration and returns
`{"services":[...]}`: every saved service whose snapshot would differ from a
recalculation, ordered by start time. Each entry has `id`, `vehicleId`,
`startTime`, `path`, and `conflict`. A recalculation keeps the service's start
time, path, and platform dwell durations. `conflict` is null when updating that
service alone would be accepted, and otherwise `{"code","message"}` of the
error the update would return. Every service is checked against the saved
snapshots of the others, not against their recalculations. An empty `changes`
list reports the services that are stale under the saved configuration. The
preview takes no lock, so it describes the schedule at the time it was read.

## Schedule Analysis

GET /schedule-analysis reads the saved snapshots and changes nothing. It
returns `startTime` and `endTime` of the whole schedule (null when there are
no services), `vehicles`, and `conflicts`.

Each vehicle has `vehicleId` and ordered `segments`. A segment has
`segmentType`, `serviceId` and `pathIndex` (null while idle), `elementId`,
`startTime`, `endTime`, `batteryStart`, and `batteryEnd`. The Schedule Viewer
uses these segments for playback.

Each conflict has `conflictType`, `resourceId`, `startTime`, `endTime`,
`vehicleIds`, `serviceIds`, `elementIds`, and `message`:

| `conflictType` | Meaning |
| --- | --- |
| `BLOCK_OCCUPANCY` | Two or more vehicles occupy the same block in overlapping `[start, end)` intervals |
| `LOW_BATTERY` | A vehicle's battery is below 30 while it is not in the yard |
| `INSUFFICIENT_CHARGE` | A vehicle leaves the yard below 80 |

The battery model is defined in `DOMAIN_RULES.md` section 8.1. Interlocking is
not reported here because a violating service cannot be saved.

## Errors

| Status | Meaning |
| --- | --- |
| 404 | URL service/block resource does not exist (a platform is not a block resource) |
| 422 | Invalid request shape, vehicle reference, path, timing, or block configuration |
| 409 | Same-vehicle overlap, location continuity failure, cross-vehicle interlocking group or block occupancy violation, or battery conflict |
| 500 | Unexpected database failure; generic public message |

Domain/application errors return a `detail` object. `code` is the exception
class name, `message` is a readable explanation, and available context uses
snake_case attributes such as `path_index`, `element_id`, `service_id`,
`candidate_service_id`, `conflicting_service_id`, `from_service_id`, and
`to_service_id`. Null service IDs identify an unsaved candidate, which
`message` calls "the new service". Request shape
errors use FastAPI's standard `detail` array with field locations.

Path errors are 422 and are checked in this order: `PathTooShortError`
(fewer than 2 elements, `actual_length`), `PathTooLongError` (more than 200
elements, `actual_length`), `UnknownTrackElementError` (`element_id`), `MissingTrackConnectionError`
(`from_element_id`, `to_element_id`), then `PathEndpointOnBlockError`
(`element_id`, `path_index`) when the first or last path element is a block.
The first element is reported before the last.

Example:

```json
{"detail":{"code":"VehicleOverlapError","message":"The new service overlaps service 1 assigned to the same vehicle.",
           "candidate_service_id":null,"conflicting_service_id":1}}
```

Database failures return only
`{"detail":{"code":"DatabaseError","message":"Database operation failed."}}`.
Details are logged server-side. Failed writes leave persisted data unchanged.

Mandatory create/update validation rejects same-vehicle overlap and location
discontinuity before persistence. It also rejects cross-vehicle overlap of
blocks in the same interlocking group with `InterlockingConflictError` and
context `interlocking_group`, `candidate_service_id`, `conflicting_service_id`.
Different blocks within one group are exclusive, as is the same grouped block.
Only block intervals are compared, using `[start, end)`; touching endpoints and
empty intervals are allowed. Updates exclude the original service. A rejected
create leaves no service/child rows; a rejected update preserves the original.
After interlocking, create/update rejects two further conflicts with 409:

- `BlockOccupancyConflictError` (`block_id`, `candidate_service_id`,
  `conflicting_service_id`): another vehicle occupies the same block in an
  overlapping `[start, end)` interval. Grouped blocks are reported as
  `InterlockingConflictError` first.
- `BatteryConflictError` (`conflict_type` `LOW_BATTERY`,
  `INSUFFICIENT_CHARGE`, or `EMPTY_BATTERY`, `vehicle_id`,
  `candidate_service_id`): the write would add a battery conflict to a vehicle
  it touches. A service that ends in the yard is not rejected for running low
  on the way there, but any service is rejected with `EMPTY_BATTERY` when the
  vehicle would enter a block with less than one battery unit. See `DOMAIN_RULES.md`
  section 8.1 for what counts as added.

Deletion is not checked against either.

## Transactions and Concurrency

Application functions own `session.begin()` and commit/rollback. Repository
methods flush but do not commit. Each request receives a fresh session.
All service creates, updates, deletes, and block configuration writes acquire
PostgreSQL transaction advisory lock `72634001` before reading current data.
Validation and saving occur in the same transaction. The lock releases on
commit or rollback. Cross-vehicle interlocking checks use this same lock, so
two overlapping group writers cannot both persist successfully.
PostgreSQL's default READ COMMITTED isolation ensures a
writer that waited for the lock subsequently reads the committed schedule.
Create/update responses reuse the topology loaded within that transaction.
They perform no post-commit database query that could misreport an already
saved service as a database failure.

One global write lock is a deliberate small-project trade-off: writes are
serialized even for different vehicles, while normal reads remain unlocked.
Direct repository/SQL writes bypass this application guarantee; seeded topology
and vehicle administration is not exposed over HTTP.

Updates replace the target in the final schedule and revalidate the old and
new vehicles. Deletions validate the remaining adjacent pair. Domain validators
retain half-open interval semantics, empty intervals, and existing equal-time
neighbor selection. Persisted service IDs determine stable list/input order.

## Verification

Use the isolated database test commands in README. API tests commit real
transactions and require a database name ending in `_test`; they clear service
rows only in that explicitly designated database. Do not run concurrent test
suites against the same database.

`backend/tests/test_api.py` covers the status codes and error bodies above,
rollback of rejected writes, and two concurrent conflicting writers producing
exactly one 201 and one 409. Current results are recorded in
`IMPLEMENTATION_PLAN.md`.
