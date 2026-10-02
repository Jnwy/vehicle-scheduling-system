# Review Findings and Fix Plan

Recorded 2026-10-02 from a full review of `main` at `2d1fe00`.

This document lists the seven problems found in that review and the plan to
fix them. Each phase needs explicit user authorization before work starts and
before any commit.

| Finding | Status |
| --- | --- |
| F1 | Fixed in `c50754e` |
| F2 | Fixed in `110afae` |
| F5 | Fixed in `304093e` |
| F6 | Fixed in `267704a` |
| F3 | Fixed in `ef8b6d3` |
| F4 | Fixed in `bf7d5ae` |
| F7 | Open |

## Verification Baseline

State of `2d1fe00` when the findings were recorded:

- full backend suite in Docker against `fastapi_scheduling_test`: `178 passed`
- Angular production build (`ng build`) in the frontend container: succeeded
- backend start script against a new empty database: migration and seed
  succeeded, service create returned 201
- headless Chrome walkthrough of `/editor`, `/schedule`, and `/blocks` against
  an isolated backend: create, the three 409 rejections, the shared-block
  Bonus warning, playback, block save, and delete behaved as expected
- not run at the time: the whole Compose stack from an empty volume (done in
  Phase C)

## Findings

### F1 — Unchanged update fails after a block time change

Severity: medium. Found in the browser walkthrough. Fixed in `c50754e`.

Steps: save a service, change the traversal time of a block on its path, open
the service in the Schedule Editor, and press Update without touching any
field.

Result: 422 `PlatformTimingError: Platform 'P1A' arrival at path index 2 must
be ...`. The user must edit a dwell value to trigger recalculation before the
save can succeed.

Cause: `startEdit` calls `recalculateTimings(true)`
(`frontend/src/app/schedule-editor.component.ts:370`), which keeps the saved
arrival and departure values. The backend recalculates the timeline from the
current block configuration and rejects the stale arrivals.

### F2 — Error messages expose internal details

Severity: medium (visible in every rejected write). Fixed in `110afae`.

The editor shows text such as `Schedule conflict: VehicleOverlapError: Service
None overlaps service 2 assigned to the same vehicle.` The Python exception
class name and the `None` of an unsaved candidate reach the user.

Cause: domain messages format `service_id` with `!r`
(`backend/app/domain/vehicle_schedule.py`, `backend/app/domain/interlocking.py`),
and `formatErrorDetail` in `frontend/src/app/page-helpers.ts` prints
`code: message`.

### F3 — Docker images run development servers

Severity: medium for delivery quality; the single-command requirement is met.
Fixed in `ef8b6d3`.

- backend runs `uvicorn --reload` (`backend/start.sh`)
- frontend runs `ng serve` (`frontend/Dockerfile`, `docker-compose.yml`)
- the backend image installs dev dependencies and copies tests
- source directories are bind-mounted into the containers
- the API address is hard-coded as `http://localhost:8000`
  (`frontend/src/app/scheduling-api.service.ts`)

### F4 — A zero-duration service can sit inside another service of the same vehicle

Severity: low. Confirmed with the domain functions. Fixed in `bf7d5ae`.

`occupancies_overlap` returns `False` whenever either interval is empty, and
the enclosing service is neither predecessor nor successor of the candidate.
A zero-duration service for V1 at `P3A` was accepted while V1 was mid-service
at `P1A`. It needs every block on the path set to 0 seconds and no platform
dwell, so it is reachable only through unusual configuration.

### F5 — Schedule Viewer is a flat list ordered by service ID

Severity: medium against the requirement "clear and organized". Fixed in
`304093e`.

Services are not grouped by vehicle, not ordered by time, and there is no
time-axis view of the whole schedule.

### F6 — A vehicle disappears from playback after its last service

Severity: low. Fixed in `267704a`.

`segmentIndexAt` in `frontend/src/app/playback.ts` returns no segment once the
instant is past a vehicle's last segment, so the marker vanishes while other
vehicles are still running. The same applies before a vehicle's first service.

### F7 — Tracked documents carry process notes

Severity: low.

`docs/IMPLEMENTATION_PLAN.md` still contains handoff details such as
`stash@{0}`, cherry-pick bookkeeping, and worktree cleanup steps.
`docs/BONUS_IMPLEMENTATION_HANDOFF.md` is a handoff note, not reference
documentation.

## Fix Plan

Order is by return on effort and by risk. Phases A and B do not change domain
rules. Phase C changes a domain rule or a documented scope limit and needs a
decision first.

### Phase A — Editor correctness and messages (F1, F2)

F1:

1. Move the stale check into a pure function in
   `frontend/src/app/service-timing.ts`: compare saved platform timings with
   the timings derived from the current block configuration.
2. In `startEdit`, when they differ, load the recalculated timings and show a
   warning that block times changed since the service was saved.
3. Keep the current behavior when they match, so an untouched save still sends
   the saved snapshot.

F2:

1. Backend: replace the `!r` formatting with wording that reads correctly for
   an unsaved candidate ("the new service"). Keep the `code` field and the
   structured attributes in the response unchanged.
2. Frontend: show the message without the class name.
3. Update `docs/API_CONTRACT.md` if it quotes message text.

Tests: update backend assertions on message text; run the full backend suite.
The frontend has no test runner, so F1's pure function would be verified by a
browser check unless the decision below adds one.

Decision needed: whether to add a minimal frontend unit-test setup. It is not
one of the seven findings, but F1 and F6 both change pure functions that are
cheap to test.

Phase A result (2026-10-02):

- F2: conflict messages say "the new service" for an unsaved candidate; the
  editor shows the message without the exception class name. `code` and the
  structured fields are unchanged. Four domain tests added.
- F1: `savedTimingsAreStale` in `frontend/src/app/service-timing.ts` detects
  a stale snapshot when a service is opened; the editor recalculates and shows
  a warning. An up-to-date snapshot is still sent unchanged.
- Verification: full backend suite in Docker `182 passed`; `ng build`
  succeeded; headless Chrome check against temporary containers built from
  the fix branch confirmed the three 409 messages, one 422 message, the stale
  edit saving on the first attempt with the recalculated timeline, and the
  unchanged-snapshot control case.
- Not done: no frontend unit-test setup was added (decision still open), so
  `savedTimingsAreStale` has browser verification only.

### Phase B — Viewer and playback (F6, F5)

F6:

1. Extend `analyze_schedule` so each vehicle has a trailing idle segment from
   its last service end to the schedule end, with yard charging applied when
   it ends at `Y`.
2. Add domain tests for the trailing segment and its battery values.
3. Confirm playback keeps the marker at the final location.

Position before a vehicle's first service stays undefined: the model has no
initial vehicle location, and inventing one would be a new domain assumption.

F5:

1. Group services by vehicle and order them by start time.
2. Add a per-vehicle time-axis row showing each service as a bar, with
   conflict intervals marked.
3. Keep the existing expandable timeline table.

Decision needed: `AGENTS.md` excludes advanced UI styling unless requested.
Step 1 is small; step 2 needs explicit approval.

Phase B result (2026-10-02):

- F6: `analyze_schedule` adds a trailing idle segment per vehicle from its
  last service end to the schedule end, with yard charging and low-battery
  detection applied. Four domain tests added; `docs/DOMAIN_RULES.md` updated.
  No frontend change was needed.
- F5: `frontend/src/app/schedule-overview.ts` groups services by vehicle in
  start-time order and computes time-axis positions. The viewer shows a
  per-vehicle axis with services, conflict intervals, and the playback
  cursor. The user's instruction to run this phase was taken as approval of
  the time-axis view; it uses plain CSS and adds no dependency.
- Verification: full backend suite in Docker `186 passed`; `ng build`
  succeeded; headless Chrome check confirmed the empty state, grouping, time
  order differing from ID order, conflict bars, a finished vehicle staying on
  the map as Idle, the expandable timeline, and no horizontal overflow at
  390 px width.
- Not done: no frontend unit tests for `schedule-overview.ts` (test setup
  decision still open).

### Phase C — Domain edge case and delivery form (F4, F3)

F4 — decision needed before any code change. Options:

- A (recommended): treat a zero-duration service as a point in time and
  reject it when that point lies strictly inside another service of the same
  vehicle. Touching endpoints stay allowed, which preserves the documented
  half-open rule for non-empty intervals.
- B: reject zero-duration services entirely.

Either option requires an update to `docs/DOMAIN_RULES.md` and new tests in
`backend/tests/test_vehicle_schedule.py` before implementation.

F3 — decision needed. `AGENTS.md` excludes production Nginx tuning and
advanced multi-stage optimization unless requested. Proposed minimal scope:

1. Frontend image: build with `ng build` and serve the static output; make
   the API base URL relative or configurable.
2. Backend: drop `--reload` from the default start; install only runtime
   dependencies in the default image.
3. Move bind mounts and live reload into a Compose override file so the
   development workflow in the README still works.
4. Verify with `docker compose up --build` from an empty volume. This also
   closes the item left unverified in the baseline above.

Phase C result (2026-10-02):

- F4: option A was chosen. Vehicle validation rejects a zero-duration service
  at an instant strictly inside another service of the same vehicle, in
  either creation order. `occupancies_overlap` is unchanged, so interlocking
  and block occupancy keep the empty-interval rule, and two zero-duration
  services at the same instant are still allowed. Five tests added;
  `docs/DOMAIN_RULES.md` section 6 updated.
- F3: the minimal scope was approved. The frontend image serves the Angular
  production build with nginx and forwards `/api/` to the backend; the
  frontend calls `/api` on its own origin. The backend image has runtime
  dependencies only and starts without reload. `docker-compose.dev.yml`
  restores live reload, mounted sources, and the test tools. Frontend image
  size went from 596 MB to 62 MB.
- Verification: full backend suite `191 passed`, run with the commands now in
  the README. The default stack was built and started from an empty volume
  under a separate project name: migration and seed ran, `/api/health`
  answered through nginx, `/schedule` loaded as a deep link, and a headless
  Chrome check created a service, got a 409 for an overlap, and saved a block
  time. The same browser check passed against the development override, with
  the backend reloader and Angular watch mode active.
- Not verified: the published ports 8000 and 4200 themselves, because the
  check used alternate host ports beside a running stack. The port mapping in
  `docker-compose.yml` is the only difference.

### Phase D — Documentation cleanup (F7)

Do this last so it also records the outcome of Phases A-C.

1. Reduce `docs/IMPLEMENTATION_PLAN.md` to current status, decisions, and
   verification results; remove stash, cherry-pick, and worktree bookkeeping.
2. Fold what is still relevant from `docs/BONUS_IMPLEMENTATION_HANDOFF.md`
   into the plan or `docs/DOMAIN_RULES.md`, then remove the file.
3. Update the README test count and any section the earlier phases changed.

## Proposed Commits

One commit per finding, in this order:

1. `fix: recalculate stale platform timings when editing a service` (F1)
2. `fix: make scheduling error messages user-readable` (F2)
3. `feat: keep vehicles on the map after their last service` (F6)
4. `feat: group the schedule viewer by vehicle and time` (F5)
5. `fix: reject zero-duration services inside another service` (F4)
6. `chore: serve production builds in Docker images` (F3)
7. `docs: reduce implementation plan to current status` (F7)

## Open Decisions

- frontend unit-test setup: add or not (Phase A)
- F5 time-axis view: approve or keep to grouping and ordering only (Phase B)
- F4: option A or B (Phase C)
- F3: approve the minimal production-form scope or leave as is (Phase C)
