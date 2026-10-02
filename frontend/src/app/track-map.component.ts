
import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import * as d3 from 'd3';

import { BATTERY_SEGMENTS, BatteryLevel, batteryGauge } from './battery-gauge';
import { PlaybackVehicleState, TopologyResponse, TrackElementResponse } from './models';
import { nextPathSteps, visitLabel } from './path-steps';

interface Point {
  x: number;
  y: number;
}

export interface BlockTraversalChange {
  blockId: string;
  value: string;
}

const VIEWBOX_WIDTH = 1040;
const VIEWBOX_HEIGHT = 360;
// Headroom above the top row so three stacked vehicle markers are not clipped.
const VIEWBOX_TOP_MARGIN = 72;

// Candidates use blue so they stay distinct from the green selected path.
const CANDIDATE_STROKE = '#2563eb';

const ARROW_LENGTH = 12;
const SELECTED_ARROW_LENGTH = 14;
// Clearance between a node's outline and a line end or arrow tip.
const NODE_GAP = 4;

// Blocks on the configuration map are drawn as input fields.
const CONFIG_BLOCK_HALF_WIDTH = 31;
const CONFIG_BLOCK_RADIUS = 6;

// Battery icon on a playback vehicle marker, positioned inside the marker box.
const BATTERY_X = 13;
const BATTERY_WIDTH = 27;
const BATTERY_HEIGHT = 12;
const BATTERY_SEGMENT_WIDTH = 4;
const BATTERY_SEGMENT_GAP = 1;
const BATTERY_FILL: Record<BatteryLevel, string> = {
  high: '#2e9e5b',
  low: '#e0a100',
  empty: '#d92d20',
};
const BATTERY_UNFILLED = '#e3e0d5';

// A playback vehicle seen from above, pointing right before it is turned.
const CAR_LENGTH = 30;
const CAR_WIDTH = 16;
const CAR_WHEEL_LENGTH = 7;
const CAR_WHEEL_WIDTH = 4;
// Wheel centres: front and rear axle, on both sides, half out from under the body.
const CAR_WHEELS: [number, number][] = [-8, 8].flatMap((x) =>
  [-CAR_WIDTH / 2, CAR_WIDTH / 2].map((y) => [x, y] as [number, number]));
const CAR_STACK_OFFSET = 7;

const VEHICLE_INPUTS = new Set(['vehicles', 'alertVehicleIds', 'batteryAlertVehicleIds', 'focusVehicleId']);

const ALERT_STROKE = '#b42318';
const ALERT_BLINK_SECONDS = 0.9;
// The outline and glow around the vehicle being edited.
const FOCUS_STROKE = '#ffb020';
const FOCUS_PULSE_SECONDS = 1.2;

const ARROW_GROW_MS = 350;
const RING_TRACE_MS = 450;
const CANDIDATE_FADE_OUT_MS = 250;
const CANDIDATE_FADE_IN_MS = 700;

// Crossover blocks sit on the straight line between their two neighbours and
// away from its midpoint, so each pair (B8/B10, B4/B13) draws as an X as in
// docs/topology.png without the two block nodes landing on the crossing.
const POINTS: Record<string, Point> = {
  Y: { x: 980, y: 65 },
  B1: { x: 880, y: 65 },
  B2: { x: 845, y: 165 },
  P1A: { x: 735, y: 65 },
  P1B: { x: 735, y: 255 },
  B3: { x: 620, y: 65 },
  B4: { x: 574, y: 122 },
  B5: { x: 505, y: 65 },
  P2A: { x: 395, y: 65 },
  B6: { x: 285, y: 65 },
  B7: { x: 175, y: 65 },
  B8: { x: 138, y: 198 },
  P3A: { x: 75, y: 65 },
  P3B: { x: 75, y: 255 },
  B10: { x: 222, y: 198 },
  B9: { x: 175, y: 255 },
  B11: { x: 285, y: 255 },
  P2B: { x: 395, y: 255 },
  B12: { x: 505, y: 255 },
  B13: { x: 666, y: 122 },
  B14: { x: 620, y: 255 },
};

type Connection = TopologyResponse['connections'][number];

// A vehicle keeps one colour whichever vehicles are on the map at the moment:
// the number in its ID picks the colour, so V1 is always the first one.
export function vehicleColor(vehicleId: string): string {
  const digits = vehicleId.match(/\d+/);
  const index = digits !== null
    ? Number(digits[0]) - 1
    : [...vehicleId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const palette = d3.schemeTableau10;
  return palette[((index % palette.length) + palette.length) % palette.length];
}

// Distance from a node's centre to its rounded-rectangle outline along the
// unit direction (ux, uy). Sizes match the node shapes drawn in render().
function outlineDistance(elementType: string | undefined, ux: number, uy: number): number {
  const [halfWidth, halfHeight, radius] = elementType === 'CONFIG_BLOCK'
    ? [CONFIG_BLOCK_HALF_WIDTH, 16, CONFIG_BLOCK_RADIUS]
    : elementType === 'BLOCK'
    ? [22, 16, 16]
    :[31, 21, elementType === 'YARD' ? 4 : 7];
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  const distance = Math.min(ax > 0 ? halfWidth / ax : Infinity, ay > 0 ? halfHeight / ay : Infinity);
  const cornerX = halfWidth - radius;
  const cornerY = halfHeight - radius;
  if (ax * distance <= cornerX || ay * distance <= cornerY) {
    return distance;
  }
  // The straight-edge hit lies in a rounded corner: intersect its circle instead.
  const along = ax * cornerX + ay * cornerY;
  return along + Math.sqrt(along * along - (cornerX * cornerX + cornerY * cornerY - radius * radius));
}

function isBlockType(elementType: string | undefined): boolean {
  return elementType === 'BLOCK' || elementType === 'CONFIG_BLOCK';
}

// A connection line from the source outline to just short of the target
// outline, leaving room for the arrowhead whose tip then meets the target.
// A block is itself a piece of track, so at a block the line runs right up
// to the outline with no gap or arrowhead: the track reads as passing
// through the block's label, and heads only point at yards and platforms.
function connectionLine(
  from: Point,
  to: Point,
  fromType: string | undefined,
  toType: string | undefined,
  arrowLength: number,
  startArrowLength: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const startOffset = outlineDistance(fromType, ux, uy) + (isBlockType(fromType) ? 0 : NODE_GAP + startArrowLength);
  const endOffset = outlineDistance(toType, ux, uy) + (isBlockType(toType) ? 0 : NODE_GAP + arrowLength);
  return {
    x1: from.x + ux * startOffset,
    y1: from.y + uy * startOffset,
    x2: to.x - ux * endOffset,
    y2: to.y - uy * endOffset,
  };
}

@Component({
  selector: 'app-track-map',
  template: `
    @if (topologyMissing) {
      <p class="map-empty" role="status">
        Track topology is not available, so the map cannot be drawn. Check that the backend is running, then reload the page.
      </p>
    }
    <div class="map-frame" [hidden]="topologyMissing">
      <svg #svg [attr.role]="mapPurpose === 'config' ? 'group' : 'img'" [attr.aria-label]="ariaLabel"></svg>
    </div>
    <div class="legend" [hidden]="topologyMissing" aria-label="Track map legend">
      <span><i class="yard"></i>Yard</span>
      <span><i class="platform"></i>Platform</span>
      @if (mapPurpose !== 'config') {
        <span><i class="block"></i>Block</span>
      }
      @if (mapPurpose === 'editor') {
        <span><i class="selected"></i>Selected path</span>
        <span><i class="candidate"></i>Available next</span>
        <span><i class="blocked"></i>Blocked next</span>
        <span><i class="vehicle"></i>Vehicle position when the path ends</span>
        <span><i class="focus"></i>Vehicle being edited</span>
      }
      @if (mapPurpose === 'viewer') {
        <span><i class="vehicle"></i>Playback vehicle position</span>
      }
      @if (mapPurpose === 'config') {
        <span><i class="field"></i>Block: editable traversal time in seconds</span>
      }
      @if (mapPurpose !== 'config') {
        <span><i class="conflict"></i>Conflict</span>
      }
    </div>
    `,
  styles: [`
    :host { display: block; min-width: 0; }
    .map-frame { width: 100%; overflow: hidden; border: 1px solid #e3e0d5; border-radius: 8px; background: #faf9f5; }
    svg { display: block; width: 100%; height: auto; aspect-ratio: 1040 / 432; min-height: 260px; }
    .map-empty { margin: 0; padding: 28px 16px; border: 1px dashed #d1cfc5; border-radius: 8px; background: #faf9f5; color: #73726c; font-size: 14px; font-weight: 700; text-align: center; }
    [hidden] { display: none !important; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: #73726c; font-size: 12px; font-weight: 700; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 13px; height: 13px; border: 2px solid #5e5d59; border-radius: 3px; background: #fff; }
    .legend .yard { background: #e3dacc; }
    .legend .platform { background: #f0eee6; }
    .legend .block { border-radius: 50%; background: #ffffff; }
    .legend .field { width: 20px; border-color: #c15f3c; }
    .legend .selected { border-color: #13795b; background: #ccebdd; }
    .legend .candidate { border-color: #2563eb; animation: candidate-breathe 1.8s ease-in-out infinite; }
    .legend .blocked { border-style: dashed; border-color: #b42318; background: #f0eee6; }
    @keyframes candidate-breathe {
      0%, 100% { border-color: #2563eb; }
      50% { border-color: rgba(37, 99, 235, 0.3); }
    }
    @media (prefers-reduced-motion: reduce) {
      .legend .candidate { animation: none; }
    }
    .legend .vehicle { border-radius: 50%; background: #4e79a7; }
    .legend .focus { border-color: #ffb020; box-shadow: 0 0 5px 1px #ffb020; }
    .legend .conflict { border-color: #b42318; background: #fee4e2; }
    @media (max-width: 680px) {
      svg { aspect-ratio: 520 / 1052; min-height: 0; }
    }
  `],
})
export class TrackMapComponent implements AfterViewInit, OnChanges {
  @ViewChild('svg') private svgRef?: ElementRef<SVGSVGElement>;

  @Input({ required: true }) topology: TopologyResponse = { elements: [], connections: [] };
  @Input() selectedPath: string[] = [];
  @Input() interactive = false;
  @Input() vehicles: PlaybackVehicleState[] = [];
  @Input() conflictElementIds: string[] = [];
  // Vehicles in the way of the path being built, and vehicles whose battery
  // it would break a rule for. Their marker or battery icon blinks.
  @Input() alertVehicleIds: string[] = [];
  @Input() batteryAlertVehicleIds: string[] = [];
  // The vehicle the editor form is about; its car and label get a pulsing, glowing outline.
  @Input() focusVehicleId = '';
  // Next elements that cannot be entered right now, with the reason shown on hover.
  @Input() blockedElements: Record<string, string> = {};
  @Input() mapPurpose: 'editor' | 'viewer' | 'config' = 'editor';
  @Output() readonly elementSelected = new EventEmitter<string>();
  @Output() readonly blockTraversalChanged = new EventEmitter<BlockTraversalChange>();

  get ariaLabel(): string {
    if (this.mapPurpose === 'config') {
      return 'Block traversal time configuration map';
    }
    return this.interactive ? 'Service path editing map' : 'Vehicle schedule playback map';
  }

  // The edges added by the latest click, in path order, and the path before it.
  private growingEdges: string[] = [];
  private pathBeforeGrowth: string[] = [];

  private isBlock(elementId: string): boolean {
    return this.topology.elements.some((element) => element.id === elementId && element.elementType === 'BLOCK');
  }

  get topologyMissing(): boolean {
    return this.topology.elements.length === 0;
  }

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const pathChange = changes['selectedPath'];
    if (pathChange && !pathChange.firstChange) {
      // Only one click's worth of appended elements animates (a stop and the
      // blocks leading to it); undo, clear and loading a saved path redraw
      // without motion.
      const previous = (pathChange.previousValue ?? []) as string[];
      const current = this.selectedPath;
      const appended = previous.length >= 1
        && current.length > previous.length
        && previous.every((elementId, index) => elementId === current[index])
        && current.slice(previous.length, -1).every((elementId) => this.isBlock(elementId));
      this.growingEdges = appended
        ? current.slice(previous.length).map((elementId, offset) => `${current[previous.length + offset - 1]}->${elementId}`)
        : [];
      this.pathBeforeGrowth = previous;
    }
    if (!this.svgRef || Object.keys(changes).length === 0) {
      return;
    }
    // The editor replays vehicle movement frame by frame. Its nodes do not
    // depend on the vehicles, so only the markers are redrawn and the path
    // animation started by the same click keeps running.
    const vehiclesOnly = this.mapPurpose === 'editor'
      && Object.keys(changes).every((key) => VEHICLE_INPUTS.has(key));
    if (vehiclesOnly) {
      this.drawVehicles();
    } else {
      this.render();
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.render();
  }

  private render(): void {
    if (!this.svgRef) {
      return;
    }

    // A redraw replaces the traversal inputs, so remember which one had focus.
    const active = document.activeElement;
    const focusedBlockId = active instanceof HTMLElement && this.svgRef.nativeElement.contains(active)
      ? active.dataset['blockId']
      : undefined;

    const svg = d3.select(this.svgRef.nativeElement);
    const compact = window.matchMedia('(max-width: 680px)').matches;
    const points = this.layoutPoints(compact);
    svg.selectAll('*').remove();
    svg.attr('viewBox', compact
      ? `0 ${-VIEWBOX_TOP_MARGIN} 520 ${980 + VIEWBOX_TOP_MARGIN}`
      : `0 ${-VIEWBOX_TOP_MARGIN} ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT + VIEWBOX_TOP_MARGIN}`);
    this.addMarkers(svg);

    const elements = this.topology.elements.filter((element) => points[element.id] !== undefined);
    const selectedEdges = new Set(
      this.selectedPath.slice(0, -1).map((elementId, index) => `${elementId}->${this.selectedPath[index + 1]}`),
    );
    const selectedIds = new Set(this.selectedPath);
    const conflictIds = new Set(this.conflictElementIds);
    const eligibleIds = this.eligibleElementIds();
    // In the editor a node's colour already means selected, candidate or
    // blocked, so only the vehicle markers show where vehicles are.
    const playbackIds = new Set(this.mapPurpose === 'editor' ? [] : this.vehicles.map((vehicle) => vehicle.elementId));

    this.drawStationBands(svg, compact);
    // Lines run between node outlines rather than node centres, so nothing
    // shows through a dimmed, translucent node.
    const elementTypes = new Map<string, string>(elements.map((element) => [
      element.id,
      this.mapPurpose === 'config' && element.elementType === 'BLOCK' ? 'CONFIG_BLOCK' : element.elementType,
    ]));
    const isSelectedEdge = (edge: Connection) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`);
    // A two-way connection reads as one line with a head at each end: both
    // directions cover the same span, each stopping short of the other's
    // head. When only one direction is selected, its grey reverse is hidden
    // so the selected arrow is not layered over it.
    const allEdges = new Set(this.topology.connections.map((edge) => `${edge.fromElementId}->${edge.toElementId}`));
    const reverseKey = (edge: Connection) => `${edge.toElementId}->${edge.fromElementId}`;
    const hiddenByReverse = (edge: Connection) => !isSelectedEdge(edge) && selectedEdges.has(reverseKey(edge));
    const arrowLengthOf = (edge: Connection) => isSelectedEdge(edge) ? SELECTED_ARROW_LENGTH : ARROW_LENGTH;
    const sharesSpanWithReverse = (edge: Connection) =>
      allEdges.has(reverseKey(edge)) && isSelectedEdge(edge) === selectedEdges.has(reverseKey(edge));
    const lineOf = (edge: Connection) => connectionLine(
      points[edge.fromElementId],
      points[edge.toElementId],
      elementTypes.get(edge.fromElementId),
      elementTypes.get(edge.toElementId),
      arrowLengthOf(edge),
      sharesSpanWithReverse(edge) ? arrowLengthOf(edge) : 0,
    );
    svg.append('g')
      .attr('class', 'connections')
      .selectAll('line')
      .data(this.topology.connections.filter((edge) =>
        points[edge.fromElementId] && points[edge.toElementId] && !hiddenByReverse(edge)))
      .join('line')
      .attr('x1', (edge) => lineOf(edge).x1)
      .attr('y1', (edge) => lineOf(edge).y1)
      .attr('x2', (edge) => lineOf(edge).x2)
      .attr('y2', (edge) => lineOf(edge).y2)
      .attr('stroke', (edge) => isSelectedEdge(edge) ? '#13795b' : '#b0aea5')
      .attr('stroke-width', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? 4 : 2.5)
      .attr('stroke-linecap', 'round')
      .attr('marker-end', (edge) => {
        if (isBlockType(elementTypes.get(edge.toElementId))) {
          return null;
        }
        return isSelectedEdge(edge) ? 'url(#arrow-selected)' : 'url(#arrow)';
      })
      // Bidirectional connections overlap, so selected edges must be drawn
      // last or the grey reverse edge covers them.
      .filter((edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`))
      .raise();

    const growingEdges = this.growingEdges;
    this.growingEdges = [];
    const animating = growingEdges.length > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The edges of one click grow one after another, sharing the time a single edge takes.
    const edgeGrowMs = ARROW_GROW_MS / Math.max(growingEdges.length, 1);
    if (animating) {
      const growthOrder = (edge: Connection) => growingEdges.indexOf(`${edge.fromElementId}->${edge.toElementId}`);
      svg.select('.connections')
        .selectAll<SVGLineElement, Connection>('line')
        .filter((edge) => growthOrder(edge) >= 0)
        // Starts almost at zero length (a marker needs some length to take
        // its direction from), with the head just outside the source node.
        .each(function (edge) {
          const line = lineOf(edge);
          d3.select(this)
            .attr('x2', line.x1 + (line.x2 - line.x1) * 0.02)
            .attr('y2', line.y1 + (line.y2 - line.y1) * 0.02)
            .attr('opacity', growthOrder(edge) === 0 ? 1 : 0);
        })
        .transition()
        .delay((edge) => growthOrder(edge) * edgeGrowMs)
        .duration(edgeGrowMs)
        .ease(d3.easeLinear)
        .attr('opacity', 1)
        .attr('x2', (edge) => lineOf(edge).x2)
        .attr('y2', (edge) => lineOf(edge).y2);
    }

    const previousEligibleIds = animating ? this.eligibleElementIds(this.pathBeforeGrowth) : eligibleIds;
    const previousSelectedIds = animating ? new Set(this.pathBeforeGrowth) : selectedIds;
    const dimOpacity = (eligible: Set<string>, selected: Set<string>) => (element: TrackElementResponse) =>
      this.interactive && eligible.size > 0 && !eligible.has(element.id) && !selected.has(element.id) ? 0.38 : 1;

    const node = svg.append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, TrackElementResponse>('g')
      .data(elements)
      .join('g')
      .attr('transform', (element) => `translate(${points[element.id].x},${points[element.id].y})`)
      .attr('role', (element) => this.interactive && eligibleIds.has(element.id) ? 'button' : null)
      .attr('tabindex', (element) => this.interactive && eligibleIds.has(element.id) ? 0 : null)
      .attr('aria-label', (element) => `${element.elementType.toLowerCase()} ${element.id}`)
      .style('cursor', (element) => this.interactive && eligibleIds.has(element.id) ? 'pointer' : 'default')
      .style('opacity', dimOpacity(eligibleIds, selectedIds))
      .on('click', (_, element) => this.select(element.id, eligibleIds))
      .on('keydown', (event: KeyboardEvent, element) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.select(element.id, eligibleIds);
        }
      });

    node.append('rect')
      .attr('class', 'node-shape')
      .attr('x', (element) => element.elementType === 'BLOCK' ? -22 : -31)
      .attr('y', (element) => element.elementType === 'BLOCK' ? -16 : -21)
      .attr('width', (element) => element.elementType === 'BLOCK' ? 44 : 62)
      .attr('height', (element) => element.elementType === 'BLOCK' ? 32 : 42)
      .attr('rx', (element) => element.elementType === 'YARD' ? 4 : element.elementType === 'PLATFORM' ? 7 : 16)
      .attr('fill', (element) => this.nodeFill(element, selectedIds, conflictIds, playbackIds))
      .attr('stroke', (element) => this.nodeStroke(element, selectedIds, conflictIds, playbackIds))
      .attr('stroke-width', (element) => selectedIds.has(element.id) || conflictIds.has(element.id) || playbackIds.has(element.id) ? 4 : 2);

    // A breathing blue outline on each candidate signals that it can be
    // clicked. SMIL is used because Angular's scoped component styles do not
    // reach elements created by d3.
    // On click the previous candidates fade out while the new ones fade in.
    // The fade runs on a wrapper group because SMIL owns the rect's opacity.
    const isNewCandidate = (element: TrackElementResponse) => animating && !previousEligibleIds.has(element.id);
    const ringGroup = node.filter((element) => eligibleIds.has(element.id) || previousEligibleIds.has(element.id))
      .append('g');
    if (animating) {
      node.style('opacity', dimOpacity(previousEligibleIds, previousSelectedIds))
        .transition('dim')
        .duration((element) => isNewCandidate(element) ? CANDIDATE_FADE_IN_MS : CANDIDATE_FADE_OUT_MS)
        .style('opacity', dimOpacity(eligibleIds, selectedIds));
      ringGroup.filter(isNewCandidate)
        .attr('opacity', 0)
        .transition()
        .duration(CANDIDATE_FADE_IN_MS)
        .attr('opacity', 1);
      ringGroup.filter((element) => !eligibleIds.has(element.id))
        .transition()
        .duration(CANDIDATE_FADE_OUT_MS)
        .attr('opacity', 0)
        .remove();
    }
    const ring = ringGroup
      .append('rect')
      .attr('x', (element) => element.elementType === 'BLOCK' ? -22 : -31)
      .attr('y', (element) => element.elementType === 'BLOCK' ? -16 : -21)
      .attr('width', (element) => element.elementType === 'BLOCK' ? 44 : 62)
      .attr('height', (element) => element.elementType === 'BLOCK' ? 32 : 42)
      .attr('rx', (element) => element.elementType === 'YARD' ? 4 : element.elementType === 'PLATFORM' ? 7 : 16)
      .attr('fill', 'none')
      .attr('stroke', CANDIDATE_STROKE)
      .attr('stroke-width', 4)
      .attr('opacity', (element) => isNewCandidate(element) ? 0.3 : 1);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // A new candidate starts breathing from its dim point, so the fade-in
      // and the first brightening rise together instead of flashing.
      const now = this.svgRef.nativeElement.getCurrentTime();
      ring.append('animate')
        .attr('attributeName', 'opacity')
        .attr('values', '0.3;1;0.3')
        .attr('dur', '1.8s')
        .attr('begin', (element) => isNewCandidate(element) ? `${now}s` : '0s')
        .attr('repeatCount', 'indefinite');
    }

    if (animating) {
      // Once the arrow arrives a green ring is traced around the newly
      // selected node while its fill fades in.
      const arrivedId = this.selectedPath[this.selectedPath.length - 1];
      const firstVisit = this.selectedPath.indexOf(arrivedId) === this.selectedPath.length - 1;
      const arrived = node.filter((element) => element.id === arrivedId);
      const shape = arrived.select<SVGRectElement>('.node-shape');
      shape.attr('stroke', '#73726c').attr('stroke-width', 2);
      if (firstVisit) {
        shape
          .attr('fill', (element) => this.nodeFill(element, new Set(), conflictIds, playbackIds))
          .transition()
          .delay(ARROW_GROW_MS)
          .duration(RING_TRACE_MS)
          .attr('fill', (element) => this.nodeFill(element, selectedIds, conflictIds, playbackIds));
      }
      arrived.insert('rect', 'text')
        .attr('x', (element) => element.elementType === 'BLOCK' ? -22 : -31)
        .attr('y', (element) => element.elementType === 'BLOCK' ? -16 : -21)
        .attr('width', (element) => element.elementType === 'BLOCK' ? 44 : 62)
        .attr('height', (element) => element.elementType === 'BLOCK' ? 32 : 42)
        .attr('rx', (element) => element.elementType === 'YARD' ? 4 : element.elementType === 'PLATFORM' ? 7 : 16)
        .attr('fill', 'none')
        .attr('stroke', (element) => this.nodeStroke(element, selectedIds, conflictIds, playbackIds))
        .attr('stroke-width', 4)
        .attr('pathLength', 1)
        .attr('stroke-dasharray', 1)
        .attr('stroke-dashoffset', 1)
        .transition()
        .delay(ARROW_GROW_MS)
        .duration(RING_TRACE_MS)
        .attr('stroke-dashoffset', 0);
    }

    const configurable = (element: TrackElementResponse) => this.mapPurpose === 'config' && element.elementType === 'BLOCK';

    // In configuration mode the block label moves above the node to leave
    // the node itself for the traversal time input.
    node.append('text')
      .attr('y', (element) => configurable(element) ? -25 : 0)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#141413')
      .attr('font-size', (element) => configurable(element) ? 12 : 14)
      .attr('font-weight', 800)
      .text((element) => element.id);

    if (this.mapPurpose === 'config') {
      this.drawTraversalInputs(node.filter(configurable));
      if (focusedBlockId !== undefined) {
        this.svgRef.nativeElement
          .querySelector<HTMLInputElement>(`input[data-block-id="${focusedBlockId}"]`)
          ?.focus();
      }
    }

    if (this.mapPurpose === 'editor') {
      this.blink(node.filter((element) => conflictIds.has(element.id)).select<SVGRectElement>('.node-shape'));
    }

    const visits = d3.group(this.selectedPath.map((id, index) => ({ id, index: index + 1 })), (item) => item.id);
    node.filter((element) => visits.has(element.id))
      .append('text')
      .attr('x', 0)
      .attr('y', -29)
      .attr('text-anchor', 'middle')
      .attr('fill', '#075f46')
      .attr('font-size', 11)
      .attr('font-weight', 800)
      .text((element) => visitLabel(visits.get(element.id)?.map((item) => item.index) ?? []));

    // Blocked candidates are unclickable like any other unreachable element.
    // They are greyed by colour rather than opacity, because nothing is
    // dimmed when every candidate is blocked; the label and tooltip say why.
    const blocked = node.filter((element) => this.interactive && element.id in this.blockedElements);
    blocked.select('.node-shape').attr('fill', '#f0eee6').attr('stroke', '#b42318').attr('stroke-dasharray', '5 4');
    blocked.select('text').attr('fill', '#91908a');
    blocked.append('title').text((element) => `${element.id} is blocked: ${this.blockedElements[element.id]}`);
    // Drawn outside the dimmed node group so the label stays readable.
    svg.append('g')
      .selectAll('text')
      .data(elements.filter((element) => this.interactive && element.id in this.blockedElements))
      .join('text')
      .attr('x', (element) => points[element.id].x)
      .attr('y', (element) => points[element.id].y + 31)
      .attr('text-anchor', 'middle')
      .attr('fill', '#b42318')
      .attr('font-size', 10)
      .attr('font-weight', 800)
      .text('blocked');

    this.drawVehicles();
  }

  private drawTraversalInputs(blocks: d3.Selection<SVGGElement, TrackElementResponse, SVGGElement, unknown>): void {
    // The block is redrawn as a wider, squarer field so it reads as an input.
    blocks.select('.node-shape')
      .attr('x', -CONFIG_BLOCK_HALF_WIDTH)
      .attr('width', CONFIG_BLOCK_HALF_WIDTH * 2)
      .attr('rx', CONFIG_BLOCK_RADIUS)
      .attr('fill', '#ffffff')
      .attr('stroke', '#c15f3c');
    const emitter = this.blockTraversalChanged;
    // Styles are inline or in an SVG-local sheet because Angular's scoped
    // component styles do not reach elements created by d3.
    d3.select(this.svgRef!.nativeElement).append('style')
      // Chrome only shows the stepper on hover unless forced.
      .text('.traversal-input::-webkit-inner-spin-button{opacity:1}');
    const field = blocks.append('foreignObject')
      .attr('x', -CONFIG_BLOCK_HALF_WIDTH + 3)
      .attr('y', -12)
      .attr('width', CONFIG_BLOCK_HALF_WIDTH * 2 - 6)
      .attr('height', 24)
      .append('xhtml:div')
      .attr('style', 'display:flex;align-items:center;gap:2px;height:100%;color:#141413;font:800 13px sans-serif;');
    field.append('xhtml:input')
      .attr('class', 'traversal-input')
      .attr('title', (block) => `${block.id} traversal time in seconds`)
      .attr('type', 'number')
      .attr('min', 0)
      .attr('step', 1)
      .attr('data-block-id', (block) => block.id)
      .attr('aria-label', (block) => `Traversal seconds for ${block.id}`)
      .attr('value', (block) => block.traversalSeconds ?? '')
      .attr('style', 'flex:1;min-width:0;height:100%;box-sizing:border-box;margin:0;padding:0;border:0;'
        + 'background:transparent;color:inherit;font:inherit;text-align:center;')
      .on('change', function (_, block) {
        emitter.emit({ blockId: block.id, value: (this as HTMLInputElement).value });
      })
      .on('keydown', function (event: KeyboardEvent) {
        // Enter confirms the edit; the change event then fires on blur.
        if (event.key === 'Enter') {
          (this as HTMLInputElement).blur();
        }
      })
      .on('focus', function () {
        (this as HTMLInputElement).select();
      });
  }

  private addMarkers(svg: d3.Selection<SVGSVGElement, unknown, null, undefined>): void {
    const defs = svg.append('defs');
    // The glow around the vehicle being edited; the region is enlarged so it is not cut off.
    defs.append('filter')
      .attr('id', 'focus-glow')
      .attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
      .append('feDropShadow')
      .attr('dx', 0).attr('dy', 0).attr('stdDeviation', 3)
      .attr('flood-color', FOCUS_STROKE).attr('flood-opacity', 1);
    // Heads have a fixed size and sit beyond the line end, so the tip meets
    // the target node's outline instead of hiding under the node.
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('refX', 1)
      .attr('markerWidth', ARROW_LENGTH)
      .attr('markerHeight', ARROW_LENGTH)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#91908a');
    defs.append('marker')
      .attr('id', 'arrow-selected')
      .attr('viewBox', '0 -5 10 10')
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('refX', 1)
      .attr('markerWidth', SELECTED_ARROW_LENGTH)
      .attr('markerHeight', SELECTED_ARROW_LENGTH)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#13795b');
  }

  private drawStationBands(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    compact: boolean,
  ): void {
    const stations = compact
      ? [
          { id: 'S1', x: 30, y: 225, width: 460, height: 95 },
          { id: 'S2', x: 30, y: 520, width: 460, height: 95 },
          { id: 'S3', x: 30, y: 800, width: 460, height: 95 },
        ]
      : [
          { id: 'S3', x: 10, y: 20, width: 130, height: 280 },
          { id: 'S2', x: 350, y: 20, width: 90, height: 280 },
          { id: 'S1', x: 690, y: 20, width: 90, height: 280 },
        ];
    const groups = svg.append('g').selectAll('g').data(stations).join('g');
    groups.append('rect')
      .attr('x', (station) => station.x)
      .attr('y', (station) => station.y)
      .attr('width', (station) => station.width)
      .attr('height', (station) => station.height)
      .attr('rx', 8)
      .attr('fill', '#f0eee6')
      .attr('stroke', '#e3e0d5')
      .attr('stroke-dasharray', '5 5');
    groups.append('text')
      .attr('x', (station) => station.x + 10)
      .attr('y', (station) => station.y + 18)
      .attr('fill', '#73726c')
      .attr('font-size', 12)
      .attr('font-weight', 800)
      .text((station) => station.id);
  }

  private drawVehicles(): void {
    const svg = d3.select(this.svgRef!.nativeElement);
    const compact = window.matchMedia('(max-width: 680px)').matches;
    const points = this.layoutPoints(compact);
    svg.selectAll('g.vehicle-cars, g.vehicles').remove();
    const color = vehicleColor;
    const elementCounts = new Map<string, number>();
    // The vehicle being edited is drawn last, so it lies on top of the others
    // sharing its element and its label is the top one of the stack.
    const isFocus = (vehicle: PlaybackVehicleState) => vehicle.vehicleId === this.focusVehicleId;
    const placements = [...this.vehicles.filter((vehicle) => !isFocus(vehicle)), ...this.vehicles.filter(isFocus)]
      .filter((vehicle) => points[vehicle.elementId])
      .map((vehicle) => {
        const stack = elementCounts.get(vehicle.elementId) ?? 0;
        elementCounts.set(vehicle.elementId, stack + 1);
        const start = points[vehicle.fromElementId] ?? points[vehicle.elementId];
        const end = points[vehicle.toElementId] ?? start;
        const headingFrom = points[vehicle.headingFromElementId] ?? start;
        const headingTo = points[vehicle.headingToElementId] ?? headingFrom;
        return {
          vehicle,
          stack,
          x: start.x + (end.x - start.x) * vehicle.progress,
          y: start.y + (end.y - start.y) * vehicle.progress,
          // Follows the track line the vehicle is on; a vehicle with no direction points right.
          degrees: Math.atan2(headingTo.y - headingFrom.y, headingTo.x - headingFrom.x) * 180 / Math.PI,
        };
      });
    type Placement = typeof placements[number];

    // Seen from above and drawn pointing right, then turned to the heading.
    const cars = svg.append('g')
      .attr('class', 'vehicle-cars')
      .selectAll('g')
      .data(placements)
      .join('g')
      // Vehicles on the same spot step aside so a conflict shows every vehicle.
      .attr('transform', ({ x, y, stack, degrees }) =>
        `translate(${x - stack * CAR_STACK_OFFSET},${y - stack * CAR_STACK_OFFSET}) rotate(${degrees})`);
    cars.selectAll('rect.wheel')
      .data(CAR_WHEELS)
      .join('rect')
      .attr('class', 'wheel')
      .attr('x', ([x]) => x - CAR_WHEEL_LENGTH / 2)
      .attr('y', ([, y]) => y - CAR_WHEEL_WIDTH / 2)
      .attr('width', CAR_WHEEL_LENGTH)
      .attr('height', CAR_WHEEL_WIDTH)
      .attr('rx', 1.5)
      .attr('fill', '#141413');
    cars.append('rect')
      .attr('x', -CAR_LENGTH / 2)
      .attr('y', -CAR_WIDTH / 2)
      .attr('width', CAR_LENGTH)
      .attr('height', CAR_WIDTH)
      .attr('rx', 4.5)
      .attr('fill', ({ vehicle }) => color(vehicle.vehicleId))
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5);
    // The windscreen and headlights mark the front.
    cars.append('rect')
      .attr('x', 3)
      .attr('y', -CAR_WIDTH / 2 + 3)
      .attr('width', 6)
      .attr('height', CAR_WIDTH - 6)
      .attr('rx', 1.5)
      .attr('fill', '#eaf2fb');
    cars.append('rect')
      .attr('x', -CAR_LENGTH / 2 + 3.5)
      .attr('y', -CAR_WIDTH / 2 + 4)
      .attr('width', 3)
      .attr('height', CAR_WIDTH - 8)
      .attr('rx', 1)
      .attr('fill', '#eaf2fb')
      .attr('opacity', 0.7);
    // The vehicle being edited: a glowing outline around the car that pulses,
    // and a light blink of the car itself.
    const focused = cars.filter(({ vehicle }) => vehicle.vehicleId === this.focusVehicleId);
    this.pulse(focused, '1;0.75;1');
    this.pulse(focused.append('rect')
      .attr('x', -CAR_LENGTH / 2 - 4)
      .attr('y', -CAR_WIDTH / 2 - 5)
      .attr('width', CAR_LENGTH + 8)
      .attr('height', CAR_WIDTH + 10)
      .attr('rx', 8)
      .attr('fill', 'none')
      .attr('stroke', FOCUS_STROKE)
      .attr('stroke-width', 2.5)
      .attr('filter', 'url(#focus-glow)'), '1;0.3;1');
    cars.selectAll('circle.headlight')
      .data([-CAR_WIDTH / 2 + 3.5, CAR_WIDTH / 2 - 3.5])
      .join('circle')
      .attr('class', 'headlight')
      .attr('cx', CAR_LENGTH / 2 - 2.5)
      .attr('cy', (y) => y)
      .attr('r', 1.3)
      .attr('fill', '#ffd966');

    const markers = svg.append('g')
      .attr('class', 'vehicles')
      .selectAll<SVGGElement, Placement>('g')
      .data(placements)
      .join('g')
      .attr('transform', ({ x, y, stack }) => {
        if (compact) {
          // Tracks run vertically here, so labels sit beside the track, towards the map centre.
          return `translate(${x + (x < 260 ? 78 : -78)},${y - stack * 32})`;
        }
        return `translate(${x},${y - 38 - stack * 32})`;
      });
    markers.append('title')
      .text(({ vehicle }) => `${vehicle.vehicleId} at ${vehicle.elementId}, battery ${Math.round(vehicle.battery)}%`);
    // The same glowing outline around the label of the vehicle being edited.
    this.pulse(markers.filter(({ vehicle }) => vehicle.vehicleId === this.focusVehicleId)
      .append('rect')
      .attr('x', -53)
      .attr('y', -19)
      .attr('width', 106)
      .attr('height', 38)
      .attr('rx', 9)
      .attr('fill', 'none')
      .attr('stroke', FOCUS_STROKE)
      .attr('stroke-width', 2.5)
      .attr('filter', 'url(#focus-glow)'), '1;0.3;1');
    const alertIds = new Set(this.alertVehicleIds);
    const inTheWay = ({ vehicle }: Placement) => alertIds.has(vehicle.vehicleId);
    markers.append('rect')
      .attr('x', -49)
      .attr('y', -15)
      .attr('width', 98)
      .attr('height', 30)
      .attr('rx', 6)
      .attr('fill', (placement) => inTheWay(placement) ? '#fee4e2' : '#ffffff')
      .attr('stroke', (placement) => inTheWay(placement) ? ALERT_STROKE : color(placement.vehicle.vehicleId))
      .attr('stroke-width', (placement) => inTheWay(placement) ? 3 : 2);
    this.blink(cars.filter(inTheWay));
    this.blink(markers.filter(inTheWay));
    markers.append('circle')
      .attr('cx', -34)
      .attr('r', 10)
      .attr('fill', ({ vehicle }) => color(vehicle.vehicleId))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);
    markers.append('text')
      .attr('x', -34)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#fff')
      .attr('font-size', 8)
      .attr('font-weight', 800)
      .text(({ vehicle }) => vehicle.vehicleId);
    markers.append('text')
      .attr('x', -18)
      .attr('text-anchor', 'start')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#141413')
      .attr('font-size', 11)
      .attr('font-weight', 800)
      .text(({ vehicle }) => vehicle.elementId);
    this.drawBatteries(markers);
  }

  private drawBatteries<Placement extends { vehicle: PlaybackVehicleState }>(
    markers: d3.Selection<SVGGElement, Placement, SVGGElement, unknown>,
  ): void {
    const batteries = markers.append('g')
      .attr('class', 'battery')
      .attr('transform', `translate(${BATTERY_X},${-BATTERY_HEIGHT / 2})`);
    const batteryAlertIds = new Set(this.batteryAlertVehicleIds);
    const batteryAlert = ({ vehicle }: Placement) => batteryAlertIds.has(vehicle.vehicleId);
    batteries.append('rect')
      .attr('width', BATTERY_WIDTH)
      .attr('height', BATTERY_HEIGHT)
      .attr('rx', 2)
      .attr('fill', (placement) => batteryAlert(placement) ? '#fee4e2' : '#ffffff')
      .attr('stroke', (placement) => batteryAlert(placement) ? ALERT_STROKE : '#73726c')
      .attr('stroke-width', (placement) => batteryAlert(placement) ? 2 : 1);
    this.blink(batteries.filter(batteryAlert));
    // The terminal nub that makes the outline read as a battery.
    batteries.append('rect')
      .attr('x', BATTERY_WIDTH)
      .attr('y', BATTERY_HEIGHT / 2 - 2.5)
      .attr('width', 2.5)
      .attr('height', 5)
      .attr('rx', 1)
      .attr('fill', '#73726c');
    batteries.selectAll('rect.segment')
      .data(({ vehicle }) => {
        const gauge = batteryGauge(vehicle.battery);
        return d3.range(BATTERY_SEGMENTS).map((index) =>
          index < gauge.filledSegments ? BATTERY_FILL[gauge.level] : BATTERY_UNFILLED);
      })
      .join('rect')
      .attr('class', 'segment')
      .attr('x', (_, index) => 1.5 + index * (BATTERY_SEGMENT_WIDTH + BATTERY_SEGMENT_GAP))
      .attr('y', 2)
      .attr('width', BATTERY_SEGMENT_WIDTH)
      .attr('height', BATTERY_HEIGHT - 4)
      .attr('fill', (fill) => fill);
    this.drawChargingBolts(batteries);
  }

  // A bolt over the battery of a vehicle that is charging in the yard.
  private drawChargingBolts<Placement extends { vehicle: PlaybackVehicleState }>(
    batteries: d3.Selection<SVGGElement, Placement, SVGGElement, unknown>,
  ): void {
    batteries.filter(({ vehicle }) => vehicle.charging)
      .append('path')
      .attr('class', 'charging')
      .attr('d', 'M15.5,-2 L8.5,6.6 L12.6,6.6 L11,14 L18.5,5 L14.2,5 Z')
      .attr('fill', '#ffc400')
      .attr('stroke', '#5c3d00')
      .attr('stroke-width', 0.8)
      .attr('stroke-linejoin', 'round');
  }

  private blink<Element extends d3.BaseType, Datum, Parent extends d3.BaseType>(
    selection: d3.Selection<Element, Datum, Parent, unknown>,
  ): void {
    this.pulse(selection, '1;0.25;1', ALERT_BLINK_SECONDS);
  }

  // SMIL, because Angular's scoped component styles do not reach elements created by d3.
  private pulse<Element extends d3.BaseType, Datum, Parent extends d3.BaseType>(
    selection: d3.Selection<Element, Datum, Parent, unknown>,
    opacities: string,
    seconds = FOCUS_PULSE_SECONDS,
  ): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    selection.append('animate')
      .attr('attributeName', 'opacity')
      .attr('values', opacities)
      .attr('dur', `${seconds}s`)
      .attr('repeatCount', 'indefinite');
  }

  private layoutPoints(compact: boolean): Record<string, Point> {
    if (!compact) {
      return POINTS;
    }
    return Object.fromEntries(
      Object.entries(POINTS).map(([id, point]) => [
        id,
        {
          x: 75 + ((point.y - 65) / 190) * 360,
          y: 55 + ((980 - point.x) / 905) * 790,
        },
      ]),
    );
  }

  // A vehicle only stands at a yard or platform, so the clickable elements
  // are the stops a path can start at or continue to; see path-steps.ts.
  private eligibleElementIds(path = this.selectedPath): Set<string> {
    if (!this.interactive) {
      return new Set<string>();
    }
    const reachable = [...nextPathSteps(path, this.topology).keys()];
    return new Set(reachable.filter((elementId) => !(elementId in this.blockedElements)));
  }

  private select(elementId: string, eligibleIds: Set<string>): void {
    if (this.interactive && eligibleIds.has(elementId)) {
      this.elementSelected.emit(elementId);
    }
  }

  private nodeFill(
    element: TrackElementResponse,
    selected: Set<string>,
    conflicts: Set<string>,
    playback: Set<string>,
  ): string {
    if (conflicts.has(element.id)) {
      return '#fee4e2';
    }
    if (playback.has(element.id)) {
      return '#dff3f8';
    }
    if (selected.has(element.id)) {
      return '#ccebdd';
    }
    if (element.elementType === 'YARD') {
      return '#e3dacc';
    }
    if (element.elementType === 'PLATFORM') {
      return '#f0eee6';
    }
    return '#ffffff';
  }

  private nodeStroke(
    element: TrackElementResponse,
    selected: Set<string>,
    conflicts: Set<string>,
    playback: Set<string>,
  ): string {
    if (conflicts.has(element.id)) {
      return '#b42318';
    }
    if (playback.has(element.id)) {
      return '#0b6f8f';
    }
    if (selected.has(element.id)) {
      return '#13795b';
    }
    return '#73726c';
  }
}
