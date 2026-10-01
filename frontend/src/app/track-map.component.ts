import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import * as d3 from 'd3';

import { PlaybackVehicleState, TopologyResponse, TrackElementResponse } from './models';

interface Point {
  x: number;
  y: number;
}

const VIEWBOX_WIDTH = 1040;
const VIEWBOX_HEIGHT = 500;

const POINTS: Record<string, Point> = {
  Y: { x: 970, y: 250 },
  B1: { x: 895, y: 170 },
  B2: { x: 895, y: 330 },
  P1A: { x: 805, y: 130 },
  P1B: { x: 805, y: 370 },
  B3: { x: 715, y: 110 },
  B4: { x: 715, y: 330 },
  B5: { x: 625, y: 155 },
  P2A: { x: 530, y: 130 },
  B6: { x: 435, y: 130 },
  B7: { x: 345, y: 90 },
  B8: { x: 345, y: 205 },
  P3A: { x: 245, y: 90 },
  P3B: { x: 245, y: 230 },
  B10: { x: 285, y: 320 },
  B9: { x: 285, y: 410 },
  B11: { x: 430, y: 365 },
  P2B: { x: 530, y: 365 },
  B12: { x: 625, y: 365 },
  B13: { x: 705, y: 225 },
  B14: { x: 715, y: 410 },
};

@Component({
  selector: 'app-track-map',
  standalone: true,
  template: `
    <div class="map-frame">
      <svg #svg role="img" aria-label="Interactive directed railway track map"></svg>
    </div>
    <div class="legend" aria-label="Track map legend">
      <span><i class="yard"></i>Yard</span>
      <span><i class="platform"></i>Platform</span>
      <span><i class="block"></i>Block</span>
      <span><i class="candidate"></i>Available next</span>
      <span><i class="conflict"></i>Conflict</span>
    </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .map-frame { width: 100%; overflow: hidden; border: 1px solid #d5dee7; border-radius: 8px; background: #f8fafc; }
    svg { display: block; width: 100%; height: auto; aspect-ratio: 1040 / 500; min-height: 300px; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: #536475; font-size: 12px; font-weight: 700; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 13px; height: 13px; border: 2px solid #506172; border-radius: 3px; background: #fff; }
    .legend .yard { background: #d8edf2; }
    .legend .platform { background: #e6edf5; }
    .legend .block { border-radius: 50%; background: #f0f4e9; }
    .legend .candidate { border-color: #13815b; box-shadow: 0 0 0 2px #bce8d6; }
    .legend .conflict { border-color: #b42318; background: #fee4e2; }
    @media (max-width: 680px) {
      svg { aspect-ratio: 520 / 980; min-height: 0; }
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
  @Output() readonly elementSelected = new EventEmitter<string>();

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.svgRef && Object.keys(changes).length > 0) {
      this.render();
    }
  }

  private render(): void {
    if (!this.svgRef) {
      return;
    }

    const svg = d3.select(this.svgRef.nativeElement);
    const compact = window.matchMedia('(max-width: 680px)').matches;
    const points = this.layoutPoints(compact);
    svg.selectAll('*').remove();
    svg.attr('viewBox', compact ? '0 0 520 980' : `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`);
    this.addMarkers(svg);

    const elements = this.topology.elements.filter((element) => points[element.id] !== undefined);
    const selectedEdges = new Set(
      this.selectedPath.slice(0, -1).map((elementId, index) => `${elementId}->${this.selectedPath[index + 1]}`),
    );
    const selectedIds = new Set(this.selectedPath);
    const conflictIds = new Set(this.conflictElementIds);
    const eligibleIds = this.eligibleElementIds();

    this.drawStationBands(svg, compact);
    svg.append('g')
      .attr('class', 'connections')
      .selectAll('line')
      .data(this.topology.connections.filter((edge) => points[edge.fromElementId] && points[edge.toElementId]))
      .join('line')
      .attr('x1', (edge) => points[edge.fromElementId].x)
      .attr('y1', (edge) => points[edge.fromElementId].y)
      .attr('x2', (edge) => points[edge.toElementId].x)
      .attr('y2', (edge) => points[edge.toElementId].y)
      .attr('stroke', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? '#13795b' : '#9aabba')
      .attr('stroke-width', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? 6 : 2.5)
      .attr('stroke-linecap', 'round')
      .attr('marker-end', (edge) => selectedEdges.has(`${edge.fromElementId}->${edge.toElementId}`) ? 'url(#arrow-selected)' : 'url(#arrow)');

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
      .style('opacity', (element) => this.interactive && eligibleIds.size > 0 && !eligibleIds.has(element.id) && !selectedIds.has(element.id) ? 0.38 : 1)
      .on('click', (_, element) => this.select(element.id, eligibleIds))
      .on('keydown', (event: KeyboardEvent, element) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.select(element.id, eligibleIds);
        }
      });

    node.append('rect')
      .attr('x', (element) => element.elementType === 'BLOCK' ? -22 : -31)
      .attr('y', (element) => element.elementType === 'BLOCK' ? -16 : -21)
      .attr('width', (element) => element.elementType === 'BLOCK' ? 44 : 62)
      .attr('height', (element) => element.elementType === 'BLOCK' ? 32 : 42)
      .attr('rx', (element) => element.elementType === 'YARD' ? 4 : element.elementType === 'PLATFORM' ? 7 : 16)
      .attr('fill', (element) => this.nodeFill(element, selectedIds, conflictIds))
      .attr('stroke', (element) => this.nodeStroke(element, eligibleIds, selectedIds, conflictIds))
      .attr('stroke-width', (element) => eligibleIds.has(element.id) || selectedIds.has(element.id) || conflictIds.has(element.id) ? 4 : 2);

    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#17202a')
      .attr('font-size', 14)
      .attr('font-weight', 800)
      .text((element) => element.id);

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

    this.drawVehicles(svg, points);
  }

  private addMarkers(svg: d3.Selection<SVGSVGElement, unknown, null, undefined>): void {
    const defs = svg.append('defs');
    for (const [id, color] of [['arrow', '#778999'], ['arrow-selected', '#13795b']] as const) {
      defs.append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 19)
        .attr('markerWidth', 5)
        .attr('markerHeight', 5)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', color);
    }
  }

  private drawStationBands(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    compact: boolean,
  ): void {
    const stations = compact
      ? [
          { id: 'S1', x: 60, y: 150, width: 400, height: 105 },
          { id: 'S2', x: 60, y: 460, width: 400, height: 105 },
          { id: 'S3', x: 60, y: 760, width: 400, height: 120 },
        ]
      : [
          { id: 'S3', x: 180, y: 45, width: 145, height: 235 },
          { id: 'S2', x: 485, y: 75, width: 90, height: 335 },
          { id: 'S1', x: 765, y: 75, width: 80, height: 340 },
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
  ): void {
    const color = d3.scaleOrdinal<string, string>(d3.schemeTableau10);
    const markers = svg.append('g')
      .attr('class', 'vehicles')
      .selectAll('g')
      .data(this.vehicles.filter((vehicle) => points[vehicle.elementId]))
      .join('g')
      .attr('transform', (vehicle) => {
        const start = points[vehicle.elementId];
        const end = points[vehicle.nextElementId] ?? start;
        const x = start.x + (end.x - start.x) * vehicle.progress;
        const y = start.y + (end.y - start.y) * vehicle.progress;
        return `translate(${x},${y - 28})`;
      });
    markers.append('circle')
      .attr('r', 13)
      .attr('fill', (vehicle) => color(vehicle.vehicleId))
      .attr('stroke', '#fff')
      .attr('stroke-width', 3);
    markers.append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', '#fff')
      .attr('font-size', 9)
      .attr('font-weight', 800)
      .text((vehicle) => vehicle.vehicleId);
  }

  private layoutPoints(compact: boolean): Record<string, Point> {
    if (!compact) {
      return POINTS;
    }
    return Object.fromEntries(
      Object.entries(POINTS).map(([id, point]) => [
        id,
        {
          x: 55 + ((point.y - 45) / 365) * 410,
          y: 55 + ((970 - point.x) / 790) * 870,
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

  private nodeFill(element: TrackElementResponse, selected: Set<string>, conflicts: Set<string>): string {
    if (conflicts.has(element.id)) {
      return '#fee4e2';
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
    eligible: Set<string>,
    selected: Set<string>,
    conflicts: Set<string>,
  ): string {
    if (conflicts.has(element.id)) {
      return '#b42318';
    }
    if (selected.has(element.id)) {
      return '#13795b';
    }
    if (eligible.has(element.id)) {
      return '#16845e';
    }
    return '#667889';
  }
}
