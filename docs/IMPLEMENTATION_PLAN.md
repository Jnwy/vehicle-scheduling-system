# Implementation Plan

This document is the tracked milestone status for the project: what is done,
how it was verified, which decisions are durable, and what comes next. Update
it when a milestone completes or a durable decision changes, not for every
small edit.

## Requirement Priority

When sources conflict, use this order:

1. The original assignment:
   <https://hackmd.io/@preston-tseng/ryyg7AysWe>
2. Explicit decisions recorded in `docs/DOMAIN_RULES.md`
3. The fixed network in `docs/TOPOLOGY.md`
4. The current milestone information in this document
5. The project overview in `README.md`

Do not silently resolve a conflict that changes the domain model. Record the
conflict and ask for clarification first.

## Current Status

Last updated: 2026-10-02

| Area | Status | Verification |
| --- | --- | --- |
| Path validation | Complete | Domain unit tests |
| Timeline calculation | Complete | Domain unit tests |
| Vehicle overlap and location continuity | Complete | Domain, API, and rollback tests |
| Interlocking exclusivity (mandatory) | Complete | Domain, API rollback, and concurrency tests |
| Persistence (PostgreSQL, migration, seed) | Complete | Integration tests; startup on an empty database |
| FastAPI service CRUD and block configuration | Complete | API, transaction, and concurrency tests |
| Angular pages: Editor, Viewer, Block Configuration | Complete | Production build; headless browser checks |
| Frontend unit tests (pure functions) | Complete | Vitest |
| Bonus 1: conflict detection and battery analysis | Complete | Domain and API tests |
| Bonus 2: interactive track map and playback | Complete | Headless browser checks |
| Bonus 3: automatic schedule generation | Not implemented | Out of scope so far |
| Docker delivery | Complete | `docker compose up --build` from an empty volume |
| Review follow-ups F1-F7 | Complete | See [`REVIEW_FINDINGS.md`](REVIEW_FINDINGS.md) |

Last verified result of the full backend suite: `196 passed`, with one
upstream Starlette/AnyIO deprecation warning. Frontend unit tests:
`66 passed`.

## How to Verify

The test tools are in the development image. From the repository root:

```bash
alias dc='docker compose -f docker-compose.yml -f docker-compose.dev.yml'
dc up --build -d
dc exec database createdb -U vehicle_scheduling fastapi_scheduling_test
dc run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint alembic backend upgrade head
dc run --rm --no-deps -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test --entrypoint python backend -m pytest tests -q
dc run --rm --no-deps frontend npm test
```

`createdb` is needed once per database volume. API tests commit transactions
and clear services, so they require a database whose name ends in `_test`.

The delivery form is checked with plain `docker compose up --build`: the
frontend is at `http://localhost:4200` and the backend health endpoint at
`http://localhost:8000/health`.

## Durable Decisions

Each decision is recorded where it is enforced or explained. This list is an
index, not a second copy.

| Decision | Recorded in |
| --- | --- |
| Directed topology; the user supplies the complete path; no route finding | `DOMAIN_RULES.md` sections 1-3 |
| Intervals are `[start, end)`; touching intervals do not conflict | `DOMAIN_RULES.md` section 6 |
| A zero-duration service strictly inside another service of the same vehicle is rejected | `DOMAIN_RULES.md` section 6 |
| Platform timings belong to the service and are keyed by path index | `DOMAIN_RULES.md` section 4 |
| Saved services keep a timeline snapshot; block changes do not recalculate them | `DOMAIN_RULES.md` rules 4.1 and 4.2, `PERSISTENCE_DESIGN.md` |
| Interlocking exclusivity is mandatory and rejected on write (409) | `DOMAIN_RULES.md` section 8, README design decisions |
| General block occupancy and battery issues are Bonus reports, not write rejections | `DOMAIN_RULES.md` sections 7 and 8.1 |
| Battery model: starts at 80, linear drain per block, fractional yard charging, trailing idle | `DOMAIN_RULES.md` section 8.1 |
| Deletion is rejected when it breaks the remaining continuity | `DOMAIN_RULES.md` rule 11.1 |
| Update validates the final schedules of both affected vehicles | `DOMAIN_RULES.md` rule 11.2 |
| Seeded vehicles are `V1` and `V2`; blocks default to 20 seconds | `PERSISTENCE_DESIGN.md`, README |
| All writers share one transaction advisory lock | `API_CONTRACT.md`, `PERSISTENCE_DESIGN.md` |
| Naive datetimes mean Asia/Taipei; responses use `+08:00` | `API_CONTRACT.md` |
| Default images are production form; development uses `docker-compose.dev.yml` | README |

## Verification History

| Date | Scope | Result |
| --- | --- | --- |
| 2026-09-29 | Persistence milestone | `61 passed`; migration, seed, and restart persistence checked |
| 2026-09-30 | Persistence review (stale snapshot after update fixed) | `66 passed`; no schema drift |
| 2026-10-01 | FastAPI CRUD, transactions, concurrency, datetime handling | `128 passed` |
| 2026-10-01 | Angular editor and end-to-end Docker workflow | `131 passed`; browser acceptance of CRUD, 409, and 422 |
| 2026-10-01 | Bonus 1 and Bonus 2 with review hardening | `144 passed`; desktop and 390 px browser checks |
| 2026-10-02 | Mandatory interlocking exclusivity; three routed pages | `178 passed`; startup from a new volume |
| 2026-10-02 | Review follow-ups F1-F7 | `191 passed`; production and development stacks checked in a headless browser, including the default ports from an empty volume |
| 2026-10-02 | Frontend unit tests added | `66 passed` through the development override; three seeded logic mutations were each caught; production image builds without test files |
| 2026-10-02 | Polish: natural ID order and response schemas for `/vehicles`, `/topology`, `/blocks`; Angular built-in control flow; block input labels | Backend `196 passed`; frontend `66 passed`; production build without warnings; three-page headless browser regression with a clean console |

## Known Limitations

- Bonus 3 (automatic schedule generation) is not implemented.
- Frontend unit tests cover pure functions only (`service-timing.ts`,
  `playback.ts`, `schedule-overview.ts`, `page-helpers.ts`). Components,
  templates, and the d3 track map are verified only through the browser, and
  the browser checks are not automated in the repository.
- A vehicle has no position before its first service, because the model has
  no initial vehicle location.
- One global advisory lock serializes every schedule and configuration write.
  This is deliberate for correctness at assignment scale.
- Playback redraws the whole track map SVG on every frame. With 21 elements
  this has no visible cost, so it was left as is.

## Next Concrete Action

No milestone is in progress. `main` is the only branch on the remote and holds
all completed work; start from `main`.

Open items, all for the user:

1. Decide whether to implement Bonus 3 (automatic schedule generation). It is
   the only assignment item not implemented.
2. Before submitting: confirm the reviewer can access the repository, and
   decide whether `AGENTS.md` and `CLAUDE.md` stay in it.

Nothing else is pending. The headless browser scripts used for the checks in
the verification history were not committed, so a new browser check has to be
written again or done by hand.

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
3. Run the commands in "How to Verify".
4. Continue from "Next Concrete Action".

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
