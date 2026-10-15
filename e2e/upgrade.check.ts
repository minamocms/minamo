import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_IDENTITY_ENV } from '../test/helpers/tmp-site.ts';

// npm run upgrade, for real: two real packed versions of this package -
// the current build, and a "next version" made from it with a changed
// Dockerfile and its own changelog entry - served by a stand-in npm
// registry on localhost. A site is scaffolded on the current version,
// then upgraded with the real npm view / pack / install, including the
// hand-over to the newly installed version's own --finish step. Then a
// site on the last @o-a/cms-agent release (packed from its git tag)
// upgrades the same way, and lands on @minamocms/framework.

const repoRoot = join(import.meta.dirname, '..');
const run = promisify(execFile);
const MARKER = 'upgrade-check-marker';
const PACKAGE = '@minamocms/framework';
// The last release under the package's old name.
const LEGACY = { name: '@o-a/cms-agent', version: '0.9.3', tag: 'v0.9.3' };

function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
}

function pack(dir: string, destination: string): string {
  const [result] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { cwd: dir }).toString('utf-8'),
  ) as Array<{ filename: string }>;
  return join(destination, result?.filename as string);
}

function manifestFor(tarball: string, url: string): Record<string, unknown> {
  const scratch = mkdtempSync(join(tmpdir(), 'cms-upgrade-manifest-'));
  execFileSync('tar', ['-xzf', tarball, '-C', scratch, 'package/package.json']);
  const pkg = JSON.parse(readFileSync(join(scratch, 'package', 'package.json'), 'utf-8')) as Record<string, unknown>;
  rmSync(scratch, { recursive: true, force: true });
  const bytes = readFileSync(tarball);
  return {
    ...pkg,
    dist: {
      tarball: url,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  };
}

// The last @o-a/cms-agent release, built from its own tagged source.
function packLegacy(scratch: string, destination: string): string {
  const source = join(scratch, 'legacy');
  mkdirSync(source);
  execFileSync('sh', ['-c', `git archive ${LEGACY.tag} | tar -x -C "${source}"`], { cwd: repoRoot });
  symlinkSync(join(repoRoot, 'node_modules'), join(source, 'node_modules'));
  const [result] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: source, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8'),
  ) as Array<{ filename: string }>;
  return join(destination, result?.filename as string);
}

function dependencies(vhost: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(vhost, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> }).dependencies;
}

function installedVersion(vhost: string, name: string): string {
  return (JSON.parse(readFileSync(join(vhost, 'node_modules', ...name.split('/'), 'package.json'), 'utf-8')) as { version: string }).version;
}

test('npm run upgrade: shows the changelog, installs the next version, and that version puts back its own files', async (t) => {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
  const scratch = mkdtempSync(join(tmpdir(), 'minamo-upgrade-check-'));
  let server: Server | undefined;
  try {
    // --- Two versions, and the last one under the old name ---
    const current = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
    const next = bumpPatch(current);
    const tarballs = join(scratch, 'tarballs');
    mkdirSync(tarballs);
    const currentTarball = pack(repoRoot, tarballs);

    const nextDir = join(scratch, 'next');
    mkdirSync(nextDir);
    execFileSync('tar', ['-xzf', currentTarball, '-C', nextDir]);
    const nextPackage = join(nextDir, 'package');
    const nextPkgPath = join(nextPackage, 'package.json');
    const nextPkg = JSON.parse(readFileSync(nextPkgPath, 'utf-8')) as { version: string };
    nextPkg.version = next;
    writeFileSync(nextPkgPath, JSON.stringify(nextPkg, null, 2));
    const dockerfile = join(nextPackage, 'dist', 'create-site', 'template', 'vhost', 'Dockerfile');
    writeFileSync(dockerfile, `${readFileSync(dockerfile, 'utf-8')}\n# ${MARKER}\n`);
    const changelogPath = join(nextPackage, 'CHANGELOG.md');
    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, 'utf-8').replace('# Changelog', `# Changelog\n\n## [${next}] - test\n\n- ${MARKER} in the changelog.\n`),
    );
    const nextTarball = pack(nextPackage, tarballs);
    const legacyTarball = packLegacy(scratch, tarballs);

    // --- A stand-in npm registry ---
    // It answers for @minamocms/framework and @o-a/cms-agent, and passes
    // every other request through to the real registry.
    const packages: Record<string, { latest: string; versions: Record<string, string> }> = {
      [PACKAGE]: { latest: next, versions: { [current]: currentTarball, [next]: nextTarball } },
      [LEGACY.name]: { latest: LEGACY.version, versions: { [LEGACY.version]: legacyTarball } },
    };
    server = createServer((request, response) => {
      const url = decodeURIComponent(request.url ?? '');
      const address = server?.address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      if (url.startsWith('/tarballs/')) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(readFileSync(join(tarballs, url.slice('/tarballs/'.length))));
        return;
      }
      const name = url.slice(1).split('?')[0] as string;
      const known = packages[name];
      if (known) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            name,
            'dist-tags': { latest: known.latest },
            versions: Object.fromEntries(
              Object.entries(known.versions).map(([version, file]) => [version, manifestFor(file, `${base}/tarballs/${basename(file)}`)]),
            ),
          }),
        );
        return;
      }
      fetch(`https://registry.npmjs.org${request.url ?? ''}`, { headers: { accept: request.headers.accept ?? 'application/json' } })
        .then(async (upstream) => {
          response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
          response.end(Buffer.from(await upstream.arrayBuffer()));
        })
        .catch(() => {
          response.writeHead(502);
          response.end();
        });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    // A private cache keeps the stand-in's versions out of the real one.
    const env = {
      ...process.env,
      npm_config_registry: `http://127.0.0.1:${port}/`,
      npm_config_cache: join(scratch, 'npm-cache'),
    };

    // --- A site on the current version ---
    const site = join(scratch, 'site');
    const vhost = join(site, 'vhost');
    // Every npm call that reaches the stand-in registry is asynchronous:
    // the registry runs in this process, and a synchronous call would
    // block it from answering the very request npm is waiting on.
    await t.test('scaffold a site and install the current version from the stand-in registry', async () => {
      execFileSync('node', [join(repoRoot, 'dist', 'create-site', 'cli.js'), site], { stdio: 'ignore' });
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhost, env });
      assert.equal(installedVersion(vhost, PACKAGE), current);
    });

    const commitsBefore = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: site }).toString().trim();

    await t.test('answering no changes nothing', async () => {
      const child = execFile('npm', ['run', 'upgrade', '--silent'], { cwd: vhost, env });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stdin?.end('n\n');
      await new Promise((resolve) => child.on('exit', resolve));
      assert.match(stdout, new RegExp(`Upgrading the CMS from ${current.replace(/\./g, '\\.')} to ${next.replace(/\./g, '\\.')}`));
      assert.match(stdout, new RegExp(`${MARKER} in the changelog`), 'the new version\'s changelog is shown before asking');
      assert.match(stdout, /Cancelled\. Nothing was changed\./);
      assert.equal(dependencies(vhost)[PACKAGE], current);
    });

    await t.test('upgrading installs the next version, which puts back its own files, and commits nothing', async () => {
      const { stdout } = await run('npm', ['run', 'upgrade', '--silent', '--', '--yes'], { cwd: vhost, env });
      assert.match(stdout, new RegExp(`The CMS here is now ${next.replace(/\./g, '\\.')}`));
      assert.match(stdout, /updated\s+vhost\/Dockerfile/);
      assert.equal(dependencies(vhost)[PACKAGE], next);
      assert.equal(installedVersion(vhost, PACKAGE), next);
      assert.match(readFileSync(join(vhost, 'Dockerfile'), 'utf-8'), new RegExp(MARKER), 'the new version\'s Dockerfile is in place');
      assert.ok(existsSync(join(vhost, 'server.js')));
      assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: site }).toString().trim(), commitsBefore, 'nothing committed');
    });

    await t.test('running it again finds nothing to do', async () => {
      const { stdout } = await run('npm', ['run', 'upgrade', '--silent', '--', '--yes', '--force'], { cwd: vhost, env });
      assert.match(stdout, new RegExp(`Already on ${next.replace(/\./g, '\\.')}, the latest`));
    });

    // --- A site on the last @o-a/cms-agent release ---
    // Shaped as that release scaffolded it: its dependency and its
    // server.js name the old package.
    const legacySite = join(scratch, 'legacy-site');
    const legacyVhost = join(legacySite, 'vhost');
    await t.test(`a site on ${LEGACY.name} ${LEGACY.version} upgrades onto ${PACKAGE}`, async () => {
      execFileSync('node', [join(repoRoot, 'dist', 'create-site', 'cli.js'), legacySite], { stdio: 'ignore' });
      const pkgPath = join(legacyVhost, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies: Record<string, string> };
      pkg.dependencies = { [LEGACY.name]: LEGACY.version };
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      const serverJs = join(legacyVhost, 'server.js');
      writeFileSync(serverJs, readFileSync(serverJs, 'utf-8').replace(`from '${PACKAGE}'`, `from '${LEGACY.name}'`));
      execFileSync('git', ['commit', '--quiet', '-am', 'as the last @o-a/cms-agent release made it'], { cwd: legacySite, env: { ...process.env, ...TEST_IDENTITY_ENV } });
      await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: legacyVhost, env });
      assert.equal(installedVersion(legacyVhost, LEGACY.name), LEGACY.version);

      const { stdout } = await run('npm', ['run', 'upgrade', '--silent', '--', '--yes'], { cwd: legacyVhost, env });
      assert.match(stdout, /The CMS is now called Minamo/);
      assert.match(stdout, new RegExp(`The CMS here is now ${next.replace(/\./g, '\\.')}`));
      assert.deepEqual(dependencies(legacyVhost), { [PACKAGE]: next }, 'the dependency moved over, the old name gone');
      assert.equal(installedVersion(legacyVhost, PACKAGE), next);
      assert.ok(!existsSync(join(legacyVhost, 'node_modules', '@o-a', 'cms-agent')), 'the old package is uninstalled');
      assert.match(readFileSync(serverJs, 'utf-8'), new RegExp(`from '${PACKAGE}'`), 'server.js imports the new name');
      // And the site starts: server.js's import resolves.
      await run('node', ['--input-type=module', '-e', `await import('${PACKAGE}')`], { cwd: legacyVhost });
    });
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
