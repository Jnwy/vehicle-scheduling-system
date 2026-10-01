# Bonus Implementation Handoff

Last updated: 2026-10-01

This checkpoint intentionally stops after the first complete implementation and
focused verification of Bonus 1 and Bonus 2. Final documentation, final Docker
acceptance, and delivery review remain for the next stage.

## Repository State

- Branch: `codex/basic-version-integration`
- No commits have been pushed.
- Baseline checkpoint: `79b77ec docs: record completed baseline integration`
- Bonus 1 checkpoint: `fbd3a18 feat: analyze schedule conflicts and battery state`
- Bonus 2 checkpoint: `c37a41d feat: add interactive track map and schedule playback`
- The temporary browser-acceptance services were deleted. `GET /services`
  returned an empty array at handoff.

## Completed In This Stage

### Bonus 1: Schedule Analysis

- Added a pure domain schedule-analysis service with no FastAPI or SQLAlchemy
  dependency.
- Detects cross-vehicle block occupancy and interlocking conflicts with
  `[start, end)` interval semantics.
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
- Full backend suite after Bonus 1: `142 passed`, with one existing upstream
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

## Decisions And Assumptions

- First service battery starts at 80; time before the first service does not
  charge the vehicle.
- Only known idle time at Yard charges the battery. Current zero-duration Yard
  service intervals add no charge.
- Partial 12-second charging intervals add fractional battery units.
- Battery decreases linearly during block playback and by exactly one unit over
  the complete block interval.
- Same-block overlap emits a block conflict without a redundant interlocking
  warning for the same pair and interval.
- Bonus conflicts remain persisted warnings so the playback can visualize them.
- Automatic route finding and Bonus 3 schedule generation remain out of scope.

## Remaining Work

1. Review the Bonus implementation for domain edge cases and frontend
   maintainability. In particular, inspect low-battery ranges across an
   instantaneous Yard visit and decide whether adjacent warning ranges should
   remain merged or be displayed separately.
2. Add final documentation to `docs/DOMAIN_RULES.md`, `docs/API_CONTRACT.md`,
   `docs/IMPLEMENTATION_PLAN.md`, and `README.md`.
3. Run the final integrated command `docker compose up --build -d`, followed by
   the full 142-test suite, Alembic drift check, and Angular production build.
4. Repeat browser acceptance after the final rebuild. Include UI-created service
   success/warning feedback and explicit low-battery and insufficient-charge
   playback scenarios.
5. Confirm database restart persistence and remove all acceptance services.
6. Commit the final documentation and any review fixes. Do not push without new
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
