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

as long as all consecutive connections exist.

---

## Rule 3.7 — Do Not Require a Yard Start

A service does not have to start from a yard unless required by the provided topology or service continuity rules.

Starting from a platform may be valid.

---

## Rule 3.8 — Repeated Elements

Do not reject repeated track elements purely because they appear multiple times.

A repeated element is allowed if the topology permits the sequence.

Do not introduce loop prevention unless required by the assignment.

---

# 4. Timeline Rules

A valid path is converted into a time-based timeline.

Timeline calculation starts from:

```text
service.start_time
```

Each element contributes time according to its configuration.

Typical rules:

- block → traversal time
- platform → dwell time
- yard → usually zero unless configured otherwise

Example:

```text
Service starts at 08:00:00

B1 traversal = 30 sec
P1A dwell = 30 sec
B3 traversal = 25 sec
```

Timeline:

```text
B1    08:00:00 -> 08:00:30
P1A   08:00:30 -> 08:01:00
B3    08:01:00 -> 08:01:25
```

Timeline calculation should be deterministic.

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

Resource types include:

```text
BLOCK
INTERLOCKING
VEHICLE
```

---

# 6. Time Interval Semantics

All occupancy intervals use half-open intervals:

```text
[start, end)
```

Two intervals overlap only when:

```text
startA < endB
and
startB < endA
```

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

If two services occupy the same block during overlapping intervals, the new or updated service must be rejected.

---

# 8. Interlocking Conflict

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

---

# 9. Vehicle Conflict

A vehicle cannot execute two services during overlapping time intervals.

Example:

```text
V1

Service A
08:00 - 08:20

Service B
08:15 - 08:30
```

Invalid.

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

---

# 11. Create / Update Validation

When creating or updating a service:

```text
1. validate vehicle exists
2. validate path
3. calculate timeline
4. derive resource occupancy
5. validate block conflicts
6. validate interlocking conflicts
7. validate vehicle time conflicts
8. validate vehicle location continuity
9. persist only if all checks succeed
```

Do not persist an invalid service and then attempt to repair it.

---

# 12. Domain Logic Testing

Core rules should be covered using unit tests independent of FastAPI and the database.

Initial path validator tests:

1. valid path passes
2. empty path fails
3. one-element path fails
4. unknown element fails
5. missing connection fails
6. reverse direction fails
7. block-to-block connection passes
8. mixed yard/platform/block path passes

Later add tests for:

- timeline calculation
- interval overlap
- block conflict
- interlocking conflict
- vehicle overlap
- vehicle continuity
