# Vehicle Scheduling System

A vehicle scheduling system for managing services on a predefined railway topology.

The system allows users to assign vehicles to routes at specific times while preventing conflicts involving vehicles, track blocks, and interlocking resources.

> This project is implemented as a technical assignment. The primary focus is correctness, domain modeling, scheduling rules, and clear engineering trade-offs rather than feature volume or UI complexity.

---

## Overview

The railway network is represented as a directed graph consisting of:

- yards
- platforms
- track blocks

Users create a `Service` by specifying:

- a vehicle
- a start time
- an ordered path through the railway network

Example:

```json
{
  "vehicleId": "V1",
  "startTime": "2026-09-27T08:00:00",
  "path": [
    "Y",
    "B1",
    "P1A",
    "B3",
    "B5",
    "P2A"
  ]
}
```

Before a service is accepted, the system validates the path and checks whether it conflicts with existing services.

---

## Core Requirements

The initial implementation focuses on:

- service CRUD
- predefined railway topology
- predefined vehicles
- directed path validation
- timeline calculation
- block occupancy conflicts
- interlocking conflicts
- vehicle scheduling conflicts
- vehicle location continuity
- unit-tested domain logic
- minimal Angular interface

Optional assignment features are intentionally deferred until the core scheduling behavior is complete.

---

## Scheduling Flow

A service passes through the following process:

```text
Service Request
      ↓
Validate Vehicle
      ↓
Validate Path
      ↓
Calculate Timeline
      ↓
Derive Resource Occupancy
      ↓
Detect Conflicts
      ↓
Validate Vehicle Continuity
      ↓
Persist Service
```

An invalid service is rejected before persistence.

---

## Railway Topology

The railway network is modeled as a directed graph.

Each railway object is represented as a `TrackElement`.

Current element types:

```text
YARD
PLATFORM
BLOCK
```

Connections are directional:

```text
P1A -> B3
```

does not imply:

```text
B3 -> P1A
```

The topology may also contain direct block-to-block connections.

---

## Resource-Based Conflict Model

Scheduling conflicts are represented as resource occupancy over time.

Examples of resources:

```text
block:B3

interlocking:IG2

vehicle:V1
```

This allows several domain-specific conflict rules to share the same underlying time-overlap model.

All scheduling intervals use half-open semantics:

```text
[start, end)
```

Two intervals overlap when:

```text
startA < endB
and
startB < endA
```

Therefore:

```text
08:00 - 08:10
08:10 - 08:20
```

does not represent a conflict.

---

# Design Decisions and Trade-offs

## Unified TrackElement Model

### Decision

Yards, platforms, and blocks share a single `TrackElement` abstraction.

### Why

All three participate in the same railway graph.

Using one common element identity makes connections straightforward:

```text
TrackConnection(from_element_id, to_element_id)
```

and allows normal foreign-key relationships.

### Trade-off

Some configuration fields only apply to certain element types.

For example:

- traversal time mainly applies to blocks
- dwell time mainly applies to platforms
- interlocking groups apply to blocks

This may result in nullable subtype-specific fields.

### When I Would Change It

If element types gained significantly different data and behavior, I would keep `TrackElement` as the graph identity and move subtype-specific properties into dedicated tables.

---

## User-Defined Paths Instead of Automatic Routing

### Decision

Users provide the complete ordered service path.

The application validates that path against the topology.

### Why

The assignment focuses on service scheduling and conflict handling.

Automatic route finding introduces a separate graph-search problem that is not necessary for the core scheduling requirements.

### Trade-off

The user must provide a valid route rather than selecting only an origin and destination.

### When I Would Change It

If route selection became part of the product requirements, route finding could be added as a separate component without changing the scheduling model.

---

## Seeded Topology and Vehicles

### Decision

Railway topology and vehicles are initially loaded as predefined data.

### Why

The assignment primarily requires managing services rather than infrastructure configuration.

### Trade-off

Users cannot dynamically create or modify vehicles or railway topology in the initial version.

### When I Would Change It

If infrastructure management became part of the requirements, dedicated management APIs and validation rules could be introduced.

---

## Domain Logic Independent from FastAPI

### Decision

Core scheduling behavior is implemented separately from HTTP and persistence infrastructure.

### Why

Rules such as path validation and time overlap are deterministic domain behavior.

Keeping them independent makes them easier to understand and test.

### Trade-off

This introduces a small amount of separation between API orchestration and domain logic.

### Benefit

The core behavior can be tested without:

- running FastAPI
- starting a database
- constructing HTTP requests

---

## Derived Resource Occupancy

### Decision

Resource occupancy is initially treated as data derived from a service and its timeline rather than as the primary persisted representation.

### Why

Occupancy can always be reconstructed from the service path and timing configuration.

Avoiding duplicated persisted state reduces synchronization concerns.

### Trade-off

Conflict queries may require recalculation.

### When I Would Change It

At substantially larger scale, occupancy could be materialized or indexed as a performance optimization.

---

## Vehicle Continuity

### Decision

For the initial implementation, consecutive services assigned to the same vehicle must connect directly:

```text
previous_service.end_location
==
next_service.start_location
```

### Why

This provides deterministic physical continuity without introducing automatic vehicle repositioning.

### Trade-off

The model does not automatically create deadheading or repositioning journeys.

### When I Would Change It

A production system could model repositioning as explicit services or introduce a dedicated planning mechanism.

---

## Architecture

Initial architecture:

```text
Angular
   ↓
FastAPI
   ↓
Application Layer
   ↓
Domain Logic
   ↓
Persistence
```

Core scheduling rules remain below the HTTP layer.

Further implementation details will be documented as development progresses.

---

## Testing

Core business rules are tested using `pytest`.

The initial test suite focuses on path validation, including:

- valid path
- empty path
- single-element path
- unknown track element
- missing connection
- reverse-direction connection
- valid block-to-block connection
- mixed yard/platform/block path

Later tests cover:

- timeline calculation
- interval overlap
- block conflicts
- interlocking conflicts
- vehicle conflicts
- vehicle continuity

---

## Running the Project

To be completed after the backend and frontend project structure is finalized.

---

## Running Tests

To be completed after the Python project structure is finalized.

---

## Known Limitations

The initial implementation intentionally does not include:

- automatic route finding
- automatic schedule generation
- vehicle management
- topology management
- battery simulation
- schedule playback
- production-scale scheduling optimization

These are kept outside the initial scope to prioritize correctness of the core scheduling model.