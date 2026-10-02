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

Last verified result of the full backend suite: `206 passed`, with one
upstream Starlette/AnyIO deprecation warning. Frontend unit tests:
`134 passed`.

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
| Directed topology; the API receives the complete path; no route finding | `DOMAIN_RULES.md` sections 1-3 |
| A path starts and ends at a platform or yard; blocks are only passed through (422 `PathEndpointOnBlockError`) | `DOMAIN_RULES.md` rule 3.9, README design decisions |
| A path has at most 200 elements (422 `PathTooLongError`); the editor previews the same limit | `DOMAIN_RULES.md` rule 3.10 |
| The Schedule Editor offers only the next reachable stops and adds the blocks on the way when that route is unique; otherwise single elements; no reversing in a block back to the same stop. User-approved exception to "no route finding", frontend only | README design decisions, `frontend/src/app/path-steps.ts` |
| The Schedule Editor previews write validation in the browser (vehicle overlap, continuity, interlocking, blocked next stops, deletion) and disables the save or delete button while a problem is shown; the backend still validates every write | README "Editor Previews of Write Validation", `frontend/src/app/service-conflicts.ts` |
| A new service defaults to where and when the vehicle's latest service ended, moved later if every way out is held; busy start times are disabled, and a time picked inside a service moves to the nearest free time | README "Editor Previews of Write Validation", `frontend/src/app/service-timing.ts` |
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
| 2026-10-02 | Paths must start and end at a platform or yard; editor builds paths by clicking stops | Backend `202 passed`. Frontend `116 passed`, production build, and a browser check of stop clicks, block fill-in, and undo, all before the last change (reversing to the same stop no longer offered); after it only `path-steps.spec.ts` and `service-conflicts.spec.ts` were rerun (`33 passed`), giving 117 by count |
| 2026-10-02 | Full check at `8a4a67e` (service form merged into the editor map panel) against the assignment | Backend `202 passed`; frontend `117 passed`; production build; the running production stack serves the same bundle; browser check of the three pages with a clean console, including a stop click, block fill-in, and undo in the editor. Nothing was saved; startup from an empty volume was not rerun |
| 2026-10-02 | Review of `feat/map-display-polish` at `ff3f3db`: editor previews, vehicle availability, calendar and time dropdowns, time axes in the playback panel, new colour palette | Backend `202 passed`; frontend `129 passed`; production build without warnings. Headless browser run on a development stack with an empty database: stop clicks, undo, change start, busy options disabled, a busy start moved to a free time, blocked next stops, save and delete disabled with reasons, block edits on the map with invalid values rejected, playback, 390 px width; clean console. Randomized comparison of the editor previews with the API over 700 create, update, and delete requests: no disagreement. Not rerun: the production stack and startup on the default ports |
| 2026-10-02 | Fix: page message on narrow screens (the close button took the full row) | Measured in a headless browser at 390 px and 1440 px; frontend tests and build were not rerun for this one CSS rule |
| 2026-10-02 | Path length limit of 200 elements; map visit labels shortened for elements visited more than three times | Found by sending long looping paths to the API: all were accepted, and with a 60,001-element service saved `GET /schedule-analysis` took 51 seconds. After the change: backend `206 passed`; frontend `134 passed`; production build. API returns 422 for 201 elements and accepts 199. Headless browser: labels read `1,13,25 +4` after seven visits; at 205 elements the editor lists the reason and disables saving, and saving is enabled again at 199 |

## Known Limitations

- Bonus 3 (automatic schedule generation) is not implemented.
- Frontend unit tests cover pure functions only (`service-timing.ts`,
  `service-conflicts.ts`, `path-steps.ts`, `playback.ts`,
  `schedule-overview.ts`, `page-helpers.ts`). Components,
  templates, and the d3 track map are verified only through the browser, and
  the browser checks are not automated in the repository.
- The editor previews duplicate backend rules in the frontend. They are
  unit-tested and were compared with the API once by a randomized run, but
  that comparison is not in the repository. They use the services loaded when
  the page opened, and there is no manual refresh, so a write from another
  browser tab is not seen until the page is reopened.
- A vehicle has no position before its first service, because the model has
  no initial vehicle location. The editor shows `Y` as the starting point for
  a vehicle with no services, although the API accepts any stop.
- One global advisory lock serializes every schedule and configuration write.
  This is deliberate for correctness at assignment scale.
- Playback redraws the whole track map SVG on every frame. With 21 elements
  this has no visible cost, so it was left as is.

## Next Concrete Action

No milestone is in progress. `main` holds all completed work, including the
branch `feat/map-display-polish` (the path endpoint and length rules,
stop-based path building, editor previews, vehicle availability, start time
controls, viewer time axes, and the new palette), which was merged by
fast-forward.

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
