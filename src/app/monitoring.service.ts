import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { NgZone } from '@angular/core';
import { Observable, retry, throwError, timer } from 'rxjs';

const API_BASE_URL = 'https://mock-api.assessment.sfsdm.org';

export interface RuntimeConfig {
  availableLanguages?: string[];
  environment: string;
  environmentColour: string;
  environmentName: string;
  endpoints: { config: string; devices: string; events: string; order: string; };
}
export type DeviceStatus = 'running' | 'stopped' | 'maintenance';
export interface DeviceEvent { timestamp: number; partsPerMinute: number; status: DeviceStatus; deviceId: string; order: string; }
export interface OrderInfo { orderNumber: string; productionTarget: number; productionState: number; }
export type StreamMessage = { type: 'connected' } | { type: 'disconnected' } | { type: 'event'; event: DeviceEvent };

@Injectable({ providedIn: 'root' })
export class MonitoringService {
  constructor(private readonly http: HttpClient, private readonly zone: NgZone) {}

  getConfig(): Observable<RuntimeConfig> { return this.http.get<RuntimeConfig>(this.url('/config')); }
  getDevices(config: RuntimeConfig): Observable<string[]> { return this.http.get<string[]>(this.url(config.endpoints.devices)); }
  getOrder(config: RuntimeConfig, orderId: string): Observable<OrderInfo> {
    return this.http.get<OrderInfo>(this.url(config.endpoints.order.replace('{orderId}', encodeURIComponent(orderId)))).pipe(
      retry({
        count: 3,
        delay: (error: HttpErrorResponse, retryCount: number) =>
          error.status === 0 || error.status >= 500
            ? timer(500 * 2 ** (retryCount - 1))
            : throwError(() => error)
      })
    );
  }

  events(config: RuntimeConfig, deviceId: string): Observable<StreamMessage> {
    const path = config.endpoints.events.replace('{deviceId}', encodeURIComponent(deviceId));
    return new Observable<StreamMessage>(observer => {
      const source = new EventSource(this.url(path));
      source.onopen = () => this.zone.run(() => observer.next({ type: 'connected' }));
      source.onmessage = message => {
        try { this.zone.run(() => observer.next({ type: 'event', event: JSON.parse(message.data) as DeviceEvent })); }
        catch { this.zone.run(() => observer.error(new Error('The event stream returned invalid JSON.'))); }
      };
      source.onerror = () => this.zone.run(() => observer.next({ type: 'disconnected' }));
      return () => source.close();
    });
  }

  private url(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  }
}