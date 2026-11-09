import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// After an upgrade installs the new CMS, its own dependencies (fastify
// and the rest) can still be on older locked versions with known
// security problems: npm keeps a locked version for as long as it still
// fits, so a site's package-lock.json only ever moves when something
// makes it. This makes it, for security fixes only:
// `npm audit fix --omit=dev`, which changes only packages with an
// advisory, and only within the versions already allowed (never
// --force, never a major version).
//
// Never a reason the upgrade fails: npm audit fix exits non-zero
// whenever anything is left it can't fix, and the upgrade itself is
// already done by then.
export type SecurityFixOutcome = 'updated' | 'unchanged';

export function applySecurityFixes(
  vhostDir: string,
  run: (args: string[]) => void = (args) => {
    execFileSync('npm', args, { cwd: vhostDir, stdio: ['ignore', 'pipe', 'pipe'] });
  },
): SecurityFixOutcome {
  const lockPath = join(vhostDir, 'package-lock.json');
  const before = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : null;
  try {
    run(['audit', 'fix', '--omit=dev', '--no-fund']);
  } catch {
    // Reported by the lockfile below, whichever way it went.
  }
  const after = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : null;
  return before !== after ? 'updated' : 'unchanged';
}
