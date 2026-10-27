import { MigrationInterface, QueryRunner } from 'typeorm';

export class OidcSessions1793109000000 implements MigrationInterface {
  name = 'OidcSessions1793109000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "data"."oidc_identity" (
      issuer text NOT NULL, subject text NOT NULL,
      user_id integer NOT NULL REFERENCES "data"."app_user"(id) ON DELETE CASCADE,
      PRIMARY KEY (issuer, subject))`);
    await queryRunner.query(`CREATE TABLE "data"."oidc_session" (
      token_hash char(64) PRIMARY KEY,
      user_id integer NOT NULL REFERENCES "data"."app_user"(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL)`);
    await queryRunner.query(
      `CREATE INDEX oidc_session_expiry ON "data"."oidc_session" (expires_at)`,
    );
    await queryRunner.query(`CREATE TABLE "data"."oidc_login" (
      state_hash char(64) PRIMARY KEY, cookie_hash char(64) NOT NULL,
      verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL)`);
    await queryRunner.query(
      `CREATE INDEX oidc_login_expiry ON "data"."oidc_login" (expires_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "data"."oidc_login"`);
    await queryRunner.query(`DROP TABLE "data"."oidc_session"`);
    await queryRunner.query(`DROP TABLE "data"."oidc_identity"`);
  }
}
