import {
  ForbiddenException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import type * as OpenIdClient from 'openid-client';
import { User } from '../../user/domain/user.entity';

export const SESSION_COOKIE = '__Host-flightbook_session';
export const LOGIN_COOKIE = '__Host-flightbook_oidc';
export const oidcOnly = () => process.env.OIDC_ONLY === 'true';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

export function readCookie(request: Request, name: string): string | undefined {
  const cookies = (request.headers.cookie || '')
    .split(';')
    .map((part) => part.trim());
  const value = cookies
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  // All cookies issued here are base64url tokens. Never accept ambiguous encoding.
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

@Injectable()
export class OidcService implements OnModuleInit {
  private client: typeof OpenIdClient;
  private configuration: Promise<OpenIdClient.Configuration>;
  constructor(private readonly database: DataSource) {}

  onModuleInit() {
    if (!oidcOnly()) return;
    for (const name of [
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
      'MOBILE_APP_URL',
    ]) {
      if (!process.env[name])
        throw new Error(`${name} is required in OIDC mode`);
    }
    for (const name of ['OIDC_ISSUER', 'OIDC_REDIRECT_URI', 'MOBILE_APP_URL']) {
      const url = new URL(process.env[name]);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        throw new Error(
          `${name} must be an HTTPS URL without credentials, query or fragment`,
        );
      }
    }
    this.sessionSeconds();
  }

  private sessionSeconds(): number {
    const seconds = Number(process.env.SESSION_MAX_AGE_SECONDS || 604800);
    if (!Number.isInteger(seconds) || seconds < 300 || seconds > 2592000) {
      throw new Error(
        'SESSION_MAX_AGE_SECONDS must be between 300 and 2592000',
      );
    }
    return seconds;
  }

  private async config(): Promise<OpenIdClient.Configuration> {
    // Node 24 supports require(esm); defer loading while legacy auth is active.
    this.client ||= require('openid-client') as typeof OpenIdClient;
    if (!this.configuration) {
      this.configuration = this.client
        .discovery(
          new URL(process.env.OIDC_ISSUER),
          process.env.OIDC_CLIENT_ID,
          process.env.OIDC_CLIENT_SECRET,
        )
        .then((configuration) => {
          this.client.enableNonRepudiationChecks(configuration);
          return configuration;
        })
        .catch((error) => {
          this.configuration = undefined;
          throw error;
        });
    }
    return this.configuration;
  }

  async start(response: Response): Promise<string> {
    const configuration = await this.config();
    const state = random();
    const binding = random();
    const verifier = this.client.randomPKCECodeVerifier();
    const nonce = random();
    await this.database.query(
      'DELETE FROM data.oidc_login WHERE expires_at <= now()',
    );
    await this.database.query(
      'DELETE FROM data.oidc_session WHERE expires_at <= now()',
    );
    await this.database.query(
      `INSERT INTO data.oidc_login
      (state_hash, cookie_hash, verifier, nonce, expires_at)
      VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [hash(state), hash(binding), verifier, nonce],
    );
    response.cookie(LOGIN_COOKIE, binding, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600000,
    });
    return this.client.buildAuthorizationUrl(configuration, {
      redirect_uri: process.env.OIDC_REDIRECT_URI,
      scope: process.env.OIDC_SCOPES || 'openid profile email',
      code_challenge_method: 'S256',
      code_challenge: await this.client.calculatePKCECodeChallenge(verifier),
      state,
      nonce,
    }).href;
  }

  async callback(request: Request, response: Response): Promise<void> {
    const binding = readCookie(request, LOGIN_COOKIE);
    response.clearCookie(LOGIN_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    const state =
      typeof request.query.state === 'string' ? request.query.state : '';
    if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(state))
      throw new UnauthorizedException('Invalid sign-in transaction');
    // Atomic consumption prevents callback replay, including across API instances.
    const [transaction] = await this.database.query(
      `WITH consumed AS (DELETE FROM data.oidc_login
      WHERE state_hash = $1 AND cookie_hash = $2 AND expires_at > now() RETURNING *)
      SELECT * FROM consumed`,
      [hash(state), hash(binding)],
    );
    if (!transaction)
      throw new UnauthorizedException('Sign-in expired; start again');
    const configuration = await this.config();
    const callback = new URL(process.env.OIDC_REDIRECT_URI);
    // Never derive the callback origin from untrusted Host/forwarded headers.
    callback.search = new URL(request.originalUrl, callback.origin).search;
    const tokens = await this.client.authorizationCodeGrant(
      configuration,
      callback,
      {
        pkceCodeVerifier: transaction.verifier,
        expectedState: state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (
      !claims?.sub ||
      typeof claims.email !== 'string' ||
      claims.email_verified !== true
    ) {
      throw new UnauthorizedException('A verified email address is required');
    }
    const email = claims.email.toLowerCase();
    const allowed = (process.env.OIDC_ALLOWED_EMAILS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(email))
      throw new ForbiddenException('Account is not allowed');
    const user = await this.resolveIdentity(
      claims.iss,
      claims.sub,
      email,
      claims,
    );
    const token = random();
    // Rotate a previous local session rather than keeping it alive after a new login.
    const previous = readCookie(request, SESSION_COOKIE);
    if (previous)
      await this.database.query(
        'DELETE FROM data.oidc_session WHERE token_hash = $1',
        [hash(previous)],
      );
    await this.database.query(
      `INSERT INTO data.oidc_session (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)`,
      [
        hash(token),
        user.id,
        new Date(Date.now() + this.sessionSeconds() * 1000),
      ],
    );
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionSeconds() * 1000,
    });
  }

  private async resolveIdentity(
    issuer: string,
    subject: string,
    email: string,
    claims: any,
  ): Promise<User> {
    return this.database.transaction(async (manager) => {
      // Serialize first logins for this identity. Never auto-link existing users by email.
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([issuer, subject])],
      );
      const [identity] = await manager.query(
        'SELECT user_id FROM data.oidc_identity WHERE issuer = $1 AND subject = $2',
        [issuer, subject],
      );
      const repository = manager.getRepository(User);
      let user: User;
      if (identity) {
        user = await repository.findOneByOrFail({ id: identity.user_id });
        if (!user.enabled) throw new UnauthorizedException('Account disabled');
        if (user.email !== email) {
          const [collision] = await manager.query(
            'SELECT id FROM data.app_user WHERE lower(email) = $1 AND id <> $2',
            [email, user.id],
          );
          if (collision)
            throw new ForbiddenException(
              'This email belongs to another local account',
            );
          user.email = email;
        }
      } else {
        if (!email.includes('@') || email.length > 255)
          throw new UnauthorizedException('Invalid email');
        const [existing] = await manager.query(
          'SELECT id FROM data.app_user WHERE lower(email) = $1',
          [email],
        );
        if (existing)
          throw new ForbiddenException(
            'An account with this email exists; ask the administrator to link it',
          );
        user = repository.create({
          email,
          firstname: String(
            claims.given_name || claims.name || email.split('@')[0],
          ).slice(0, 30),
          lastname: String(claims.family_name || '').slice(0, 30),
          password: null,
          enabled: true,
          paymentExempted: process.env.SELF_HOSTED === 'true',
          createdAt: new Date(),
          validatedAt: new Date(),
          confirmationToken: null,
        });
        user = await repository.save(user);
        await manager.query(
          'INSERT INTO data.oidc_identity (issuer, subject, user_id) VALUES ($1, $2, $3)',
          [issuer, subject, user.id],
        );
      }
      user.lastLogin = new Date();
      return repository.save(user);
    });
  }

  async authenticate(request: Request): Promise<any> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return undefined;
    const [user] = await this.database.query(
      `SELECT u.id, u.email FROM data.oidc_session s
      JOIN data.app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.enabled = true`,
      [hash(token)],
    );
    return user ? { userId: user.id, email: user.email } : undefined;
  }

  assertOrigin(request: Request): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers.origin !== new URL(process.env.MOBILE_APP_URL).origin) {
      throw new ForbiddenException('Untrusted request origin');
    }
  }

  async logout(request: Request, response: Response): Promise<void> {
    const token = readCookie(request, SESSION_COOKIE);
    if (token)
      await this.database.query(
        'DELETE FROM data.oidc_session WHERE token_hash = $1',
        [hash(token)],
      );
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  }
}
