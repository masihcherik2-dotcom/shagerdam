import { join } from 'node:path';

/**
 * The repository keeps a single `.env` at its root, shared by docker-compose,
 * the backend and the frontend. Depending on how a process is started its
 * working directory is either `apps/backend` (pnpm/turbo/nest) or the repository
 * root, so both locations are declared. Missing files are ignored by
 * `@nestjs/config`; validation still fails when a required variable is absent.
 */
export function resolveEnvFilePaths(): string[] {
  const workspaceRoot = join(process.cwd(), '..', '..');
  return [join(workspaceRoot, '.env'), join(process.cwd(), '.env')];
}
