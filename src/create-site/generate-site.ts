import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHECKPOINT_AUTHOR } from '../services/checkpoint.ts';
import { commitPaths } from '../services/git.ts';
import { PACKAGE_NAME } from '../upgrade/package-names.ts';

// This file's own bundled template (dist/create-site/template, copied
// there by `npm run build`'s cp step) - the agent's own asset, not
// site data, matching validation.ts's/capabilities.ts's existing
// import.meta.dirname-relative pattern for the agent's own bundled
// files (see test/static/static-analysis.test.ts's B1 allowlist).
export const TEMPLATE_ROOT = join(import.meta.dirname, 'template');

// The agent's own bundled package.json, reused for the exact version
// to pin the scaffold's dependency to - never a second hardcoded
// literal, same reasoning as capabilities.ts's readAgentVersion.
function readAgentVersion(): string {
  const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

function sanitisePackageName(dirName: string): string {
  const cleaned = dirName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'my-site';
}

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// server.js lives in vhost/, one level below the real site root - it
// states its own fixed, known relationship to its sibling directory
// rather than the agent inferring anything (constraint 2 stays intact:
// the site root is always explicit, never assumed from the agent's own
// location).
export const SERVER_JS = `import { startServer } from '${PACKAGE_NAME}';
import { join } from 'node:path';

await startServer(join(import.meta.dirname, '..'));
`;

// The scripts every site's vhost/package.json gets. The CMS owns these:
// npm run upgrade puts them back as the new version defines them.
// "start" matters beyond convenience: several PaaS platforms
// auto-detect and run `npm start` by default for a Node app
// with no other deploy config - without this, a site pushed
// straight to one of those (no Dockerfile in the loop) simply
// wouldn't boot. So "start" stays a plain start: no tunnel, no
// restarts. "dev" is dev-site (dev/dev-site.ts), the package's own
// bin: it restarts the site when theme/ changes (content is read
// fresh on every request, so it needs none) and offers the tunnel.
// "check" is check-site, likewise a bin run from vhost/ (site-check/
// cli.ts's own assumed cwd relationship).
export const SCAFFOLD_SCRIPTS: Record<string, string> = {
  start: 'node server.js',
  // npm run dev: the one command for working on a site (dev/dev-site.ts):
  // restarts on theme changes, and offers a tunnel to edit it in Minamo.
  dev: 'dev-site',
  check: 'check-site',
  // seed-media is the package's own installed CLI bin, exposed
  // as a script for exactly the same reason check is: there is
  // no package.json or node_modules at the SITE root, only here
  // in vhost/, so the obvious-looking `npx seed-media` run from
  // the site directory resolves nothing locally, goes to the
  // public registry for a package by that name and dies with
  // E404 - while still exiting 0. That is not hypothetical: it
  // is what sent a generated site's images into theme/root/
  // instead of media/. Run it from here as
  // `npm run seed-media -- .. <file>`.
  'seed-media': 'seed-media',
  // Stops the site from any terminal, not only the one it was
  // started in (stop-site, via vhost/data/server.pid).
  stop: 'stop-site',
  // Copies a running site's content and media into this one
  // (pull-site): `npm run pull`, which asks for the address and token.
  pull: 'pull-site',
  // Sends changes made here since the last pull back to that
  // live site (push-site), refusing to overwrite anything
  // edited there since, and only after typing its address.
  push: 'push-site',
  // Upgrades the CMS itself (upgrade-site): shows what's new, installs
  // it, and updates the files in vhost/ that belong to the CMS.
  upgrade: 'upgrade-site',
  // Adds an access token to this site (mint-token), the same way here and
  // on a live server: `npm run mint-token` from vhost/, restricted with
  // `-- --scopes content`. The site folder is always the one above, so
  // there's none to give, and it runs the site's own installed copy:
  // a bare `npx mint-token` fetches an unrelated package of that name.
  'mint-token': 'mint-token ..',
};

// Scripts earlier versions gave every site and this one doesn't. npm run
// upgrade removes each, but only while it's still exactly as the CMS
// left it: a developer's own edit to one is theirs to keep.
export const RETIRED_SCRIPTS: Record<string, string> = {
  // Until 0.15.0: npm run dev now asks whether to open the tunnel.
  tunnel: 'node server.js --tunnel',
};

export class ScaffoldError extends Error {}

// A standalone, one-shot CLI operation - no running server exists yet
// for enqueue()'s serialisation to matter, and this whole function
// runs synchronously start to finish, so there's no concurrent-write
// hazard to guard against.
export interface ScaffoldOptions {
  // The site's local port. create-site picks a free one at random (see
  // services/free-port.ts) so several sites can run side by side; 3000,
  // the server's own default, when not given.
  port?: number;
}

export function scaffoldSite(targetDir: string, options: ScaffoldOptions = {}): { raw: string } {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new ScaffoldError(`"${targetDir}" already exists and is not empty`);
  }
  mkdirSync(targetDir, { recursive: true });

  // The static theme/content template, copied verbatim except its own
  // "gitignore"/"dockerignore" (no leading dot - a literal .gitignore
  // or .dockerignore inside the template tree would be silently
  // dropped by npm pack's own packlist logic, verified empirically
  // before this was written).
  cpSync(TEMPLATE_ROOT, targetDir, {
    recursive: true,
    filter: (source) => !['gitignore', 'dockerignore', 'railwayignore'].includes(basename(source)),
  });
  cpSync(join(TEMPLATE_ROOT, 'gitignore'), join(targetDir, '.gitignore'));
  cpSync(join(TEMPLATE_ROOT, 'dockerignore'), join(targetDir, '.dockerignore'));
  cpSync(join(TEMPLATE_ROOT, 'railwayignore'), join(targetDir, '.railwayignore'));

  // content/drafts/ starts empty - not part of the static template
  // (nothing to copy), created directly so a fresh site has somewhere
  // to write its first draft immediately. Nested inside content/, not
  // a sibling of it - see config.ts's own comment for why.
  mkdirSync(join(targetDir, 'content', 'drafts'), { recursive: true });

  // media/ also starts empty, also created directly (no template
  // content to copy - see config.ts's own comment for why this is a
  // sibling of content/theme/vhost, not nested under content/). Not
  // passed to commitPaths below: media is never git-tracked
  // (constraint 2), even at scaffold time - an empty directory has
  // nothing to commit anyway (git doesn't track empty directories), so
  // this omission is a non-issue mechanically, but it's deliberate,
  // not an oversight, should anyone go looking for why it's absent
  // from that list.
  mkdirSync(join(targetDir, 'media'), { recursive: true });

  // vhost/: the site's own serving configuration (package.json,
  // server.js, site.config.json), matching a real vhost's own scope in
  // hosting terms - never a sibling of content/theme.
  const vhostDir = join(targetDir, 'vhost');
  mkdirSync(vhostDir, { recursive: true });

  // A zero-token site fails closed on every write route (401) - not
  // usable for editing at all. Generated fresh per scaffold, printed
  // once, never written to disk - matches every other write-capable
  // identity in this codebase never depending on a value the operator
  // could lose or that leaks into version control.
  const token = generateToken();
  writeFileSync(
    join(vhostDir, 'site.config.json'),
    JSON.stringify(
      {
        // Written explicitly rather than left absent - a real value
        // here is a visible, editable config knob; an absent key is
        // invisible until something else is already using the
        // default port. Only the local port: the Docker image sets
        // PORT=3000 itself, and hosts like Railway set their own.
        port: options.port ?? 3000,
        tokens: [{ hash: token.hash, scopes: ['content', 'theme', 'media'] }],
      },
      null,
      2,
    ),
  );

  const packageName = sanitisePackageName(basename(targetDir));
  writeFileSync(
    join(vhostDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: SCAFFOLD_SCRIPTS,
        dependencies: {
          // Pinned exact, never a ^range - at v0.x even a minor bump
          // can be breaking (build plan's own word is "pinned").
          [PACKAGE_NAME]: readAgentVersion(),
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(join(vhostDir, 'server.js'), SERVER_JS);

  // runStartupChecks hard-fails not-a-git-repo otherwise - a scaffold
  // without a real git repo cannot boot at all.
  execFileSync('git', ['init', '--quiet'], { cwd: targetDir });
  commitPaths(
    targetDir,
    ['theme', 'content', 'vhost', 'AGENTS.md', '.gitignore', '.dockerignore', '.railwayignore'],
    'chore: initial scaffold',
    CHECKPOINT_AUTHOR,
  );

  return { raw: token.raw };
}
