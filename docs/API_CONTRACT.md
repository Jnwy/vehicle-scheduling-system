# FastAPI Scheduling Contract

Implemented and verified on 2026-10-01. Interactive OpenAPI documentation is
available at <http://localhost:8000/docs> after Docker startup.

## Endpoints

| Method and path | Success | Behavior |
| --- | --- | --- |
| GET /services | 200 | Saved snapshots, ordered by ID |
| GET /services/{id} | 200 | Saved service snapshot |
| POST /services | 201 | Calculate, validate, and create |
| PUT /services/{id} | 200 | Full replacement, recalculation, and final-schedule validation |
| DELETE /services/{id} | 204 | Validate remaining continuity, then delete; empty body |
| GET /vehicles | 200 | Seeded IDs, ordered by ID |
| GET /topology | 200 | Fixed elements and directed connections |
| GET /blocks | 200 | Block traversal configuration, ordered by ID |
| PUT /blocks/{id} | 200 | Replace traversal configuration |

IDs are ordered lexicographically for topology/vehicles/blocks and numerically
for services. No vehicle/topology structure CRUD or bonus conflict enforcement
is provided.

## Service Input and Output

POST and PUT accept the README service fields: `vehicleId`, `startTime`, `path`,
and `platformTimings`. Every platform timing contains a strict integer
`pathIndex`, `arrivalTime`, and `departureTime`. Indexing starts at zero and
identifies an occurrence, allowing repeated platforms. `platformTimings` may be
omitted for paths without platforms; domain validation requires every platform
occurrence to have a timing. Unknown body fields, including `id` and `timeline`,
are rejected. PUT replaces all input rather than merging fields.

Example (configure B1 to 20 seconds first):

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

GET /vehicles returns `[{"id":"V1"},{"id":"V2"}]`.

GET /topology returns `elements` with `id`, `elementType`, `traversalSeconds`,
and `interlockingGroup`, plus `connections` with `fromElementId` and
`toElementId`. Only explicitly seeded directed edges are returned.

GET /blocks returns objects with `id`, `traversalSeconds`, and
`interlockingGroup`. Traversal may be null until configured. PUT accepts
`{"traversalSeconds":20}` and returns the updated block object. Values must be
JSON integers from 0 through 2147483647 (PostgreSQL INTEGER range); booleans,
floating point values, strings, null, negative values, and overflow are rejected.
Existing service snapshots remain stable after configuration writes.

## Errors

| Status | Meaning |
| --- | --- |
| 404 | URL service/block resource does not exist (a platform is not a block resource) |
| 422 | Invalid request shape, vehicle reference, path, timing, or block configuration |
| 409 | Vehicle overlap or location continuity failure |
| 500 | Unexpected database failure; generic public message |

Domain/application errors return a `detail` object. `code` is the exception
class name, `message` is a readable explanation, and available context uses
snake_case attributes such as `path_index`, `element_id`, `service_id`,
`candidate_service_id`, `conflicting_service_id`, `from_service_id`, and
`to_service_id`. Null service IDs identify an unsaved candidate. Request shape
errors use FastAPI's standard `detail` array with field locations.

Example:

```json
{"detail":{"code":"VehicleOverlapError","message":"Service null overlaps an existing service.",
           "candidate_service_id":null,"conflicting_service_id":1}}
```

Database failures return only
`{"detail":{"code":"DatabaseError","message":"Database operation failed."}}`.
Details are logged server-side. Failed writes leave persisted data unchanged.

## Transactions and Concurrency

Application functions own `session.begin()` and commit/rollback. Repository
methods flush but do not commit. Each request receives a fresh session.
All service creates, updates, deletes, and block configuration writes acquire
PostgreSQL transaction advisory lock `72634001` before reading current data.
Validation and saving occur in the same transaction. The lock releases on
commit or rollback. PostgreSQL's default READ COMMITTED isolation ensures a
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

## Verification and Acceptance

Use the isolated database test commands in README. API tests commit real
transactions and require a database name ending in `_test`; they clear service
rows only in that explicitly designated database. Do not run concurrent test
suites against the same database.

Docker verification: full suite `128 passed`, Alembic check reported no schema
drift, and a fresh `fastapi_workflow_test` database migrated/seeded through the
normal startup script. A real HTTP workflow on port 8001 returned 200 for block
configuration, 201 for create, 200 for read/update, and 204 for delete, followed
by an empty service list. Two independent-session conflict writers produced
exactly one 201 and one 409. Rollback recovery and shared-lock configuration
blocking are covered by PostgreSQL tests.

For user acceptance, configure blocks through `/docs`, create a service, verify
the saved timeline, edit it, and delete it. Try an overlap and a broken middle
deletion to observe 409 and unchanged data. Angular feature pages and final
frontend end-to-end acceptance remain future milestones.
