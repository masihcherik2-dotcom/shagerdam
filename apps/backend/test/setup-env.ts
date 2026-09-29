import { config as loadDotenv } from 'dotenv';

import { resolveEnvFilePaths } from '../src/config/env-file-paths';

/**
 * Jest setup file for the end-to-end suites.
 *
 * The application loads the root `.env` through `ConfigModule`; test suites that
 * talk to PostgreSQL and Redis directly (without booting Nest) need the same
 * values in `process.env`. Both call {@link resolveEnvFilePaths}, so the list of
 * environment files has exactly one definition.
 *
 * `override: false` keeps variables that CI already exported (secrets injected by
 * the pipeline take precedence over the checked-out file).
 */
// The suites assert the callback's JSON contract. A developer `.env` points the
// callback at the storefront result page (303), so the e2e run pins JSON mode
// explicitly (an empty value means "unset" to the env validation). The redirect
// query itself is covered by payments.controller.spec.ts.
process.env.PAYMENT_RESULT_REDIRECT_URL ??= '';

for (const envFilePath of resolveEnvFilePaths()) {
  loadDotenv({ path: envFilePath, override: false, quiet: true });
}
