{
  config,
  pkgs,
  ...
}: {
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    npm.enable = true;
  };
  languages.python.enable = true; # Native Node dependency build tooling.
  packages = [pkgs.gnumake pkgs.gcc pkgs.git pkgs.jq pkgs.chromium pkgs.actionlint];
  env.CHROME_BIN = "${pkgs.chromium}/bin/chromium";

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_16;
    extensions = extensions: [extensions.postgis];
    createDatabase = false;
    listen_addresses = "127.0.0.1";
    port = 55440;
  };

  scripts.flightbook-install.exec = ''
    set -euo pipefail
    cd "${config.devenv.root}/flightbook-api"
    npm ci --no-audit --no-fund
    cd "${config.devenv.root}/flightbook-mobile-app"
    npm ci --no-audit --no-fund
  '';
  scripts.flightbook-build.exec = ''
    set -euo pipefail
    cd "${config.devenv.root}/flightbook-api"
    npm run build
    cd "${config.devenv.root}/flightbook-mobile-app"
    npm run docker
  '';
  scripts.flightbook-test-oidc.exec = ''
    set -euo pipefail
    cd "${config.devenv.root}/flightbook-api"
    test_db="flightbook_test_$(date +%s)_$$"
    createdb "$test_db"
    trap 'dropdb --if-exists "$test_db"' EXIT
    export FLIGHTBOOK_TEST_DATABASE=true
    export DATABASE_HOST="$PGHOST" DATABASE_PORT="$PGPORT"
    export DATABASE_USER="$USER" DATABASE_NAME="$test_db"
    unset DATABASE_PASSWORD
    npm run build
    node --test test/selfhost/oidc.test.cjs
  '';
  scripts.flightbook-test-web.exec = ''
    set -euo pipefail
    cd "${config.devenv.root}/flightbook-mobile-app"
    npm test -- --watch=false --browsers=ChromeHeadless --main=src/test-oidc.ts --ts-config=tsconfig.oidc-spec.json --include=src/app/shared/interceptor/auth.interceptor.oidc.spec.ts
  '';
}
