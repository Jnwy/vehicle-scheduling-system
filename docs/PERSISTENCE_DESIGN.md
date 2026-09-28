# Persistence Design

This document records the P0 persistence contract. It defines the schema and
ownership boundaries to implement before adding FastAPI behavior.

## Scope

Persistence stores:

- predefined vehicles
- the fixed assignment topology
- mutable traversal configuration for each block
- services with ordered path occurrences
- the calculated timeline snapshot for each path occurrence

Persistence does not implement scheduling rules. Path validation, timeline
calculation, vehicle overlap, and location continuity remain in the domain
modules.

## Timeline Snapshot Decision

When a service is created or updated, the application uses the current block
traversal configuration to calculate and validate its complete timeline. The
calculated interval for every path occurrence is persisted with the service.

Changing a block's `traversal_seconds`:

- affects services created afterward
- affects an existing service when that service is explicitly updated
- does not silently recalculate already persisted services

This keeps accepted schedules deterministic and prevents a configuration edit
from creating unreviewed vehicle overlap or platform timing failures in
existing services.

The trade-off is that timeline intervals are derived data. Writes must go
through the application workflow so path, platform timings, and interval
snapshots cannot diverge. Reading a service uses its persisted snapshot rather
than recalculating it from current block configuration.

## Topology Ownership

Track element identities, types, connections, and interlocking metadata are
seeded from the assignment topology. The mandatory application does not create
or delete topology structure.

Block traversal time is different: the assignment requires a read/write Block
Configuration page. Therefore `traversal_seconds` is mutable configuration and
must be persisted even though the surrounding topology structure is fixed.

Blocks start with `traversal_seconds = NULL` because the assignment provides no
default. Timeline calculation rejects a service path containing an
unconfigured block.

## Proposed Schema

### `vehicles`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | varchar | primary key |

Vehicle management CRUD is out of scope. Rows are seeded.

The assignment uses `V1` and `V2` as examples but does not provide a complete
vehicle inventory. The initial seeded inventory is explicitly defined as `V1`
and `V2` for this implementation.

### `track_elements`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | varchar | primary key |
| `element_type` | varchar | `YARD`, `PLATFORM`, or `BLOCK` |
| `traversal_seconds` | integer, nullable | null or non-negative |
| `interlocking_group` | varchar, nullable | seeded metadata |

Only block traversal configuration is mutable in the mandatory application.

### `track_connections`

| Column | Type | Rules |
| --- | --- | --- |
| `from_element_id` | varchar | foreign key to `track_elements.id` |
| `to_element_id` | varchar | foreign key to `track_elements.id` |

The two columns form the primary key. Connections are directed and seeded.

### `services`

| Column | Type | Rules |
| --- | --- | --- |
| `id` | integer identity | primary key |
| `vehicle_id` | varchar | foreign key to `vehicles.id`, required |
| `start_time` | timestamptz | required |

Deleting a vehicle that is referenced by a service is not supported. Vehicle
CRUD is outside the current scope.

### `service_path_elements`

| Column | Type | Rules |
| --- | --- | --- |
| `service_id` | integer | foreign key to `services.id`, cascade delete |
| `path_index` | integer | non-negative |
| `element_id` | varchar | foreign key to `track_elements.id` |
| `interval_start_time` | timestamptz | required |
| `interval_end_time` | timestamptz | required, not before start |

`(service_id, path_index)` is the primary key. Ordering is always by
`path_index`.

This table stores both the ordered path and its timeline snapshot. For a
platform occurrence, the snapshot start and end are its submitted arrival and
departure times. Therefore a second table containing duplicate platform times
is unnecessary. The application reconstructs `PlatformTiming` for platform
rows when an editable service representation is needed.

Contiguous indices, minimum path length, element type behavior, and timeline
continuity remain domain/application invariants rather than complex database
constraints.

## Mapping Rules

### Persistence to Domain

1. Load service path rows ordered by `path_index`.
2. Build the path tuple from `element_id`.
3. Build `TimelineInterval` values from the persisted interval snapshot.
4. Construct `ServiceSchedule` so its path/timeline invariants are checked.

The persisted snapshot is not recalculated during a normal read.

### Domain to Persistence

1. Accept only a path and timeline that have passed domain construction and
   validation.
2. Write the service row and every ordered path/timeline row in one
   transaction.
3. On update, replace the candidate's child path rows atomically.
4. On any failure, roll back the complete operation.

Repository code must not decide whether a path or schedule is valid. It only
persists already validated values and reconstructs domain objects.

## Transaction Boundary

Repository methods receive a session but do not commit independently. The
application layer owns commit and rollback so service validation and all child
writes can eventually share one transaction boundary.

Concurrency control for two simultaneous schedule writes is not solved by the
schema alone. The FastAPI/application integration milestone must select a
locking or isolation strategy after repository behavior is available.

## Seed Behavior

- Seed operations must be idempotent.
- Track elements and directed connections come from the assignment topology.
- Blocks are initially unconfigured (`traversal_seconds = NULL`).
- The vehicle seed is `V1`, `V2`.
- Seed execution must not overwrite user-configured traversal values.

## P0 Review Checklist

- [x] Timeline snapshot policy selected.
- [x] Mutable block configuration separated from fixed topology structure.
- [x] Minimal tables and ownership defined.
- [x] Ordering, keys, cascades, and transaction ownership defined.
- [x] Domain rules remain outside ORM models.
- [x] Seeded vehicle inventory confirmed as `V1`, `V2`.

P0 is complete and ready for review before P1 implementation begins.
