import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { MonitoringService, RuntimeConfig } from './monitoring.service';

describe('MonitoringService', () => {
  let service: MonitoringService;
  let httpMock: HttpTestingController;
  const config: RuntimeConfig = {
    environment: 'test',
    environmentColour: 'blue',
    environmentName: '[TEST]',
    endpoints: { config: '/config', devices: '/devices', events: '/events/{deviceId}', order: '/order/{orderId}' }
  };
  const orderUrl = 'https://mock-api.assessment.sfsdm.org/order/299';

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(MonitoringService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('retries transient order failures and returns the recovered response', fakeAsync(() => {
    let orderNumber = '';
    service.getOrder(config, '299').subscribe(order => orderNumber = order.orderNumber);

    httpMock.expectOne(orderUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    tick(500);
    httpMock.expectOne(orderUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    tick(1000);
    httpMock.expectOne(orderUrl).flush({}, { status: 503, statusText: 'Unavailable' });
    tick(2000);
    httpMock.expectOne(orderUrl).flush({ orderNumber: '299', productionTarget: 100, productionState: 25 });

    expect(orderNumber).toBe('299');
  }));

  it('does not retry a non-transient not-found response', () => {
    let failed = false;
    service.getOrder(config, 'missing').subscribe({ error: () => failed = true });

    httpMock.expectOne('https://mock-api.assessment.sfsdm.org/order/missing').flush({}, { status: 404, statusText: 'Not Found' });

    expect(failed).toBeTrue();
  });
});
