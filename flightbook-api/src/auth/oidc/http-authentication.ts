import { INestApplication } from '@nestjs/common';
import { OidcService, oidcOnly } from './oidc.service';

export function configureHttpAuthentication(app: INestApplication): void {
  app.enableCors(
    oidcOnly()
      ? {
          origin: new URL(process.env.MOBILE_APP_URL).origin,
          credentials: true,
        }
      : undefined,
  );
  if (!oidcOnly()) return;
  const oidc = app.get(OidcService);
  app.use(async (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      oidc.assertOrigin(request);
      request.user = await oidc.authenticate(request);
      next();
    } catch (error) {
      const status =
        typeof error.getStatus === 'function' ? error.getStatus() : 503;
      response
        .status(status)
        .json({
          statusCode: status,
          message:
            status === 403
              ? 'Untrusted request origin'
              : 'Session service unavailable',
        });
    }
  });
}
