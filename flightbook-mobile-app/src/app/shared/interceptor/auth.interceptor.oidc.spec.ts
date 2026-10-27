import { HttpRequest, HttpResponse } from '@angular/common/http';
import { of } from 'rxjs';
import { environment } from 'src/environments/environment';
import { HttpAuthInterceptor } from './auth.interceptor';

describe('OIDC HTTP authentication', () => {
  let account: any;
  let interceptor: HttpAuthInterceptor;
  let received: HttpRequest<any>;
  const handler = { handle: (req: HttpRequest<any>) => {
    received = req;
    return of(new HttpResponse({ status: 200 }));
  } };
  beforeEach(() => {
    account = { isOidcMode: true, isAuth: jasmine.createSpy().and.resolveTo(true) };
    interceptor = new HttpAuthInterceptor({ navigate: jasmine.createSpy() } as any, account);
  });
  it('uses the secure API cookie without a localStorage bearer token', async () => {
    await interceptor.handle(new HttpRequest('GET', `${environment.baseUrl}/flights`), handler);
    expect(received.withCredentials).toBeTrue();
    expect(received.headers.has('Authorization')).toBeFalse();
  });
  it('does not recurse through authentication while checking a session', async () => {
    await interceptor.handle(new HttpRequest('GET', `${environment.baseUrl}/auth/session`), handler);
    expect(account.isAuth).not.toHaveBeenCalled();
    expect(received.withCredentials).toBeTrue();
  });
  it('preserves signed S3 uploads without sending API cookies or bearer tokens', async () => {
    const url = 'https://flightbook-s3.example.test/flightbook/track.igc?X-Amz-Signature=fixture';
    await interceptor.handle(new HttpRequest('PUT', url, 'track-data'), handler);
    expect(account.isAuth).not.toHaveBeenCalled();
    expect(received.url).toBe(url);
    expect(received.withCredentials).toBeFalse();
    expect(received.headers.has('Authorization')).toBeFalse();
  });
});
