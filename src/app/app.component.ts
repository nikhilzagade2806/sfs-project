import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import * as d3 from 'd3';
import { Subscription, timer } from 'rxjs';
import { DeviceEvent, DeviceStatus, MonitoringService, OrderInfo, RuntimeConfig } from './monitoring.service';

interface HistoryPoint { timestamp: number; value: number; }
interface Interruption { status: Exclude<DeviceStatus, 'running'>; startedAt: number; durationSeconds: number | null; }

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('rateChart') rateChart?: ElementRef<SVGSVGElement>;
  @ViewChild('outputChart') outputChart?: ElementRef<SVGSVGElement>;

  config: RuntimeConfig | null = null;
  devices: string[] = [];
  selectedDevice = '';
  deviceStatuses: Record<string, DeviceStatus | undefined> = {};
  currentStatus: DeviceStatus | null = null;
  currentRate: number | null = null;
  orderInfo: OrderInfo | null = null;
  errorMessage = '';
  loadingDevices = false;
  streamConnected = false;
  lastEventAt: number | null = null;
  producedThisSession = 0;
  rateHistory: HistoryPoint[] = [];
  outputHistory: HistoryPoint[] = [];
  interruptions: Interruption[] = [];

  private configSubscription?: Subscription;
  private streamSubscription?: Subscription;
  private previousEvent: DeviceEvent | null = null;
  private openInterruption: Interruption | null = null;
  private chartsReady = false;
  private selectionStartedAt = 0;
  private activeOrderId = '';
  private orderRequestPending = false;
  private lastOrderFetchAt = 0;

  constructor(private readonly monitoring: MonitoringService) {}

  ngOnInit(): void { this.configSubscription = timer(0, 30000).subscribe(() => this.refreshConfig()); }
  ngAfterViewInit(): void { this.chartsReady = true; this.drawCharts(); }
  ngOnDestroy(): void { this.configSubscription?.unsubscribe(); this.streamSubscription?.unsubscribe(); }

  get orderProgress(): number | null {
    if (!this.orderInfo || this.orderInfo.productionTarget <= 0) return null;
    return Math.min(100, this.orderInfo.productionState / this.orderInfo.productionTarget * 100);
  }

  get stateMessage(): string {
    if (this.currentStatus === 'maintenance') return 'Machine is undergoing maintenance';
    if (this.currentStatus === 'stopped') return 'Production has stopped';
    if (this.currentStatus === 'running') return 'Production is running normally';
    return 'Waiting for the live machine feed';
  }

  statusClass(status?: DeviceStatus | null): string { return status || 'unknown'; }

  selectDevice(deviceId: string): void {
    if (deviceId === this.selectedDevice) return;
    this.streamSubscription?.unsubscribe();
    this.selectedDevice = deviceId;
    this.selectionStartedAt = Date.now();
    this.currentStatus = null;
    this.currentRate = null;
    this.orderInfo = null;
    this.streamConnected = false;
    this.lastEventAt = null;
    this.producedThisSession = 0;
    this.rateHistory = [];
    this.outputHistory = [];
    this.interruptions = [];
    this.previousEvent = null;
    this.openInterruption = null;
    this.activeOrderId = '';
    this.lastOrderFetchAt = 0;
    this.orderRequestPending = false;
    this.drawCharts();
    this.startSelectedDeviceStream();
  }

  private refreshConfig(): void {
    this.monitoring.getConfig().subscribe({
      next: config => {
        const endpointsChanged = this.config && JSON.stringify(this.config.endpoints) !== JSON.stringify(config.endpoints);
        this.config = config;
        if (!this.devices.length || endpointsChanged) this.loadDevices();
        if (endpointsChanged && this.selectedDevice) this.startSelectedDeviceStream();
      },
      error: error => this.showError('Could not load application configuration', error)
    });
  }

  private loadDevices(): void {
    if (!this.config) return;
    this.loadingDevices = true;
    this.monitoring.getDevices(this.config).subscribe({
      next: devices => {
        this.devices = devices;
        this.loadingDevices = false;
        if (!devices.includes(this.selectedDevice)) this.selectDevice(devices[0] || '');
      },
      error: error => { this.loadingDevices = false; this.showError('Could not load the device list', error); }
    });
  }

  private startSelectedDeviceStream(): void {
    if (!this.config || !this.selectedDevice) return;
    this.streamSubscription?.unsubscribe();
    const deviceId = this.selectedDevice;
    this.streamConnected = false;
    this.streamSubscription = this.monitoring.events(this.config, deviceId).subscribe({
      next: message => {
        if (message.type === 'connected') {
          this.streamConnected = true;
          this.errorMessage = '';
        } else if (message.type === 'disconnected') {
          this.streamConnected = false;
          this.errorMessage = `Live connection to machine ${deviceId} was interrupted. Reconnecting...`;
        } else {
          this.handleEvent(message.event);
        }
      },
      error: error => this.showError(`Could not read events for machine ${deviceId}`, error)
    });
  }

  private handleEvent(event: DeviceEvent): void {
    const timestamp = Number(event.timestamp);
    const rate = Number(event.partsPerMinute);
    if (!Number.isFinite(timestamp) || !Number.isFinite(rate)) {
      this.errorMessage = 'Received an invalid production event from the core service.';
      return;
    }
    if (timestamp < this.selectionStartedAt) return;
    if (this.previousEvent?.status === 'running' && timestamp > this.previousEvent.timestamp) {
      const elapsedMinutes = (timestamp - this.previousEvent.timestamp) / 60000;
      this.producedThisSession += ((rate + this.previousEvent.partsPerMinute) / 2) * elapsedMinutes;
    }

    this.currentStatus = event.status;
    this.currentRate = rate;
    this.deviceStatuses[event.deviceId] = event.status;
    this.lastEventAt = timestamp;
    this.rateHistory.push({ timestamp, value: rate });
    this.outputHistory.push({ timestamp, value: this.producedThisSession });
    this.recordInterruption(event);
    this.previousEvent = event;

    if (event.order && event.order !== this.activeOrderId) {
      this.activeOrderId = event.order;
      this.orderInfo = null;
      this.lastOrderFetchAt = 0;
    }
    if (event.order && !this.orderRequestPending && Date.now() - this.lastOrderFetchAt >= 5000) this.loadOrder(event.order);
    this.drawCharts();
  }

  private recordInterruption(event: DeviceEvent): void {
    if (event.status === 'running' && this.openInterruption) {
      const completed = { ...this.openInterruption, durationSeconds: Math.max(0, (event.timestamp - this.openInterruption.startedAt) / 1000) };
      this.interruptions = [completed, ...this.interruptions.slice(1)];
      this.openInterruption = null;
      return;
    }
    if (event.status !== 'running' && (!this.previousEvent || this.previousEvent.status === 'running')) {
      const interruption: Interruption = { status: event.status, startedAt: event.timestamp, durationSeconds: null };
      this.openInterruption = interruption;
      this.interruptions = [interruption, ...this.interruptions].slice(0, 5);
    }
  }

  private loadOrder(orderId: string): void {
    if (!this.config) return;
    this.orderRequestPending = true;
    this.lastOrderFetchAt = Date.now();
    this.monitoring.getOrder(this.config, orderId).subscribe({
      next: order => {
        this.orderInfo = order;
        this.orderRequestPending = false;
        if (this.errorMessage.startsWith(`Could not load order ${orderId}`)) this.errorMessage = '';
      },
      error: () => {
        this.orderRequestPending = false;
        this.errorMessage = `Could not load order ${orderId}. The dashboard will retry while the machine stream is active.`;
      }
    });
  }

  private showError(message: string, error: unknown): void {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    this.errorMessage = `${message}${detail}`;
  }

  private drawCharts(): void {
    if (!this.chartsReady) return;
    this.drawChart(this.rateChart?.nativeElement, this.rateHistory, '#e16d4d');
    this.drawChart(this.outputChart?.nativeElement, this.outputHistory, '#177f70');
  }

  private drawChart(element: SVGSVGElement | undefined, points: HistoryPoint[], color: string): void {
    if (!element) return;
    const svg = d3.select(element);
    svg.selectAll('*').remove();
    if (!points.length) return;
    const width = 640;
    const height = 240;
    const margin = { top: 12, right: 18, bottom: 30, left: 42 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const first = points[0].timestamp;
    const last = points[points.length - 1].timestamp;
    const domain: [Date, Date] = first === last ? [new Date(first - 1000), new Date(last + 1000)] : [new Date(first), new Date(last)];
    const x = d3.scaleTime().domain(domain).range([0, plotWidth]);
    const values = points.map(point => point.value);
    const extent = d3.extent(values) as [number, number];
    const padding = (extent[1] - extent[0]) * 0.15 || Math.max(extent[1] * 0.12, 1);
    const y = d3.scaleLinear().domain([Math.max(0, extent[0] - padding), extent[1] + padding]).nice().range([plotHeight, 0]);
    const plot = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    plot.append('g').attr('class', 'chart-grid').call(d3.axisLeft(y).ticks(4).tickSize(-plotWidth).tickFormat(() => ''));
    plot.append('g').attr('class', 'chart-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(9).tickFormat(value => d3.format('.0f')(Number(value))));
    plot.append('g').attr('class', 'chart-axis chart-x-axis').attr('transform', `translate(0,${plotHeight})`).call(d3.axisBottom(x).ticks(4).tickSize(0).tickPadding(10).tickFormat(value => d3.timeFormat('%H:%M')(value as Date)));
    const line = d3.line<HistoryPoint>().x(point => x(new Date(point.timestamp))).y(point => y(point.value)).curve(d3.curveMonotoneX);
    plot.append('path').datum(points).attr('class', 'chart-line').attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2.5).attr('d', line);
    const latest = points[points.length - 1];
    plot.append('circle').attr('cx', x(new Date(latest.timestamp))).attr('cy', y(latest.value)).attr('r', 4).attr('fill', color).attr('stroke', '#fff').attr('stroke-width', 2);
  }
}
