import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import {
  BlockRequest, BlockResponse, ScheduleAnalysis, ServiceRequest, ServiceResponse,
  TopologyResponse, VehicleResponse,
} from './models';

const API_BASE_URL = 'http://localhost:8000';

@Injectable({ providedIn: 'root' })
export class SchedulingApi {
  private readonly http = inject(HttpClient);

  getVehicles() {
    return this.http.get<VehicleResponse[]>(`${API_BASE_URL}/vehicles`);
  }

  getTopology() {
    return this.http.get<TopologyResponse>(`${API_BASE_URL}/topology`);
  }

  getBlocks() {
    return this.http.get<BlockResponse[]>(`${API_BASE_URL}/blocks`);
  }

  getServices() {
    return this.http.get<ServiceResponse[]>(`${API_BASE_URL}/services`);
  }

  getAnalysis() {
    return this.http.get<ScheduleAnalysis>(`${API_BASE_URL}/schedule-analysis`);
  }

  saveBlock(blockId: string, request: BlockRequest) {
    return this.http.put<BlockResponse>(`${API_BASE_URL}/blocks/${encodeURIComponent(blockId)}`, request);
  }

  createService(request: ServiceRequest) {
    return this.http.post<ServiceResponse>(`${API_BASE_URL}/services`, request);
  }

  updateService(serviceId: number, request: ServiceRequest) {
    return this.http.put<ServiceResponse>(`${API_BASE_URL}/services/${serviceId}`, request);
  }

  deleteService(serviceId: number) {
    return this.http.delete<void>(`${API_BASE_URL}/services/${serviceId}`);
  }
}
