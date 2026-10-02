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

Last updated: 2026-10-02

| Phase | Status | Verification |
| --- | --- | --- |
| Docker project skeleton | Complete | Backend, frontend, and PostgreSQL services are defined |
| Path validation | Complete | Unit tests pass in Docker |
| Timeline calculation | Complete | Unit tests pass in Docker |
| Mandatory vehicle schedule validation | Complete | Unit tests pass in Docker |
| Persistence | Complete, reviewed | P0-P3 verified; review fixes verified in PostgreSQL and Docker |
| FastAPI CRUD | Complete | Domain update, HTTP, PostgreSQL transactions, and concurrency verified |
| Minimal Angular UI | Complete | Build and desktop/narrow browser checks pass |
| Three-page Angular routes | Implemented; user acceptance pending | One final `npm run build` passes; route interactions and visual checks not rerun |
| End-to-end Docker verification | Complete | Integrated Docker build, browser workflow, restart, and persistence verified |
| Mandatory interlocking exclusivity | Implemented | Targeted domain/API rollback and concurrency tests pass |
| General block occupancy/battery reports | Separate Bonus | Detect/report only; no mandatory write rejection |

Current full test command:

```bash
docker compose run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint python backend -m pytest tests -q
```

Last verified result:

```text
178 passed
```

Latest completed milestone commits:

```text
c82b907 feat: add minimal Angular scheduling interface
ea8b899 fix: allow Angular development origins
aed4abc feat: expose transactional scheduling API
10f851a feat: validate vehicle schedules on update and deletion
8262561 docs: document persistence design and milestone
8d1129f feat: add PostgreSQL persistence layer
3e233e1 feat: validate mandatory vehicle schedules
dd455c6 docs: separate mandatory rules from bonus conflicts
```

## Next Concrete Action: Review Follow-ups (2026-10-02)

A full review of `main` at `2d1fe00` recorded seven findings (F1-F7) and a
phased fix plan in [`REVIEW_FINDINGS.md`](REVIEW_FINDINGS.md).

Phases A and B are merged into `main`: F2 (`110afae`), F1 (`c50754e`), F6
(`267704a`), and F5 (`304093e`).

Phase C is done on branch `worktree-review-findings-plan` and not yet merged
into `main`: F4 (`bf7d5ae`, zero-duration service inside another service is
rejected) and F3 (`ef8b6d3`, production-form Docker images with a development
override). Full backend suite: `191 passed`.

Development and test commands now need the override file:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml ...`.

Next action: merge Phase C after user review, then Phase D (F7 documentation
cleanup), which needs user authorization. This
supersedes the older "Next Concrete Action" section below.

### Handoff Checkpoint (2026-10-02)

Work stops here and continues on another computer. Checkpoint: Phase C
complete and verified, not merged.

Git state:

- `main` (pushed): `faa0867`, contains Phases A and B
- `worktree-review-findings-plan` (pushed): contains Phase C on top of
  `main`, fast-forwardable; head is this handoff commit
- no uncommitted work is part of this checkpoint

To resume:

```bash
git fetch origin
git checkout worktree-review-findings-plan
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

Then create the test database and run the full suite with the commands in
the README "Running Tests" section. Expected result: `191 passed`.

To merge Phase C after review:

```bash
git checkout main
git merge --ff-only worktree-review-findings-plan
git push origin main
```

Open decisions, all for the user:

1. Merge Phase C into `main`.
2. Start Phase D (F7): reduce this document to current status, decisions, and
   verification results, and fold `docs/BONUS_IMPLEMENTATION_HANDOFF.md` into
   other documents before removing it.
3. Add a frontend unit-test setup or not. `savedTimingsAreStale` in
   `service-timing.ts` and `buildVehicleOverviews` in `schedule-overview.ts`
   have browser verification only.

Not verified at this checkpoint:

- the default stack on its published ports 8000 and 4200; Phase C was
  verified on alternate host ports beside a running stack
- Bonus 3 remains not implemented

Local-only state on the previous computer, not needed to continue: a scratch
database `review_fresh_start_test`, the application database volume, browser
check scripts and screenshots, and a checkout still on
`codex/basic-version-integration` at `2d1fe00`.

## Active Handoff: Integration Recovery (2026-10-02)

A previous agent stopped in the middle of integrating parallel work onto
`codex/basic-version-integration`. Read this section before any Git operation.

### Git state at handoff

- The cherry-pick of `0257744` (`fix: enforce interlocking schedule
  constraints`) is committed as `bea8c38`. Its three conflicts
  (`backend/tests/test_api.py`, `docs/DOMAIN_RULES.md`,
  `docs/IMPLEMENTATION_PLAN.md`) were resolved before the commit.
- The remaining working-tree changes belong to the separate follow-up commits
  listed below. Stage them by explicit path, never with `git add -A`.
- Conflict resolution note: the HEAD API test for schedule analysis used two
  vehicles on B1 at the same time. B1 is in interlocking group IG1, so that
  write is now rejected. The test was moved to ungrouped block B5.

### Decision: no separate interlocking warning in Bonus analysis

Confirmed by the user on 2026-10-02. Interlocking group exclusivity is a
mandatory Track Map rule enforced at create/update (409), so persisted
schedules cannot contain it. `schedule_analysis` no longer emits an
`INTERLOCKING` conflict; it reports general block occupancy and battery only.
The frontend `ConflictType` union was narrowed to match.

### Unstaged follow-up changes (separate commits)

1. `refactor: drop redundant interlocking warning from schedule analysis`:
   `backend/app/domain/schedule_analysis.py`,
   `backend/tests/test_schedule_analysis.py`, `frontend/src/app/models.ts`,
   `docs/BONUS_IMPLEMENTATION_HANDOFF.md`
2. `docs: add Claude Code entry point and integration handoff`:
   `CLAUDE.md`, this section of `docs/IMPLEMENTATION_PLAN.md`, and the README
   design decision "Interlocking as a Write-Time Rule, Block Occupancy as a
   Report" (user confirmed interpretation and wording on 2026-10-02)

### Verification at handoff

Run outside Docker against a local PostgreSQL 16 `*_test` database with
Python 3.11; the project image uses Python 3.13:

- cherry-pick content (now `bea8c38`): full backend suite `176 passed`
- with the analysis refactor applied: full backend suite `176 passed`
- not run at handoff: Angular build, Docker suite, browser checks

Rerun in Docker on 2026-10-02 (Python 3.13, `fastapi_scheduling_test`):

- cherry-pick content before `bea8c38` was committed: `176 passed`
- `bea8c38` plus the analysis refactor: `176 passed`
- Angular `npm run build` in the frontend container with the narrowed
  `ConflictType`: succeeded
- still not run: image rebuild, `alembic check`, browser checks

### Progress after handoff (2026-10-02)

- Steps 1-3 and 5 below are done: follow-ups committed as `c2661b9` and
  `c41be75`; `3b3a7e7` cherry-picked as `c21d4ad` (full Docker backend suite
  `176 passed`, `npm run build` succeeded); README gained Data Model, API
  Overview, and Assumptions sections.
- Skipped by user decision for the minimal deliverable: step 4 (`b20d53e` and
  `stash@{0}`), Bonus 3, and step 7 (worktree cleanup).
- Step 6 verified: `docker compose up --build` from a fresh clone with a new
  volume migrated and seeded; `/editor`, `/schedule`, and `/blocks` loaded;
  service create, block save, the 409 interlocking rejection, and the 422
  rejection of `P1A -> P1B` behaved as expected. The 409 message was checked
  through the API, not in the editor UI. The user delegated the merge
  decision; the branch was fast-forwarded into `main` and pushed.

### Next steps (each requires explicit user authorization to commit)

1. Run the full Docker test suite (command below) on `bea8c38` plus the
   working-tree changes.
2. Commit the two unstaged follow-ups listed above, one commit each.
3. Cherry-pick `3b3a7e7` (`feat: complete scheduling frontend workflow`). It
   adds the separate Schedule Editor, read-only Schedule Viewer, and Block
   Configuration routes required by the assignment. Expect a conflict only in
   this document. Then run `npm run build` and check all three pages in a
   browser, including the 409 interlocking error message in the editor.
4. Compare `b20d53e` (track map layout refinement) and `stash@{0}` against
   `3b3a7e7`; both touch the same frontend files. Pick or drop with the user.
5. README: add inline data model and API overview sections and an explicit
   Assumptions section (assignment submission guideline), and refresh the
   test count.
6. Verify `docker compose up` from a clean volume, merge into `main`, and push.
   `origin/main` is still at `8262561` (persistence milestone).
7. Optional cleanup: `git worktree prune` for stale `.codex/worktrees` entries.

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
- Mandatory Track Map interlocking validation rejects cross-vehicle overlapping
  block intervals within the same group, including different blocks. Touching
  endpoints and empty intervals are allowed.
- Update validation excludes the existing service with the same non-null ID.
- Full update validation checks the final schedules of both affected vehicles.
- Domain logic is independent from FastAPI, SQLAlchemy, and database sessions.

See `docs/DOMAIN_RULES.md` for the complete rules and assumptions.

### Core/Bonus Boundary Correction: 2026-10-02

The original assignment's Track Map interlocking constraint is mandatory.
Same-vehicle overlap, location discontinuity, and cross-vehicle interlocking
violations reject create/update with 409 and preserve persisted data. General
block occupancy, low battery, and insufficient charge are Bonus detect/report
behavior; they do not independently reject writes.

A real HTTP reproduction with nonzero service duration confirmed that existing
same-vehicle overlap and continuity already return 409; failed writes preserved
data and touching intervals were accepted. The missing interlocking validator
now compares per-block snapshot intervals using `[start, end)` within the
existing shared advisory-lock transaction. No schema change is required.

Targeted verification: `test_interlocking.py`, `test_vehicle_schedule.py`, and
`test_api.py` passed 103 tests. Disabling only the new interlocking validator in
an isolated test process made all three API create/update rejection cases fail,
confirming the regression tests catch missing validation.

Full Docker backend suite after integrating the correction on
`codex/basic-version-integration` (2026-10-02): `176 passed` with the known
Starlette/AnyIO deprecation warning, using the existing backend image and
`fastapi_scheduling_test`. No image rebuild, `alembic check`, frontend build,
or browser verification was rerun for this correction.

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
- General block occupancy and battery Bonus reports
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

### Seeded Block Default Decision

Confirmed on 2026-10-02: blocks B1-B14 start at 20 seconds as a project product
default, not an assignment-provided duration. Idempotent seed execution fills
null values with 20 and preserves non-null custom values, including zero.
Block API updates require a non-negative integer and cannot clear the value.

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

The mandatory baseline is complete on `codex/basic-version-integration`.
The routed frontend follow-up is implemented locally; user acceptance of the
three routes and map presentation is next. The user has authorized a local
frontend commit and integration through the coordination thread; no push is
authorized. The routed frontend, time-entry simplification, and non-empty block
configuration form one verified frontend workflow checkpoint.
This follow-up preserves the existing bonus analysis/playback code without
adding new bonus rules or changing the backend.

### Routed Three-Page Frontend

- Editor time-entry follow-up: new services default to the next five-minute
  boundary in Taipei. Every platform occurrence is generated from the ordered
  path with a default 60-second dwell (zero is allowed). Arrival/departure
  previews follow configured block times and preceding platform dwell, and are
  sent using the unchanged `platformTimings` API schema. Start/path/dwell edits
  and refreshed block configuration recalculate the preview. Opening an existing
  service derives its dwell from saved timings and preserves its saved times
  until a timing input or relevant block configuration changes. Missing block
  configuration is shown with a link to `/blocks` and prevents submission.
  No backend/domain/dependency changes were made. Existing Docker development
  compilation passed; focused timing checks passed for five-minute defaults,
  Taipei midnight, repeated platform visits, zero/invalid dwell, and missing
  blocks. No persistent test files, additional production build, browser checks,
  screenshots, backend tests, or full Docker verification were added/run.
- `/` redirects to `/editor`. `/editor`, `/schedule`, and `/blocks` are separate
  standalone route components with shared navigation and active-link state.
  The existing Angular dev server provides the SPA fallback for direct URLs;
  direct-route refresh behavior is pending user acceptance.
- Editor retains service create/update/delete, vehicle and start time inputs,
  ordered path editing, platform occurrence timings, saved timelines, and
  409/422/general error feedback. Successful writes reload server data.
- Viewer has no schedule mutation controls. It retains saved service timelines,
  playback, vehicle positions, battery state, and bonus conflict warnings.
  Leaving the route cancels playback and pending page subscriptions.
- Blocks retains independent per-block traversal configuration, loading/saving
  states, and success/error feedback. Blank input is not treated as zero.
  Saving reloads block configuration and its topology reference; persisted
  service timeline snapshots remain unchanged.
- Shared API calls and datetime/error formatting were extracted without
  changing endpoint/request contracts or Asia/Taipei input interpretation.
  Each route reloads server data on entry. Unsaved form drafts are local to the
  route component and are discarded when navigating away.
- Map presentation keeps S3/S2/S1 left-to-right with Yard on the right, aligns
  crossover block positions and compact station bands, and distinguishes the
  editing endpoint from playback vehicle labels. Two vehicles on the same
  element use separate marker offsets. Directed connections are unchanged.
- Dependency installation uses `npm ci` and the existing `package-lock.json`.
  The Homebrew Node ICU problem is bypassed using the bundled Node executable
  with the existing npm CLI, not another package manager. Package manifests
  and the lockfile are unchanged.
- Verification: one final `npm run build` passed without warnings; no new
  tests were added. Backend/domain tests, full Docker verification, browser
  workflows, screenshots, pixels, and responsive visual checks were not run.
  User acceptance must cover direct-route refresh, navigation, CRUD/error
  feedback, per-block writes, playback cleanup, and map/label presentation.
- Local preview unified on user request: the existing frontend container was
  recreated with `docker compose up -d --no-deps frontend` from this `c980`
  checkout. Its `/app/src` mount now points to this checkout's `frontend/src`.
  Docker development compilation succeeded and `http://localhost:4200/editor`
  returned HTTP 200. Port 4201 has no remaining preview listener. Backend and
  database containers were not recreated; existing CORS already allows 4200.
  No image rebuild, dependency change, commit, or push was performed.
  Browser/API interaction and visual acceptance remain pending.

### Completed Angular and Final Integration — 2026-10-01

- Added the standalone Schedule Editor with topology reference, block traversal
  configuration, service CRUD, platform timing rows, and timeline inspection.
- Added browser-safe CORS for `localhost:4200` and `127.0.0.1:4200` without
  credentials; other origins do not receive an allow-origin response header.
- Docker images rebuilt successfully; frontend `npm ci` and production build
  completed with no reported dependency vulnerabilities.
- Full Docker backend suite: `131 passed` with one upstream Starlette/AnyIO
  deprecation warning. `alembic check` reported no schema drift.
- Browser acceptance completed block configuration, service create, timeline
  display, update, overlap rejection (409), invalid-path rejection (422), and
  deletion. The test service was removed afterward.
- Restarting database, backend, and frontend preserved block `B1` traversal at
  20 seconds; all containers recovered healthy and the service list remained
  empty.

### Completed FastAPI Checkpoints — 2026-10-01

- Branch: `codex/fastapi-scheduling`; prior uncommitted deletion domain/tests/docs
  were preserved. No commit or push was authorized or performed.
- Domain: final-schedule update validation replaces the original in place and
  checks both affected vehicles. Same-time input-order behavior remains intact.
  Initial checkpoint: 39 domain tests passed; additional legal reassignment and
  zero-duration update tests were included in the final full suite.
- API: all requested service CRUD, seeded reads, and block configuration routes
  are implemented. Naive datetimes mean Asia/Taipei; offset inputs preserve the
  instant; all datetime responses use +08:00. API checkpoint: 115 passed.
- Transactions: service/configuration writers share transaction advisory lock
  72634001 before reading, with application-owned commit/rollback. Repositories
  remain without commit or domain validation. API tests use a separate `_test`
  database because they commit real transactions and reset services there.
- Integration: full Docker suite on `fastapi_scheduling_test`: 123 passed;
  one dependency deprecation warning from Starlette/AnyIO. Alembic check found
  no schema drift. Independent concurrent sessions produced one create success
  and one conflict; shared block-write locking and rollback recovery passed.
- `docker compose up --build -d` revealed CRLF in the Linux startup script.
  Converted `backend/start.sh` to LF and added `*.sh text eol=lf` in
  `.gitattributes`; rebuilt and confirmed successful backend startup.
- Fresh `fastapi_workflow_test` database initialized by the normal startup
  migration/seed script. Actual HTTP on port 8001 completed block configuration
  (200), create (201), read (200), update (200), delete (204), empty list (200).
  Main backend/database/frontend containers also ran successfully. This is
  backend integration evidence, not final Angular feature acceptance.
- Formal contract: `docs/API_CONTRACT.md`; domain decisions: Rules 11.1/11.2.
  No unresolved domain decisions for this milestone. Remaining known limitation:
  global lock serializes every schedule/configuration write by design.
- Reviewable commit groups: domain validation/tests; application/API/tests and
  HTTP contract; Docker line-ending rule and milestone/setup documentation.

### FastAPI Code Review — 2026-10-01

- Windows sandbox process startup still fails with error 1385; authorized
  execution outside the sandbox allowed Git inspection and Docker tests.
- Reviewed domain update/deletion rules, application transactions and advisory
  locking, HTTP schemas/errors, repository mapping, and integration tests.
- Reproduced and fixed post-commit topology queries for create/update responses:
  a query failure previously returned 500 after persisting the write. The
  application now returns the already loaded topology alongside the schedule;
  response construction needs no further database read. Both regression cases
  failed before the fix and pass afterward.
- Reproduced historical offset output as +09:00 instead of the promised +08:00.
  Naive inputs still use Asia/Taipei interpretation; all inputs normalize via
  UTC to a fixed +08:00 offset for elapsed-time calculation and response output.
  Reject UTC/output datetime overflow before saving, including early year-1
  inputs whose UTC instant is outside Python's supported range.
- Added five API regression cases. Complete isolated PostgreSQL/Docker suite:
  128 passed, with the same third-party Starlette/AnyIO deprecation warning.
  No unresolved review findings; no commit/push performed.

### Authorized Milestone Commits — 2026-10-01

- User approved the proposed commit grouping. Retained branch
  `codex/fastapi-scheduling`; no additional branch was needed.
- Pre-commit full Docker/PostgreSQL verification: 128 passed; staged changes
  were reviewed and whitespace checks passed.
- Domain commit `10f851a` includes update/deletion validation, tests, and rules.
- API commit `aed4abc` includes application/HTTP code, schemas, dependency,
  API tests and contract, and both verified review fixes.
- Remaining setup/docs form the final commit: shell LF checkout rule, README,
  persistence transaction documentation, and this milestone record.
- User acceptance and any later phase remain separate. No push was requested.

### Confirmed Decision: Service Deletion — 2026-10-01

- User decision: reject deletion when it would break location continuity between
  the remaining services for the same vehicle.
- If deleting a middle service makes its predecessor and successor adjacent,
  require the predecessor's end location to equal the successor's start location.
  First, last, and only-service deletion has no newly adjacent pair to check.
- A rejected deletion must report the continuity failure and preserve stored data.
- Record the rule in `docs/DOMAIN_RULES.md`, Rule 11.1. The pure domain validator
  is implemented, tested, and enforced by the application/API transaction.
- FastAPI/application acceptance criteria: test rejected middle deletion,
  permitted continuous middle deletion, first/last/only-service deletion,
  independence from other vehicles, and unchanged data on rejection.
- Validate and delete within the shared transaction/concurrency strategy. Keep
  scheduling rules out of repository code. The completed HTTP mapping is defined
  in `docs/API_CONTRACT.md`.

## Future Milestones

### Deletion Domain Checkpoint — 2026-10-01

- Implemented `validate_service_deletion(target, existing_services)` independently
  of HTTP and persistence. It excludes the persisted target and other vehicles,
  uses the same time-based neighbor selection as create/update validation, and
  reports the remaining predecessor/successor continuity failure.
- Added ten domain cases for broken/continuous deletion, first/last/only deletion,
  other vehicles, immediate neighbors, zero duration, incomparable times, and
  required target identity. Added two PostgreSQL integration cases for preserved
  data on validation rejection and successful validated cascade deletion.
- Full suite verified in Docker against `persistence_review`: `78 passed`.
- Repository deletion remains a storage operation. HTTP enforcement, a shared
  application transaction, and concurrency control are not implemented yet.
- Next: finalize the API/application contract, including datetime input handling
  and whether updates that remove a service from its old schedule must also check
  the old remaining neighbors. Multiple simultaneous zero-duration services still
  use existing input-order tie behavior; no new domain ordering was introduced.

### Execution and Reporting Agreement — 2026-10-01

- The agent handles implementation, relevant tests, integration checks, and
  documentation. The user reviews material decisions and performs acceptance.
- Development estimates describe total work time, not continuous user involvement.
- Maintain Traditional Chinese reading copies of project documents in the
  existing `.local-docs/` directory, which is already ignored by Git. Reuse
  existing corresponding files where available and synchronize reading copies
  when source documents change. Do not create a separate `.local/` directory.
  Tracked English documents remain the authoritative source for durable
  decisions and handoff context.
- Report each checkpoint concisely: completed behavior, verification result,
  remaining work, and any decision required from the user.
- Record confirmed material decisions and checkpoint outcomes in this document;
  keep domain rules in `docs/DOMAIN_RULES.md`. Do not rely on chat for handoff.
- Announce lengthy work such as dependency/image builds, database integration
  tests, and fresh-environment Docker verification before starting. Estimates
  are provisional; report meaningful delays and blockers.
- Proceed through the following checkpoints within the requested mandatory
  delivery scope, without adding bonuses:
  1. Define the API/application contract: payloads, error mapping, transaction
     ownership, concurrency strategy, and the confirmed deletion rule.
  2. Implement and test FastAPI service CRUD and supporting topology/vehicle
     reads and block traversal configuration.
  3. Implement the minimal Schedule Editor, read-only Schedule Viewer, and
     Block Configuration pages; verify the frontend build and integration.
  4. Verify fresh-database Docker startup, full backend tests, and the mandatory
     workflow; finish README and tracked milestone status.
  5. Provide a concise user acceptance checklist and disclose any remaining
     failures or limitations. User acceptance is separate from agent checks.
- Resolve routine implementation choices autonomously. Ask before ambiguous
  changes to domain rules or topology. Explicit authorization is still required
  for each commit; this agreement does not authorize commits or pushes.

### FastAPI CRUD

- Define request/response schemas.
- Load persistence data and call the existing domain functions.
- Map domain exceptions to HTTP responses.
- Ensure create/update validation and persistence share one transaction
  boundary where required.
- Implement the confirmed deletion continuity rule with domain tests and
  application/API tests proving rejected deletion leaves persisted data unchanged.

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
