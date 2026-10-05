import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { of, Subject } from 'rxjs';
import { AppComponent } from './app.component';
import { DeviceEvent, MonitoringService, RuntimeConfig, StreamMessage } from './monitoring.service';

describe('AppComponent', () => {
  let events: Subject<StreamMessage>;

  beforeEach(() => {
    events = new Subject<StreamMessage>();
    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      declarations: [AppComponent],
      providers: [{
        provide: MonitoringService,
        useValue: {
          getConfig: () => of(),
          getDevices: () => of([]),
          getOrder: () => of({ orderNumber: 'order-1', productionTarget: 100, productionState: 50 }),
          events: () => events.asObservable()
        }
      }]
    });
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the device performance dashboard', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Machine performance');
  });

  it('counts estimated output only while the device was running', () => {
    const component = TestBed.createComponent(AppComponent).componentInstance;
    component.config = {
      environment: 'test', environmentColour: 'blue', environmentName: '[TEST]',
      endpoints: { config: '/config', devices: '/devices', events: '/events/{deviceId}', order: '/order/{orderId}' }
    };
    component.selectDevice('device-1');
    const selectedAt = Date.now();
    events.next({ type: 'event', event: eventAt(selectedAt - 1000, 60, 'running') });
    events.next({ type: 'event', event: eventAt(selectedAt, 60, 'running') });
    events.next({ type: 'event', event: eventAt(selectedAt + 60000, 0, 'stopped') });
    events.next({ type: 'event', event: eventAt(selectedAt + 120000, 60, 'stopped') });

    expect(component.producedThisSession).toBe(30);
    expect(component.currentStatus).toBe('stopped');
  });

  it('calculates and caps order progress', () => {
    const component = TestBed.createComponent(AppComponent).componentInstance;
    component.orderInfo = { orderNumber: 'order-1', productionTarget: 100, productionState: 125 };

    expect(component.orderProgress).toBe(100);
  });

  function eventAt(timestamp: number, partsPerMinute: number, status: DeviceEvent['status']): DeviceEvent {
    return { timestamp, partsPerMinute, status, deviceId: 'device-1', order: '' };
  }
});
