import { randomBytes } from 'crypto';
import { oidcOnly } from '../oidc/oidc.service';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || (oidcOnly() ? randomBytes(32).toString('hex') : undefined),
    });
  }

  async validate(payload: any) {
    return { userId: payload.sub, email: payload.email };
  }
}