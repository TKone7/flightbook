// Run after npm run build with an EMPTY temporary PostgreSQL/PostGIS database.
// Refuse to touch a database unless explicitly enabled for this test.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Client } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { DataSource } = require('typeorm');
const issuer = 'https://id.flightbook.test';
let app,
  database,
  oidc,
  OidcService,
  jose,
  key,
  publicKey,
  current,
  tokenOptions = {};
const originalFetch = global.fetch;

function response() {
  return {
    cookies: {},
    cookie(name, value, options) {
      this.cookies[name] = { value, options };
    },
    clearCookie(name) {
      delete this.cookies[name];
    },
  };
}
function request(cookies = {}, options = {}) {
  return {
    method: 'GET',
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    },
    query: {},
    ...options,
  };
}
async function begin() {
  const res = response();
  const url = new URL(await oidc.start(res));
  current = url;
  const state = url.searchParams.get('state');
  const req = request(
    { '__Host-flightbook_oidc': res.cookies['__Host-flightbook_oidc'].value },
    {
      query: { code: 'fixture', state },
      originalUrl: `/auth/oidc/callback?code=fixture&state=${state}`,
    },
  );
  return { req, res, url };
}
async function login() {
  const transaction = await begin();
  await oidc.callback(transaction.req, transaction.res);
  return transaction.res.cookies['__Host-flightbook_session'].value;
}

before(async () => {
  assert.equal(
    process.env.FLIGHTBOOK_TEST_DATABASE,
    'true',
    'Use only a disposable database and set FLIGHTBOOK_TEST_DATABASE=true',
  );
  Object.assign(process.env, {
    OIDC_ONLY: 'true',
    SELF_HOSTED: 'true',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'flightbook-test',
    OIDC_CLIENT_SECRET: 'test-client-secret',
    OIDC_REDIRECT_URI: 'https://api.flightbook.test/auth/oidc/callback',
    MOBILE_APP_URL: 'https://web.flightbook.test',
    DATABASE_SYNCHRONIZE: 'false',
    DATABASE_SSL: 'false',
  });
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'data' AND table_name = 'app_user'`,
  );
  assert.equal(
    rows.length,
    0,
    'Refusing to test against an existing Flightbook database',
  );
  await client.query(
    'CREATE SCHEMA IF NOT EXISTS data; CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public',
  );
  const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';
  await client.query(
    `ALTER ROLE ${identifier(process.env.DATABASE_USER)} IN DATABASE ${identifier(process.env.DATABASE_NAME)} SET search_path TO data, public`,
  );
  await client.end();
  jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256');
  key = pair.privateKey;
  publicKey = {
    ...(await jose.exportJWK(pair.publicKey)),
    kid: 'fixture',
    alg: 'RS256',
    use: 'sig',
  };
  global.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const json = (value) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.href === `${issuer}/.well-known/openid-configuration`)
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    if (url.href === `${issuer}/jwks`) return json({ keys: [publicKey] });
    if (url.href === `${issuer}/token`) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('redirect_uri'), process.env.OIDC_REDIRECT_URI);
      assert.equal(
        createHash('sha256')
          .update(body.get('code_verifier'))
          .digest('base64url'),
        current.searchParams.get('code_challenge'),
      );
      const claims = {
        sub: 'pilot',
        email: 'pilot@example.com',
        email_verified: true,
        given_name: 'Test',
        family_name: 'Pilot',
        nonce: current.searchParams.get('nonce'),
        ...tokenOptions,
      };
      const signingKey = tokenOptions.badSignature
        ? (await jose.generateKeyPair('RS256')).privateKey
        : key;
      const jwt = await new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(tokenOptions.iss || issuer)
        .setAudience(tokenOptions.aud || 'flightbook-test')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      return json({
        access_token: 'test-access',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: jwt,
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  ({ OidcService } = require('../../dist/auth/oidc/oidc.service'));
  app = await NestFactory.create(require('../../dist/app.module').AppModule, {
    logger: false,
    abortOnError: false,
  });
  require('../../dist/auth/oidc/http-authentication').configureHttpAuthentication(
    app,
  );
  await app.init();
  database = app.get(DataSource);
  oidc = app.get(OidcService);
});
after(async () => {
  global.fetch = originalFetch;
  if (app) await app.close();
});

test('clean upstream and OIDC migrations run without schema synchronization', async () => {
  const rows = await database.query(
    'SELECT name FROM data.db_migrations WHERE name = $1',
    ['OidcSessions1793109000000'],
  );
  assert.equal(rows.length, 1);
});
test('OIDC code exchange uses PKCE and creates a secure cookie and issuer/subject identity', async () => {
  const { req, res, url } = await begin();
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await oidc.callback(req, res);
  const cookie = res.cookies['__Host-flightbook_session'];
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.secure, true);
  assert.equal(cookie.options.path, '/');
  assert.equal(cookie.options.domain, undefined);
  assert.equal(
    (
      await oidc.authenticate(
        request({ '__Host-flightbook_session': cookie.value }),
      )
    ).email,
    'pilot@example.com',
  );
  const identities = await database.query(
    'SELECT issuer, subject FROM data.oidc_identity',
  );
  assert.deepEqual(identities, [{ issuer, subject: 'pilot' }]);
  const sessions = await database.query(
    'SELECT token_hash FROM data.oidc_session',
  );
  assert(!sessions.some((row) => row.token_hash === cookie.value));
  await assert.rejects(oidc.callback(req, res)); // callback cannot be replayed
});
test('wrong browser binding cannot consume another browser login', async () => {
  const { req, res } = await begin();
  const wrong = {
    ...req,
    headers: { cookie: `__Host-flightbook_oidc=${'a'.repeat(43)}` },
  };
  await assert.rejects(oidc.callback(wrong, response()));
  await oidc.callback(req, res);
});
test('invalid nonce, issuer, audience, signature and unverified email are rejected', async () => {
  for (const invalid of [
    { nonce: 'wrong' },
    { iss: 'https://other.test' },
    { aud: 'other-client' },
    { badSignature: true },
    { email_verified: false },
  ]) {
    tokenOptions = invalid;
    const { req, res } = await begin();
    await assert.rejects(oidc.callback(req, res));
    assert.equal(res.cookies['__Host-flightbook_session'], undefined);
  }
  tokenOptions = {};
});
test('a different subject cannot take over an existing account by email', async () => {
  tokenOptions = { sub: 'another-person' };
  const { req, res } = await begin();
  await assert.rejects(
    oidc.callback(req, res),
    /account with this email exists/,
  );
  tokenOptions = {};
});
test('session survives a service restart, expires and can be revoked', async () => {
  const token = await login();
  const req = request({ '__Host-flightbook_session': token });
  const restarted = new OidcService(database);
  assert(await restarted.authenticate(req));
  await restarted.logout(req, response());
  assert.equal(await oidc.authenticate(req), undefined);
  const expired = await login();
  await database.query(
    "UPDATE data.oidc_session SET expires_at = now() - interval '1 second'",
  );
  assert.equal(
    await oidc.authenticate(request({ '__Host-flightbook_session': expired })),
    undefined,
  );
});
test('unsafe requests require the exact frontend Origin', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => oidc.assertOrigin(request({}, { method })), /origin/);
    assert.throws(
      () =>
        oidc.assertOrigin(
          request({}, { method, headers: { origin: 'https://evil.test' } }),
        ),
      /origin/,
    );
    assert.doesNotThrow(() =>
      oidc.assertOrigin(
        request(
          {},
          { method, headers: { origin: process.env.MOBILE_APP_URL } },
        ),
      ),
    );
  }
});
test('HTTP routes enforce cookie authentication, origin checks, logout and OIDC-only mode', async () => {
  const http = require('supertest')(app.getHttpServer());
  await http.get('/auth/config').expect(200, { oidc: true, selfHosted: true });
  await http.get('/users').expect(401);
  const token = await login();
  const cookie = `__Host-flightbook_session=${token}`;
  const session = await http
    .get('/auth/session')
    .set('Cookie', cookie)
    .expect(200);
  assert.equal(session.body.authenticated, true);
  await http.get('/users').set('Cookie', cookie).expect(200);
  const payment = await http
    .get('/payments/status')
    .set('Cookie', cookie)
    .expect(200);
  assert.equal(payment.body.active, true);
  await http
    .post('/payments/cancel')
    .set('Cookie', cookie)
    .set('Origin', process.env.MOBILE_APP_URL)
    .send({})
    .expect(404);
  await http
    .post('/auth/oidc/logout')
    .set('Cookie', cookie)
    .send({})
    .expect(403);
  await http
    .post('/auth/login')
    .set('Origin', process.env.MOBILE_APP_URL)
    .send({ email: 'pilot@example.com', password: 'unused' })
    .expect(401);
  await http
    .post('/users')
    .set('Origin', process.env.MOBILE_APP_URL)
    .send({})
    .expect(401);
  await http
    .post('/auth/oidc/logout')
    .set('Cookie', cookie)
    .set('Origin', process.env.MOBILE_APP_URL)
    .send({})
    .expect(204);
  const revoked = await http
    .get('/auth/session')
    .set('Cookie', cookie)
    .expect(200);
  assert.equal(revoked.body.authenticated, false);
});
test('browser login redirects through the provider and never puts session tokens in the URL', async () => {
  const http = require('supertest')(app.getHttpServer());
  const started = await http.get('/auth/oidc/login').expect(302);
  current = new URL(started.headers.location);
  const state = current.searchParams.get('state');
  const cookie = started.headers['set-cookie'][0].split(';')[0];
  const completed = await http
    .get('/auth/oidc/callback')
    .query({ code: 'fixture', state })
    .set('Cookie', cookie)
    .expect(302);
  assert.equal(completed.headers.location, 'https://web.flightbook.test/home');
  assert(
    completed.headers['set-cookie'].some((value) =>
      value.startsWith('__Host-flightbook_session='),
    ),
  );
  const replayed = await http
    .get('/auth/oidc/callback')
    .query({ code: 'fixture', state })
    .set('Cookie', cookie)
    .expect(401);
  assert.equal(
    replayed.body.message,
    'Sign-in failed. Return to Flightbook and try again.',
  );
});
test('Garage still receives a direct presigned S3 URL with configurable region and no legacy ACL', async () => {
  Object.assign(process.env, {
    ENV: 'prod',
    AWS_REGION: 'garage',
    AWS_S3_ENDPOINT: 'https://storage.flightbook.test',
    AWS_BUCKET: 'flightbook',
    AWS_ACCESS_KEY_ID: 'fixture-key',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    AWS_S3_FORCE_PATH_STYLE: 'true',
    AWS_S3_DISABLE_ACL: 'true',
      AWS_REQUEST_CHECKSUM_CALCULATION: 'WHEN_REQUIRED',
  });
  const {
    FileUploadService,
  } = require('../../dist/fileupload/file-upload.service');
  const signed = new URL(
    (await new FileUploadService().getSignedFileUploadUrl('track.igc', 1)).url,
  );
  assert.equal(signed.origin, 'https://storage.flightbook.test');
  assert.equal(signed.pathname, '/flightbook/prod/1/track.igc');
  assert(
    signed.searchParams
      .get('X-Amz-Credential')
      .includes('/garage/s3/aws4_request'),
  );
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(signed.searchParams.has('x-amz-acl'), false);
  assert.equal(signed.searchParams.has('x-amz-checksum-crc32'), false);
});
test('disabled local accounts cannot sign in or use existing sessions', async () => {
  const token = await login();
  await database.query('UPDATE data.app_user SET enabled = false');
  assert.equal(
    await oidc.authenticate(request({ '__Host-flightbook_session': token })),
    undefined,
  );
  const { req, res } = await begin();
  await assert.rejects(oidc.callback(req, res), /disabled/);
});
