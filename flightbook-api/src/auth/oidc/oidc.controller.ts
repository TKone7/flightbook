import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  HttpCode,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OidcService, oidcOnly } from './oidc.service';

@Controller('auth')
export class OidcController {
  constructor(private readonly oidc: OidcService) {}

  @Get('config')
  config() {
    return { oidc: oidcOnly(), selfHosted: process.env.SELF_HOSTED === 'true' };
  }

  @Get('session')
  session(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return { authenticated: oidcOnly() && !!request.user };
  }

  @Get('oidc/login')
  async login(@Res() response: Response) {
    if (!oidcOnly()) throw new NotFoundException();
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(await this.oidc.start(response));
  }

  @Get('oidc/callback')
  async callback(@Req() request: Request, @Res() response: Response) {
    if (!oidcOnly()) throw new NotFoundException();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await this.oidc.callback(request, response);
    } catch {
      // Do not expose provider responses, authorization codes or tokens.
      throw new UnauthorizedException(
        'Sign-in failed. Return to Flightbook and try again.',
      );
    }
    response.redirect(new URL('/home', process.env.MOBILE_APP_URL).href);
  }

  @Post('oidc/logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!oidcOnly()) throw new NotFoundException();
    this.oidc.assertOrigin(request);
    await this.oidc.logout(request, response);
  }
}
