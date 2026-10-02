# Domain Rules

This document defines the business rules for the vehicle scheduling system.

Implementation must follow these rules unless the specification explicitly requires otherwise.

---

# 1. Railway Topology

The railway network is represented as a directed graph.

Each node is a `TrackElement`.

Supported track element types:

```text
YARD
PLATFORM
BLOCK
```

Connections are represented as directed edges:

```text
TrackConnection(from, to)
```

Example:

```text
Y -> B1
B1 -> P1A
P1A -> B3
B3 -> B5
B5 -> P2A
```

Do not assume reverse connectivity.

---

# 2. Path Definition

A service contains an ordered list of track element IDs.

Example:

```text
Y
B1
P1A
B3
B5
P2A
```

The system does not automatically calculate a route.

The user provides the intended path.

Automatic route finding is outside the initial scope.

---

# 3. Path Validation Rules

A path is valid only if all rules below pass.

## Rule 3.1 — Minimum Length

A path must contain at least two elements.

Invalid:

```text
[]
```

Invalid:

```text
["B1"]
```

---

## Rule 3.2 — Every Element Must Exist

Every path element must exist in the predefined topology.

Invalid example:

```text
["P1A", "B999"]
```

if `B999` does not exist.

---

## Rule 3.3 — Every Consecutive Pair Must Be Connected

For every pair:

```text
path[i]
path[i + 1]
```

there must be a matching directed `TrackConnection`.

Example:

```text
P1A -> B3
```

must explicitly exist.

---

## Rule 3.4 — Direction Matters

If:

```text
P1A -> B3
```

exists, this does not imply:

```text
B3 -> P1A
```

is valid.

---

## Rule 3.5 — Block-to-Block Connections Are Allowed

Do not enforce an alternating pattern such as:

```text
Platform -> Block -> Platform
```

The topology may contain:

```text
Block -> Block
```

Example:

```text
B3 -> B5
```

This is valid if the connection exists.

---

## Rule 3.6 — Mixed Element Types Are Allowed

A path may contain any valid sequence of:

```text
YARD
PLATFORM
BLOCK
```

as long as all consecutive connections exist and the path starts and ends as
required by Rule 3.9.

---

## Rule 3.7 — Do Not Require a Yard Start

A service does not have to start from a yard unless required by the provided topology or service continuity rules.

Starting from a platform may be valid.

Starting from a block is not valid; see Rule 3.9.

---

## Rule 3.8 — Repeated Elements

Do not reject repeated track elements purely because they appear multiple times.

A repeated element is allowed if the topology permits the sequence.

Do not introduce loop prevention unless required by the assignment.

---

## Rule 3.9 — A Path Must Start and End at a Platform or Yard

The first and last path elements must each be a `PLATFORM` or `YARD`. A path
starting or ending on a `BLOCK` is rejected. Blocks are only passed through.

Invalid:

```text
["P1A", "B3", "B5"]
["B1", "P1A"]
```

A vehicle waits at a service's first element before the service and remains
at its final element until its next service starts. Block occupancy covers
only the traversal interval, so a vehicle parked on a block would be invisible
to interlocking validation and block conflict analysis while still physically
obstructing the track. This is a project decision confirmed on 2026-10-02, not
a rule stated by the assignment.

The missing-connection check is reported first when both apply, and the start
of the path is reported before the end.

---

## Rule 3.10 — Maximum Length

A path may contain at most 200 elements.

Rule 3.8 allows repeated elements, so a path has no natural end: a loop can be
repeated any number of times. Without a limit, one request can save a service
of tens of thousands of elements, and every later write validation and the
schedule analysis then take seconds to minutes for every user. Measured before
the limit: with one 60,001-element service saved, `GET /schedule-analysis`
took 51 seconds.

200 elements is about sixteen laps of the loop line, and a vehicle's battery
reaches zero after ten. This is a project decision made on 2026-10-02, not a
rule stated by the assignment.

The length is checked before the elements are inspected.

---

# 4. Timeline Rules

A valid path is converted into a time-based timeline.

The assignment defines arrival and departure times at each platform but does not
define how elements before the first platform receive an absolute time. This
project therefore makes the explicit assumption that each service has:

```text
service.start_time
```

This is the time at which the vehicle enters the first path element.

Timeline calculation preserves the timezone of supplied `datetime` values and
expects mutually comparable values. The HTTP boundary interprets naive inputs
as Asia/Taipei, respects the absolute instant of offset-aware inputs, and
normalizes calculation/output datetimes to a fixed `+08:00` offset, including
historical dates. This preserves elapsed durations across historical timezone
transitions. Domain functions do not convert timezones.

Time ownership is defined as follows:

- block traversal time belongs to block configuration
- platform arrival and departure belong to the service
- yard duration is zero

Each platform timing is identified by its zero-based path index, not only by
platform ID. This allows a path to visit the same platform more than once.

For every platform occurrence:

```text
arrival_time == previous_interval.end_time
departure_time >= arrival_time
```

A block must have a configured non-negative traversal time before its timeline
can be calculated. The assignment does not define a default traversal time.

Example:

```text
Service starts at 08:00:00

B1 traversal = 20 sec
P1A arrival = 08:00:20
P1A departure = 08:00:50
B3 traversal = 25 sec
```

Timeline:

```text
B1    08:00:00 -> 08:00:20
P1A   08:00:20 -> 08:00:50
B3    08:00:50 -> 08:01:15
```

Timeline calculation should be deterministic.

## Rule 4.1 — Persisted Timeline Snapshot

When a service is created or updated, its calculated interval for every path
occurrence is persisted as a timeline snapshot.

Changing a block's traversal configuration does not silently recalculate an
already persisted service. The new traversal value applies to services created
afterward and to an existing service when that service is explicitly updated.

This preserves the accepted schedule until the user requests a service change.

## Rule 4.2 — Mutable Block Configuration

Track element identities, types, and connections are fixed seeded topology.
Block `traversal_seconds` is mutable configuration because the assignment
requires a read/write Block Configuration page.

The assignment provides no initial traversal value. As a project product
default confirmed on 2026-10-02, seeded blocks B1-B14 start at 20 seconds.
Seed execution fills existing null block values with 20 seconds and preserves
all non-null custom values, including zero. The API requires a non-negative
integer and rejects null, empty strings, and omitted values; users cannot clear
the configuration. This default is not a value supplied by the assignment.

---

# 5. Resource Occupancy

Scheduling conflicts are modeled using resource occupancy.

A resource occupancy contains:

```text
resource_type
resource_id
start_time
end_time
service_id
```

The mandatory scheduling rules use:

```text
VEHICLE
INTERLOCKING
```

Interlocking group exclusivity is a mandatory Track Map constraint, including
when vehicles use different blocks within the same group. General `BLOCK`
occupancy comes from Bonus 1; since 2026-10-02 it is also rejected on write
(section 7).

Write validation and schedule analysis derive general `BLOCK` occupancy
directly from service timeline snapshots. These occupancies are not stored as
separate database state.

---

# 6. Time Interval Semantics

All occupancy intervals use half-open intervals:

```text
[start, end)
```

For two non-empty intervals, they overlap only when:

```text
startA < endB
and
startB < endA
```

A zero-duration interval `[t, t)` is empty and does not overlap any interval.
It still participates in ordering and vehicle location continuity when it is a
service occupancy.

One vehicle rule goes beyond interval overlap: a zero-duration service at
instant `t` is rejected as a vehicle overlap when `t` lies strictly inside
another service of the same vehicle (`start < t < end`), in either creation
order. The vehicle is mid-service at `t`, so it cannot also be elsewhere.
`t` equal to that service's start or end is allowed and is checked by the
location continuity rule. Two zero-duration services at the same instant are
still allowed, and interlocking and block occupancy keep the plain empty
interval rule.

Example:

```text
A = 08:00 - 08:10
B = 08:10 - 08:20
```

No conflict.

Example:

```text
A = 08:00 - 08:10
B = 08:09 - 08:20
```

Conflict.

---

# 7. Block Conflict

A block may only be occupied by one service at a time.

Decision changed on 2026-10-02 at the user's request: create and update reject
a service whose block interval overlaps another vehicle's interval on the same
block (409 `BlockOccupancyConflictError`). Until then the conflict was only
reported after saving, so the user could not see it while building a service.

The comparison is the one used for interlocking: each block occurrence's
timeline interval, `[start, end)`, touching and empty intervals allowed,
services of the same vehicle ignored, and an update excludes the service it
replaces. Platforms and the yard are not exclusive. If the block belongs to an
interlocking group, the interlocking check runs first and reports the group.

Only the candidate is checked. Services saved before this rule may still share
a block; schedule analysis keeps reporting those as `BLOCK_OCCUPANCY`, and
they do not prevent unrelated writes.

---

# 8. Interlocking Conflict (Mandatory)

Blocks may belong to an interlocking group.

All blocks within the same interlocking group share one exclusive scheduling resource.

Example:

```text
IG1:
B1
B2
```

If one service occupies `B1`, another service may not simultaneously occupy `B2`.

This should be treated as:

```text
resource = interlocking:IG1
```

This is a mandatory constraint from the assignment's Track Map, not Bonus 1.
Create/update must reject overlapping block occupancy by different vehicles
within the same group, including occupancy of the same grouped block.
Use each block occurrence's persisted timeline interval, not the whole service
interval. Intervals use `[start, end)`; touching and empty intervals do not
conflict. Updates exclude the original service being replaced. Blocks in
different groups or outside any group do not cause an interlocking violation.
The API returns 409 and rolls back the failed write.

Because violations are rejected at write time, schedule analysis does not
report a separate interlocking warning.

## 8.1 Battery Analysis (Bonus)

Battery state is derived for each vehicle across its ordered services:

- initial battery is 80 at the first service start
- maximum battery is 100 and minimum battery is 0
- each completed block traversal consumes 1 unit
- battery decreases linearly during the block interval for playback
- known idle time at Yard charges continuously at 1 unit per 12 seconds
- time before the first service and idle time outside Yard do not charge
- after its last service a vehicle stays at that service's end location until
  the schedule ends; this trailing idle time follows the same charging rule
  and still counts as low battery outside Yard
- a vehicle has no position before its first service, because the model has
  no initial vehicle location

Battery below 30 while outside Yard is a low-battery conflict. Battery exactly
30 is not yet a conflict. Leaving Yard below 80 is an insufficient-charge
conflict.

Decision changed on 2026-10-02 at the user's request: create and update reject
a write that adds a battery conflict (409 `BatteryConflictError`). Before, both
were reported only after saving.

- The check covers the vehicles the write touches: the candidate's vehicle
  and, on an update, the vehicle the service is moved away from. Their whole
  schedules are simulated, so a service inserted earlier is rejected when it
  drains a later one.
- A conflict that begins at the same instant as one already saved for that
  vehicle is not new and does not reject. A vehicle saved low on battery
  before this rule can therefore still be sent to the yard.
- A service that ends in the yard is not rejected for a low battery that
  begins before it gets there (decided by the user on 2026-10-02). Otherwise a
  vehicle standing at exactly 30 could never drive home, because every further
  block takes it below 30. The stretch is still a low-battery conflict in
  schedule analysis, and the editor points it out without blocking the save.
  Leaving the yard below 80 afterwards is still rejected.
- Yard duration is zero, so a path that passes through the yard and continues
  cannot charge there. After any block the battery is below 80, so such a path
  is rejected unless the vehicle was charged above 80 beforehand; returning to
  the yard and leaving again takes two services with charging time between.
- Deletion is not checked. Deleting a vehicle's first service resets its
  battery to 80 at the next one, which can lower a battery that had charged
  above 80 in the yard. Schedule analysis still reports the result.

---

# 9. Vehicle Conflict

A vehicle cannot execute two services during overlapping time intervals.
Vehicle occupancy spans the complete service interval from its first timeline
start to its final timeline end. Only services assigned to the same vehicle are
compared.

Example:

```text
V1

Service A
08:00 - 08:20

Service B
08:15 - 08:30
```

Invalid.

When validating an update, the existing service with the same non-null service
ID is excluded from comparison with the candidate.

---

# 10. Vehicle Location Continuity

Services assigned to the same vehicle must be physically continuous.

Example:

```text
Service A
V1
ends at P3A at 08:20

Service B
V1
starts at P1A at 08:30
```

This is invalid unless there is an explicit service or supported repositioning mechanism that moves the vehicle from `P3A` to `P1A`.

For the initial implementation, use the simplest rule:

> The end location of the previous service must equal the start location of the next service.

Do not implement automatic deadheading or repositioning unless required later.

The immediately adjacent predecessor and successor services for the same
vehicle are checked when inserting a service. Updates additionally validate
the final schedules of both affected vehicles (Rule 11.2). A time gap does not
permit the vehicle to change location on its own. Services assigned to other
vehicles do not affect this validation.

---

# 11. Create / Update Validation

When creating or updating a service:

```text
1. validate vehicle exists
2. validate path
3. calculate timeline
4. derive full-service vehicle occupancy
5. validate vehicle time conflicts
6. validate vehicle location continuity
7. validate cross-vehicle interlocking group exclusivity
8. validate cross-vehicle block occupancy
9. validate battery (low battery, insufficient departure charge)
10. persist only if all checks succeed
```

Do not persist an invalid service and then attempt to repair it.

Existing services are treated as previously validated data. Creation checks
whether the candidate can be inserted among them. Update validation also checks
the remaining old schedule after replacing the target (Rule 11.2).

Same-vehicle, interlocking, block occupancy, and battery failures reject the
write before persistence. Failed create leaves no service or child data; failed
update preserves the original input and timeline snapshot. Schedule analysis
still reports block occupancy and battery conflicts for schedules saved before
those two rules rejected writes.

---

## Rule 11.1 — Delete Validation

Decision confirmed on 2026-10-01: reject a service deletion if it would break
location continuity between the remaining services assigned to the same vehicle.

Before deleting, identify the target's immediately adjacent predecessor and
successor for the same vehicle using the existing schedule ordering. If both
exist, the predecessor's end location must equal the successor's start location.
A time gap does not permit repositioning. If this check fails, reject the
deletion, report the continuity failure, and leave the persisted schedule unchanged.

Deleting the first, last, or only service has no newly adjacent pair and passes
this continuity check. Services assigned to other vehicles are unaffected.
Validation and deletion must share a transaction boundary with concurrency
control in the application layer; repository deletion remains a persistence operation.

The pure domain deletion validator is enforced by the application/API within
the shared advisory-lock transaction. Repository deletion alone does not enforce
this rule.

## Rule 11.2 — Update Validation

Decision confirmed in the FastAPI milestone plan on 2026-10-01: replace the
target with the candidate, preserving its service ID and position in the input
sequence, then validate the final schedules of the old and new vehicles.
Reusing vehicle overlap and neighbor-continuity validation for each affected
service rejects moves or reassignments that disconnect the remaining schedule.
An in-place replacement can preserve a bridge and must not be rejected merely
because deleting the original alone would break continuity.

Unrelated vehicles are not revalidated. Existing equal-time neighbor selection
and zero-duration behavior are retained; no new tie-breaking rule is introduced.
API reads list services by ID, giving stable input order for equal-time ties.
Validation and replacement share the application transaction and write lock.

---

# 12. Domain Logic Testing

Core rules should be covered using unit tests independent of FastAPI and the database.

Path validator tests:

1. valid path passes
2. empty path fails
3. one-element path fails
4. unknown element fails
5. missing connection fails
6. reverse direction fails
7. block-to-block connection passes
8. mixed yard/platform/block path passes
9. a path starting or ending on a block fails
10. a path longer than 200 elements fails

Mandatory scheduling tests include:

- timeline calculation
- interval overlap
- vehicle overlap
- vehicle continuity
- deletion continuity: reject a broken remaining predecessor/successor pair;
  allow a continuous pair and first/last/only-service deletion; verify rejected
  deletion preserves stored data and other vehicles do not affect the check

Bonus domain tests cover general block occupancy, half-open boundaries,
battery consumption and limits, fractional Yard charging, low battery, and
insufficient departure charge. Write validation tests cover rejection of each
of the three conflicts, touching boundaries, update self-exclusion, the exact
thresholds (30 and 80), other vehicles being unaffected, and a conflict saved
before the rule not blocking the way to the yard.

Interlocking validation tests cover same-group overlaps, touching boundaries,
update self-exclusion, rollback, and concurrent cross-vehicle writes.
