
import { AfterViewInit, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import * as d3 from 'd3';

import { PlaybackVehicleState, TopologyResponse, TrackElementResponse } from './models';

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
// Headroom above the top row so a second stacked vehicle marker is not clipped.
const VIEWBOX_TOP_MARGIN = 40;

// Candidates use blue so they stay distinct from the green selected path.
const CANDIDATE_STROKE = '#2563eb';

const ARROW_LENGTH = 12;
const SELECTED_ARROW_LENGTH = 14;
// Clearance between a node's outline and a line end or arrow tip.
const NODE_GAP = 4;

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

// Distance from a node's centre to its rounded-rectangle outline along the
// unit direction (ux, uy). Sizes match the node shapes drawn in render().
function outlineDistance(elementType: string | undefined, ux: number, uy: number): number {
  const [halfWidth, halfHeight, radius] = elementType === 'BLOCK'
    ? [22, 16, 16]
    : [31, 21, elementType === 'YARD' ? 4 : 7];
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

// A connection line from the source outline to just short of the target
// outline, leaving room for the arrowhead whose tip then meets the target.
function connectionLine(
  from: Point,
  to: Point,
  fromType: string | undefined,
  toType: string | undefined,
  arrowLength: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  const startOffset = outlineDistance(fromType, ux, uy) + NODE_GAP;
  const endOffset = outlineDistance(toType, ux, uy) + NODE_GAP + arrowLength;
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
      <span><i class="block"></i>Block</span>
      @if (mapPurpose === 'editor') {
        <span><i class="selected"></i>Selected path</span>
        <span><i class="candidate"></i>Available next</span>
      }
      @if (mapPurpose === 'viewer') {
        <span><i class="vehicle"></i>Playback vehicle position</span>
      }
      @if (mapPurpose !== 'config') {
        <span><i class="conflict"></i>Conflict</span>
      }
    </div>
    `,
  styles: [`
    :host { display: block; min-width: 0; }
    .map-frame { width: 100%; overflow: hidden; border: 1px solid #d5dee7; border-radius: 8px; background: #f8fafc; }
    svg { display: block; width: 100%; height: auto; aspect-ratio: 1040 / 400; min-height: 260px; }
    .map-empty { margin: 0; padding: 28px 16px; border: 1px dashed #c3ced9; border-radius: 8px; background: #f8fafc; color: #536475; font-size: 14px; font-weight: 700; text-align: center; }
    [hidden] { display: none !important; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: #536475; font-size: 12px; font-weight: 700; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 13px; height: 13px; border: 2px solid #506172; border-radius: 3px; background: #fff; }
    .legend .yard { background: #d8edf2; }
    .legend .platform { background: #e6edf5; }
    .legend .block { border-radius: 50%; background: #f0f4e9; }
    .legend .selected { border-color: #13795b; background: #ccebdd; }
    .legend .candidate { border-color: #2563eb; animation: candidate-breathe 1.8s ease-in-out infinite; }
    @keyframes candidate-breathe {
      0%, 100% { border-color: #2563eb; }
      50% { border-color: rgba(37, 99, 235, 0.3); }
    }
    @media (prefers-reduced-motion: reduce) {
      .legend .candidate { animation: none; }
    }
    .legend .vehicle { border-radius: 50%; background: #4e79a7; }
    .legend .conflict { border-color: #b42318; background: #fee4e2; }
    @media (max-width: 680px) {
      svg { aspect-ratio: 520 / 1020; min-height: 0; }
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
  @Input() mapPurpose: 'editor' | 'viewer' | 'config' = 'editor';
  @Output() readonly elementSelected = new EventEmitter<string>();
  @Output() readonly blockTraversalChanged = new EventEmitter<BlockTraversalChange>();

  get ariaLabel(): string {
    if (this.mapPurpose === 'config') {
      return 'Block traversal time configuration map';
    }
    return this.interactive ? 'Service path editing map' : 'Vehicle schedule playback map';
  }

  private growingEdge: string | null = null;

  get topologyMissing(): boolean {
    return this.topology.elements.length === 0;
  }

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const pathChange = changes['selectedPath'];
    if (pathChange && !pathChange.firstChange) {
      // Only a single appended element animates; undo, clear and loading a
      // saved path redraw without motion.
      const previous = (pathChange.previousValue ?? []) as string[];
      const current = this.selectedPath;
      const appendedOne = current.length === previous.length + 1
        && current.length >= 2
        && previous.every((elementId, index) => elementId === current[index]);
      this.growingEdge = appendedOne ? `${current.at(-2)}->${current.at(-1)}` : null;
    }
    if (this.svgRef && Object.keys(changes).length > 0) {
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
    const playbackIds = new Set(this.vehicles.map((vehicle) => vehicle.elementId));

    this.drawStationBands(svg, compact);
    // Lines run between node outlines rather than node centres, so nothing
    // shows through a dimmed, translucent node.
    const elementTypes = new Map(elements.map((element) => [element.id, element.elementType]));
    const isSelectedEdge = (edge: Connection) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`);
    const lineOf = (edge: Connection) => connectionLine(
      points[edge.fromElementId],
      points[edge.toElementId],
      elementTypes.get(edge.fromElementId),
      elementTypes.get(edge.toElementId),
      isSelectedEdge(edge) ? SELECTED_ARROW_LENGTH : ARROW_LENGTH,
    );
    svg.append('g')
      .attr('class', 'connections')
      .selectAll('line')
      .data(this.topology.connections.filter((edge) => points[edge.fromElementId] && points[edge.toElementId]))
      .join('line')
      .attr('x1', (edge) => lineOf(edge).x1)
      .attr('y1', (edge) => lineOf(edge).y1)
      .attr('x2', (edge) => lineOf(edge).x2)
      .attr('y2', (edge) => lineOf(edge).y2)
      .attr('stroke', (edge) => isSelectedEdge(edge) ? '#13795b' : '#9aabba')
      .attr('stroke-width', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? 4 : 2.5)
      .attr('stroke-linecap', 'round')
      .attr('marker-end', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? 'url(#arrow-selected)' : 'url(#arrow)')
      // Bidirectional connections overlap, so selected edges must be drawn
      // last or the grey reverse edge covers them.
      .filter((edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`))
      .raise();

    const growingEdge = this.growingEdge;
    this.growingEdge = null;
    if (growingEdge && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      svg.select('.connections')
        .selectAll<SVGLineElement, Connection>('line')
        .filter((edge) => `${edge.fromElementId}->${edge.toElementId}` === growingEdge)
        // Starts almost at zero length (a marker needs some length to take
        // its direction from), with the head just outside the source node.
        .each(function (edge) {
          const line = lineOf(edge);
          d3.select(this)
            .attr('x2', line.x1 + (line.x2 - line.x1) * 0.02)
            .attr('y2', line.y1 + (line.y2 - line.y1) * 0.02);
        })
        .transition()
        .duration(ARROW_GROW_MS)
        .attr('x2', (edge) => lineOf(edge).x2)
        .attr('y2', (edge) => lineOf(edge).y2);
    }

    const animating = growingEdge !== null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const previousEnd = this.selectedPath.at(-2);
    const previousEligibleIds = animating
      ? new Set(this.topology.connections
          .filter((connection) => connection.fromElementId === previousEnd)
          .map((connection) => connection.toElementId))
      : eligibleIds;
    const previousSelectedIds = animating ? new Set(this.selectedPath.slice(0, -1)) : selectedIds;
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
      shape.attr('stroke', '#667889').attr('stroke-width', 2);
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
      .attr('fill', '#17202a')
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

    const visits = d3.group(this.selectedPath.map((id, index) => ({ id, index: index + 1 })), (item) => item.id);
    node.filter((element) => visits.has(element.id))
      .append('text')
      .attr('x', 0)
      .attr('y', -29)
      .attr('text-anchor', 'middle')
      .attr('fill', '#075f46')
      .attr('font-size', 11)
      .attr('font-weight', 800)
      .text((element) => visits.get(element.id)?.map((item) => item.index).join(',') ?? '');

    node.filter((element) => this.mapPurpose === 'editor' && this.selectedPath.at(-1) === element.id)
      .append('text')
      .attr('x', 0)
      .attr('y', 35)
      .attr('text-anchor', 'middle')
      .attr('fill', '#0b6f8f')
      .attr('font-size', 10)
      .attr('font-weight', 800)
      .text('edit end');

    this.drawVehicles(svg, points, compact);
  }

  private drawTraversalInputs(blocks: d3.Selection<SVGGElement, TrackElementResponse, SVGGElement, unknown>): void {
    blocks.select('.node-shape').attr('fill', '#ffffff').attr('stroke', '#235f7a');
    const emitter = this.blockTraversalChanged;
    blocks.append('foreignObject')
      .attr('x', -20)
      .attr('y', -12)
      .attr('width', 40)
      .attr('height', 24)
      .append('xhtml:input')
      .attr('type', 'text')
      .attr('inputmode', 'numeric')
      .attr('data-block-id', (block) => block.id)
      .attr('aria-label', (block) => `Traversal seconds for ${block.id}`)
      .attr('value', (block) => block.traversalSeconds ?? '')
      // Inline because Angular's scoped component styles do not reach
      // elements created by d3.
      .attr('style', 'width:100%;height:100%;box-sizing:border-box;margin:0;padding:0;border:0;border-radius:10px;'
        + 'background:transparent;color:#17202a;font:800 13px inherit;text-align:center;')
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
      .attr('fill', '#778999');
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
      .attr('fill', '#edf2f6')
      .attr('stroke', '#d3dde6')
      .attr('stroke-dasharray', '5 5');
    groups.append('text')
      .attr('x', (station) => station.x + 10)
      .attr('y', (station) => station.y + 18)
      .attr('fill', '#657789')
      .attr('font-size', 12)
      .attr('font-weight', 800)
      .text((station) => station.id);
  }

  private drawVehicles(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    points: Record<string, Point>,
    compact: boolean,
  ): void {
    const color = d3.scaleOrdinal<string, string>(d3.schemeTableau10);
    const vehicles = this.vehicles.filter((vehicle) => points[vehicle.elementId]);
    const elementCounts = new Map<string, number>();
    const markers = svg.append('g')
      .attr('class', 'vehicles')
      .selectAll('g')
      .data(vehicles)
      .join('g')
      .attr('transform', (vehicle) => {
        // Vehicles on the same element stack upwards so a conflict shows every vehicle.
        const count = elementCounts.get(vehicle.elementId) ?? 0;
        elementCounts.set(vehicle.elementId, count + 1);
        const start = points[vehicle.fromElementId] ?? points[vehicle.elementId];
        const end = points[vehicle.toElementId] ?? start;
        const x = start.x + (end.x - start.x) * vehicle.progress;
        const y = start.y + (end.y - start.y) * vehicle.progress;
        if (compact) {
          // Tracks run vertically here, so labels sit beside the track, towards the map centre.
          return `translate(${x + (x < 260 ? 64 : -64)},${y - count * 32})`;
        }
        return `translate(${x},${y - 38 - count * 32})`;
      });
    markers.append('rect')
      .attr('x', -35)
      .attr('y', -15)
      .attr('width', 70)
      .attr('height', 30)
      .attr('rx', 6)
      .attr('fill', '#ffffff')
      .attr('stroke', (vehicle) => color(vehicle.vehicleId))
      .attr('stroke-width', 2);
    markers.append('circle')
      .attr('cx', -20)
      .attr('r', 10)
      .attr('fill', (vehicle) => color(vehicle.vehicleId))
      .attr('stroke', '#fff')
      .attr('stroke-width', 2);
    markers.append('text')
      .attr('x', -20)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#fff')
      .attr('font-size', 8)
      .attr('font-weight', 800)
      .text((vehicle) => vehicle.vehicleId);
    markers.append('text')
      .attr('x', -4)
      .attr('text-anchor', 'start')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#17202a')
      .attr('font-size', 11)
      .attr('font-weight', 800)
      .text((vehicle) => vehicle.elementId);
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

  private eligibleElementIds(): Set<string> {
    if (!this.interactive) {
      return new Set<string>();
    }
    if (this.selectedPath.length === 0) {
      return new Set(this.topology.elements.map((element) => element.id));
    }
    const current = this.selectedPath[this.selectedPath.length - 1];
    return new Set(
      this.topology.connections
        .filter((connection) => connection.fromElementId === current)
        .map((connection) => connection.toElementId),
    );
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
      return '#dceff3';
    }
    if (element.elementType === 'PLATFORM') {
      return '#e6edf5';
    }
    return '#f0f4e9';
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
    return '#667889';
  }
}
