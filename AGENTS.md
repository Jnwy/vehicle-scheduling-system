# AGENTS.md

This file defines how coding agents should work on this repository.

Before making changes, read:

1. `docs/DOMAIN_RULES.md`
2. `docs/TOPOLOGY.md`
3. `docs/IMPLEMENTATION_PLAN.md`
4. `README.md`

The original assignment is the highest-priority requirements source. For
repository decisions, follow the source priority documented in
`docs/IMPLEMENTATION_PLAN.md`.

Do not silently change domain rules or topology assumptions. If something is ambiguous, report the ambiguity before changing the model.

---

## Current Development Strategy

Implement the project incrementally.

Do not attempt to complete the entire assignment in one pass.

Current development order:

```text
Domain rules
→ Unit tests
→ Path validation
→ Timeline calculation
→ Mandatory vehicle schedule validation
→ Persistence
→ FastAPI
→ Minimal Angular UI
→ Docker integration
→ Final documentation
→ Optional bonus conflict detection
```

Bonus features are not part of the initial implementation unless explicitly requested.

---

## Development Rules

### 1. Domain logic first

Scheduling rules must not depend directly on:

- FastAPI
- SQLAlchemy
- HTTP requests
- database sessions

Prefer pure functions or small domain services where practical.

Core rules must be testable with `pytest`.

---

### 2. Do not over-engineer

Prefer the simplest implementation that correctly satisfies the current requirement.

Do not introduce abstractions such as:

- repository frameworks
- event buses
- CQRS
- dependency-injection frameworks
- generic base classes
- complex inheritance hierarchies

unless there is an immediate need.

---

### 3. Do not expand scope automatically

Do not implement features that were not explicitly requested.

Especially avoid adding:

- automatic route finding
- shortest-path calculation
- vehicle CRUD
- topology structure CRUD; block traversal configuration remains mandatory
- authentication
- authorization
- battery simulation
- playback
- automatic scheduling
- advanced UI styling

unless explicitly requested.

One exception was explicitly requested and must be kept: the Schedule Editor
lets the user click the next platform or yard and adds the blocks on the way
when that route is unique (`frontend/src/app/path-steps.ts`). It is frontend
only; the API still receives and validates the complete path. Do not extend it
into backend route finding or shortest-path search.

---

### 4. Preserve documented domain decisions

Important current decisions include:

- railway topology is a directed graph
- `YARD`, `PLATFORM`, and `BLOCK` share the `TrackElement` abstraction
- the user provides the service path
- a service path starts and ends at a `PLATFORM` or `YARD`; blocks are only
  passed through
- connections are directional
- block-to-block connections are valid
- scheduling intervals use `[start, end)` semantics
- core scheduling logic remains independent from infrastructure
- topology and vehicles are initially seeded data
- block traversal time is mutable configuration
- persisted services retain a calculated timeline snapshot

Do not silently change these decisions.

If a better alternative is identified, explain the trade-off before modifying the implementation.

---

### 5. Tests are part of the feature

Whenever implementing a domain rule:

1. identify its expected behavior
2. add or update unit tests
3. implement the rule
4. run the affected tests
5. report the results

Do not consider a core domain rule complete without tests.

---

### 6. Keep routine work low-cost

Use the least expensive workflow that can verify the requested change with
reasonable confidence.

- Keep exploration and edits narrowly scoped to the current task.
- Prefer targeted tests, builds, and static checks while iterating.
- Do not repeatedly run the full Docker stack, complete test suite, browser
  acceptance flow, or multi-agent review for small changes.
- Reserve full verification for milestone completion, cross-cutting or risky
  changes, explicit user requests, and final delivery.
- Reuse recent valid verification results when the new change cannot affect
  them, and state what was not rerun.
- For large tasks, stop at a coherent checkpoint and leave a concise tracked
  handoff before continuing to another phase.

Low-cost execution must not weaken required domain tests or conceal unverified
behavior. When confidence and cost conflict, explain the trade-off and choose
the smallest additional check that resolves the material risk.

---

## Current Phase

Only work on the phase or task explicitly requested.

Use `docs/IMPLEMENTATION_PLAN.md` as the tracked source for current milestone
status, definition of done, unresolved decisions, and the next concrete action.
Update it when a milestone changes or completes, not for every small edit.

Do not continue to the next phase automatically.

If the current task is path validation, do not also implement timeline calculation, persistence, API endpoints, or UI unless explicitly asked.

---

## Docker Requirement

The final project must be runnable with Docker as required by the assignment.

Docker configuration should remain simple.

Target final command:

```bash
docker compose up --build
```

Do not spend time on production deployment concerns such as:

- Kubernetes
- production Nginx tuning
- CI/CD pipelines
- advanced multi-stage optimization

unless explicitly requested.

---

## When Completing a Task

Provide a short summary containing:

- files added
- files changed
- behavior implemented
- tests added or changed
- test results
- assumptions made
- unresolved questions

Do not hide implementation assumptions.

---

## Code Style

Prefer:

- small focused modules
- descriptive names
- explicit domain terminology
- type hints
- simple control flow
- deterministic domain logic

Avoid comments that merely repeat what the code does.

Comments should explain important reasoning or non-obvious domain behavior.

---

## Git Workflow

### Commit Authorization

Do not run `git commit` unless the user explicitly authorizes the commit in the
current request. Previous requests to commit do not grant ongoing permission.

When changes are ready but the user has not authorized a commit, report the
planned commit scope and message, then wait for the user to approve it.

Proactively suggest a commit when the current changes form a coherent,
verified milestone. Include the proposed commit message and file scope in the
suggestion, but do not create the commit without explicit authorization.

Before a cross-machine or cross-agent handoff, update the tracked implementation
plan, commit after explicit user authorization, and push the commits. Do not
rely on `.local-docs/`, local database volumes, uncommitted changes, or chat
history for required project context.

Use small, meaningful commits that reflect implementation milestones.

Preferred commit types:

- `feat:` new behavior
- `fix:` bug fix
- `test:` tests
- `docs:` documentation
- `chore:` tooling or project setup
- `refactor:` structural change without behavior change

Do not create one large final commit containing unrelated work.

Before committing:

1. run relevant tests
2. review changed files
3. ensure the commit contains one coherent change

Do not commit broken intermediate states unless explicitly needed for investigation.

---

## Priority

When forced to choose between:

```text
more features
```

and:

```text
correct, understandable, tested core behavior
```

choose the second.
