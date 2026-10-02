export type ElementType = 'YARD' | 'PLATFORM' | 'BLOCK';
export type ConflictType = 'BLOCK_OCCUPANCY' | 'LOW_BATTERY' | 'INSUFFICIENT_CHARGE';
export type SegmentType = 'SERVICE' | 'IDLE';

export interface VehicleResponse {
  id: string;
}

export interface TrackElementResponse {
  id: string;
  elementType: ElementType;
  traversalSeconds: number | null;
  interlockingGroup: string | null;
}

export interface TrackConnectionResponse {
  fromElementId: string;
  toElementId: string;
}

export interface TopologyResponse {
  elements: TrackElementResponse[];
  connections: TrackConnectionResponse[];
}

export interface BlockResponse {
  id: string;
  traversalSeconds: number | null;
  interlockingGroup: string | null;
}

export interface BlockRequest {
  traversalSeconds: number;
}

export interface PlatformTiming {
  pathIndex: number;
  arrivalTime: string;
  departureTime: string;
}

export interface TimelineInterval {
  pathIndex: number;
  elementId: string;
  startTime: string;
  endTime: string;
}

export interface ServiceResponse {
  id: number;
  vehicleId: string;
  startTime: string;
  path: string[];
  platformTimings: PlatformTiming[];
  timeline: TimelineInterval[];
}

export interface ServiceRequest {
  vehicleId: string;
  startTime: string;
  path: string[];
  platformTimings: PlatformTiming[];
}

export interface SimulationSegment {
  segmentType: SegmentType;
  serviceId: number | null;
  pathIndex: number | null;
  elementId: string;
  startTime: string;
  endTime: string;
  batteryStart: number;
  batteryEnd: number;
}

export interface VehicleSimulation {
  vehicleId: string;
  segments: SimulationSegment[];
}

export interface ScheduleConflict {
  conflictType: ConflictType;
  resourceId: string | null;
  startTime: string;
  endTime: string;
  vehicleIds: string[];
  serviceIds: number[];
  elementIds: string[];
  message: string;
}

export interface ScheduleAnalysis {
  startTime: string | null;
  endTime: string | null;
  vehicles: VehicleSimulation[];
  conflicts: ScheduleConflict[];
}

export interface PlaybackVehicleState {
  vehicleId: string;
  serviceId: number | null;
  elementId: string;
  // The marker is drawn `progress` of the way from one element to the other;
  // `elementId` remains the element the vehicle occupies.
  fromElementId: string;
  toElementId: string;
  progress: number;
  // The vehicle points from one element towards the other. While it stands
  // still it keeps the direction it arrived in; both are `elementId` when the
  // schedule gives it no direction at all.
  headingFromElementId: string;
  headingToElementId: string;
  battery: number;
  // True while the vehicle waits in the yard and its battery is still rising.
  charging: boolean;
}
