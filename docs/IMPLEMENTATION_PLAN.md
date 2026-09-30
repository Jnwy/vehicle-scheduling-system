# Implementation Plan

This document is the tracked handoff and milestone status for the project.
Update it when a milestone is completed, its scope changes, or a durable design
decision affects later work. Do not use it as a log of every small edit.

## Requirement Priority

When sources conflict, use this order:

1. The original assignment:
   <https://hackmd.io/@preston-tseng/ryyg7AysWe>
2. Explicit decisions recorded in `docs/DOMAIN_RULES.md`
3. The fixed network in `docs/TOPOLOGY.md`
4. The current milestone and handoff information in this document
5. The project overview in `README.md`

Do not silently resolve a conflict that changes the domain model. Record the
conflict and ask for clarification first.

## Current Status

Last updated: 2026-09-30

| Phase | Status | Verification |
| --- | --- | --- |
| Docker project skeleton | Complete | Backend, frontend, and PostgreSQL services are defined |
| Path validation | Complete | Unit tests pass in Docker |
| Timeline calculation | Complete | Unit tests pass in Docker |
| Mandatory vehicle schedule validation | Complete | Unit tests pass in Docker |
| Persistence | Complete, reviewed | P0-P3 verified; review fixes verified in PostgreSQL and Docker |
| FastAPI CRUD | Next | Persistence review complete; begin with API/application contract |
| Minimal Angular UI | Not started | Deferred until API behavior is stable |
| End-to-end Docker verification | Not started | Required before final delivery |
| Block/interlocking conflicts | Deferred bonus | Not part of mandatory implementation |

Current full test command:

```bash
docker compose exec backend python -m pytest tests
```

Last verified result:

```text
66 passed
```

Latest completed milestone commits:

```text
8262561 docs: document persistence design and milestone
8d1129f feat: add PostgreSQL persistence layer
3e233e1 feat: validate mandatory vehicle schedules
dd455c6 docs: separate mandatory rules from bonus conflicts
```

## Completed Domain Contract

The following behavior is already implemented and should not be duplicated in
FastAPI or persistence code:

- The railway topology is a directed graph.
- Users provide complete paths; the system does not perform route finding.
- Path validation checks minimum length, known elements, and every directed
  connection.
- Timeline calculation uses service `start_time`, block
  `traversal_seconds`, service-owned platform timings, and zero-duration yards.
- Platform timings use zero-based `path_index` and allow zero-duration platform
  intervals.
- Scheduling intervals use `[start, end)` semantics; `[t, t)` is empty.
- `ServiceSchedule` is immutable and requires a non-empty, index-aligned path
  and timeline.
- Mandatory vehicle validation rejects same-vehicle overlap and enforces
  predecessor/successor location continuity.
- Update validation excludes the existing service with the same non-null ID.
- Domain logic is independent from FastAPI, SQLAlchemy, and database sessions.

See `docs/DOMAIN_RULES.md` for the complete rules and assumptions.

## Completed Milestone: Persistence

### Objective

Persist seeded infrastructure and service input in PostgreSQL, and reconstruct
the existing domain objects without moving business rules into the ORM layer.

### In Scope

- SQLAlchemy engine, session, and declarative model setup
- Database migrations
- Deterministic seed data for vehicles and the assignment topology
- Persistence models for services and ordered path/timeline snapshots that
  retain each platform occurrence timing
- Mapping between persistence records and existing domain objects
- Repository-level create, read, update, delete, and list behavior
- Transaction rollback on failed persistence operations
- PostgreSQL integration tests executed through Docker
- Documentation of schema and transaction decisions

### Out of Scope

- FastAPI routes and request/response schemas
- HTTP error mapping
- Angular integration
- Vehicle or topology structure management CRUD; block traversal configuration
  remains in scope
- Authentication and authorization
- Block/interlocking bonus conflicts
- Production database deployment or tuning

### Timeline Storage Decision

The project uses timeline snapshots. When a service is created or updated, its
calculated interval for every path occurrence is persisted.

Block traversal configuration remains mutable, but changing it does not
silently recalculate existing services. The new value applies to future service
creation and explicit service updates.

See `docs/PERSISTENCE_DESIGN.md` for the schema, mapping, and transaction
contract.

### Seeded Vehicle Decision

The assignment uses `V1` and `V2` as examples but does not define a complete
vehicle inventory. This implementation explicitly defines the initial seeded
inventory as `V1` and `V2`.

### Persistence Definition of Done

The milestone is complete only when:

1. A migration can initialize a fresh PostgreSQL database.
2. Vehicles and the fixed topology are seeded deterministically.
3. Service `vehicle_id`, `start_time`, ordered path, and platform timings can be
   persisted without loss of ordering or occurrence identity.
4. Reading a service reconstructs the saved domain schedule from its persisted
   timeline snapshot, independent of later block configuration changes.
5. Repository create, get, list, update, and delete behavior is covered by
   database integration tests.
6. Failed writes roll back without leaving partial service data.
7. Existing domain unit tests still pass unchanged, except for intentional
   test-only helpers.
8. The complete suite passes inside Docker.
9. Container restart behavior is checked against the named PostgreSQL volume.
10. No FastAPI, UI, or bonus behavior is introduced.

### Planned Checkpoints

#### P0: Persistence Contract

- Status: complete.
- Timeline snapshot behavior is recorded in `docs/DOMAIN_RULES.md`.
- Table ownership, ordering, uniqueness, cascade, mapping, and transaction
  rules are defined in `docs/PERSISTENCE_DESIGN.md`.
- Seeded vehicle inventory is confirmed as `V1`, `V2`.

#### P1: Database Foundation

- Status: complete.
- Add SQLAlchemy and migration tooling using the existing project dependency
  pattern.
- Configure sessions from `DATABASE_URL`.
- Add the initial migration and deterministic seed path.

#### P2: Service Persistence

- Status: complete.
- Implement minimal persistence models and mapping functions.
- Implement repository CRUD without embedding scheduling rules.
- Keep transaction ownership explicit.

#### P3: Integration Verification

- Status: complete.
- Add PostgreSQL integration tests.
- Run the complete Docker test suite.
- Verify migration, seed, rollback, and container restart behavior.
- Update this document with results and the next milestone.

Verification completed on 2026-09-29:

- initial migration applied successfully to the existing empty database
- Alembic reported no ORM/migration schema drift
- idempotent seed created 21 elements, 28 directed connections, and vehicles
  `V1`/`V2`
- PostgreSQL and backend restart preserved a configured traversal value and
  seed did not overwrite it
- repository create, get, list, update, delete, rollback, timeline snapshot,
  and block configuration behavior passed integration tests
- full Docker suite: `61 passed`
- backend health endpoint returned `{"status":"ok"}`

### Persistence Review: 2026-09-30

- Status: complete; review fix and tests are verified in PostgreSQL and Docker.
- The current local application database had no migrated tables, so the first
  review run produced `49 passed, 12 errors` during integration-test setup.
  This was an environment prerequisite failure, not a confirmed repository bug.
- A separate PostgreSQL database, `persistence_review`, was initialized with
  `alembic upgrade head`; the application database was left unchanged.
- PostgreSQL regression tests reproduced stale path/timeline snapshots after
  an update when the service ORM record and its relationship were already
  loaded. The fix expires only `path_elements` after successful replacement.
- Added five test cases covering get/list after a loaded update, successive
  updates, rollback after child insertion failure, and repeated platform
  occurrence ordering/timing.
- Existing snapshot stability, cascade deletion, seed preservation, and
  caller-owned transaction tests passed. No domain or repository interface
  changes were required.
- Full Docker suite: `66 passed`; `alembic check` detected no schema drift.

Review verification commands (database must already exist):

```bash
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/persistence_review --entrypoint alembic backend upgrade head
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/persistence_review --entrypoint python backend -m pytest tests -q
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/persistence_review --entrypoint alembic backend check
```

### Next Concrete Action

Begin the FastAPI API/application contract when that phase is explicitly
requested. Define service CRUD and supporting seeded topology/vehicle reads,
mutable block configuration, request/response schemas, and HTTP error mapping.
Select a locking or isolation strategy for concurrent schedule writes before
implementing the shared validation/persistence transaction boundary. Angular
and bonus conflict rules remain deferred.

## Future Milestones

### FastAPI CRUD

- Define request/response schemas.
- Load persistence data and call the existing domain functions.
- Map domain exceptions to HTTP responses.
- Ensure create/update validation and persistence share one transaction
  boundary where required.

### Minimal Angular UI

- List services.
- Create, edit, and delete services.
- Display validation failures clearly.
- Use seeded vehicles and topology; do not add infrastructure management UI.

### Final Integration

- Verify `docker compose up --build` from a fresh checkout.
- Run backend tests in Docker.
- Exercise the mandatory service workflow end to end.
- Complete reviewer-facing setup and trade-off documentation.

## Cross-Machine Handoff

Before moving work to another computer or agent:

1. Complete or clearly stop at a named checkpoint.
2. Run the relevant tests and record the result here.
3. Update current status, durable decisions, unresolved questions, and the next
   concrete action.
4. Review and commit only coherent tracked changes after explicit user
   authorization.
5. Push the commits to the shared Git remote.

On the new computer:

1. Check out the intended commit or branch.
2. Read `AGENTS.md` and every document listed there.
3. Run `docker compose up --build`.
4. Run the test command recorded above.
5. Continue from the current checkpoint in this document.

The following state does not travel through Git:

- `.local-docs/` interview and personal review material
- uncommitted changes
- local PostgreSQL Docker volume contents
- local secrets and environment overrides
- chat history that was not converted into tracked decisions

Do not depend on any of this local-only state for application correctness.

## Update Policy

Update this document when:

- a milestone or checkpoint is completed
- the active phase changes
- a durable implementation decision is made
- a blocker or unresolved requirement affects the next agent
- verification commands or results materially change

Do not update it merely to record routine file edits. Code history belongs in
Git; stable rules belong in `DOMAIN_RULES.md`; personal interview notes belong
in `.local-docs/`.
