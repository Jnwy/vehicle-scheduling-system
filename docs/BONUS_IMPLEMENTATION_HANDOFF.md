# Bonus Implementation Handoff

Last updated: 2026-10-01

This checkpoint intentionally stops after implementation, two-axis code review,
and correctness hardening of Bonus 1 and Bonus 2. Final documentation and final
Docker acceptance remain for the next stage.

## Repository State

- Branch: `codex/basic-version-integration`
- No commits have been pushed.
- Baseline checkpoint: `79b77ec docs: record completed baseline integration`
- Bonus 1 checkpoint: `fbd3a18 feat: analyze schedule conflicts and battery state`
- Bonus 2 checkpoint: `c37a41d feat: add interactive track map and schedule playback`
- Review fix: `6eb424d fix: harden bonus battery and map behavior`
- The temporary browser-acceptance services were deleted. `GET /services`
  returned an empty array at handoff.

## Completed In This Stage

### Bonus 1: Schedule Analysis

- Added a pure domain schedule-analysis service with no FastAPI or SQLAlchemy
  dependency.
- Detects cross-vehicle block occupancy with `[start, end)` interval
  semantics. Interlocking group exclusivity is mandatory write validation
  (409), so the analysis no longer reports a separate interlocking warning
  (decision 2026-10-02).
- Derives battery state from persisted timeline snapshots: initial 80, maximum
  100, one unit consumed per block, and one unit charged per 12 seconds at the
  yard.
- Detects low battery and insufficient charge on yard departure.
- Bonus conflicts are warnings and do not block persistence. Existing mandatory
  same-vehicle overlap and location-continuity errors still return HTTP 409.
- Added `GET /schedule-analysis` for playback bounds, vehicle segments, battery
  values, and conflict details. Existing service input/output contracts are
  unchanged.

### Bonus 2: Interactive Map And Playback

- Added D3 7 with TypeScript types and a standalone SVG track-map component.
- The map uses the assignment topology, direction arrows, station regions, and
  a desktop layout with Yard `Y` on the right.
- On screens at or below 680 px, the topology changes to a vertical layout
  without page-level horizontal overflow.
- Users build paths by clicking Yard, Block, and Platform elements. Only legal
  outgoing elements are enabled for the next click.
- Selected path order, repeated visits, undo, reset-to-Y, and change-start are
  supported. The advanced comma-separated input remains synchronized.
- Existing services populate the map when editing, and platform timing rows stay
  aligned with path occurrences.
- Playback supports play, pause, reset, seek, and 1x/10x/60x/300x speeds.
- Playback shows all active vehicles, service IDs, map positions, battery state,
  active conflict highlighting, and the total conflict count.

## Verification Evidence

- Baseline before Bonus work: `131 passed`.
- Bonus domain/API focused suite: `54 passed`.
- Full backend suite after review hardening: `144 passed`, with one existing upstream
  Starlette/AnyIO deprecation warning.
- Fresh frontend Docker image completed `npm ci`: 290 packages, zero reported
  vulnerabilities.
- Angular production build passed after the clean image rebuild:
  `main.js` 307.92 kB raw / 83.16 kB estimated transfer.
- Desktop browser acceptance built `Y -> B1 -> P1A` by clicking the map and
  confirmed the advanced input became `Y, B1, P1A`.
- Playback acceptance used two temporary services on V1 and V2. It displayed a
  B1 occupancy conflict, advanced both vehicles from B1 to P1A, and changed
  battery from 80 to 79.
- A 390 x 844 browser viewport had no page-level horizontal overflow and used
  the vertical map layout.
- Browser console inspection found no errors or warnings.
- Dynamic viewport verification changed the SVG viewBox from desktop
  `0 0 1040 500` to mobile `0 0 520 980` without reloading.

## Review And Hardening — 2026-10-01

- Standards and specification reviews ran independently against baseline
  `79b77ec`.
- Prevented battery values from dropping below zero and added a regression test.
- Corrected the strict low-battery boundary so exactly 30 is not yet a conflict.
- Replaced the old deferred/reject wording in `docs/DOMAIN_RULES.md` with the
  user-confirmed warning policy.
- Added map redraw on viewport changes. Responsive refinement is intentionally
  limited to basic usability and avoiding page-level overflow.
- Retained the current `AppComponent` structure for this checkpoint. It is large
  and owns CRUD plus playback orchestration, but splitting it now is not a
  correctness requirement and would increase the review surface before delivery.

## Decisions And Assumptions

- First service battery starts at 80; time before the first service does not
  charge the vehicle.
- Only known idle time at Yard charges the battery. Current zero-duration Yard
  service intervals add no charge.
- Partial 12-second charging intervals add fractional battery units.
- Battery decreases linearly during block playback and by exactly one unit over
  the complete block interval.
- Bonus conflicts remain persisted warnings so the playback can visualize them.
- Automatic route finding and Bonus 3 schedule generation remain out of scope.

## Remaining Work

1. Add final documentation to `docs/API_CONTRACT.md`,
   `docs/IMPLEMENTATION_PLAN.md`, and `README.md`.
2. Run the final integrated command `docker compose up --build -d`, followed by
   the full 144-test suite, Alembic drift check, and Angular production build.
3. Repeat browser acceptance after the final rebuild. Include UI-created service
   success/warning feedback and explicit low-battery and insufficient-charge
   playback scenarios.
4. Confirm database restart persistence and remove all acceptance services.
5. Commit the final documentation and any review fixes. Do not push without new
   user authorization.

## Next Agent Start Here

Read `AGENTS.md` and its four required documents first, then run:

```bash
git status --short --branch
git log --oneline -5
docker compose ps
docker compose run --rm --no-deps \
  -e DATABASE_URL=postgresql+psycopg://vehicle_scheduling:vehicle_scheduling@database:5432/fastapi_scheduling_test \
  --entrypoint python backend -m pytest tests -q
docker compose exec frontend npm run build
```

Do not change the existing service API contract or make Bonus conflicts reject
writes. Preserve the documented battery assumptions unless the user explicitly
chooses a different model.
