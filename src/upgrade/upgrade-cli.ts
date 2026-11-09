#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ask, parseSyncArgs } from '../site-sync/cli-helpers.ts';
import { changesBetween, compareVersions, mayBreak } from './changelog.ts';
import { finishUpgrade } from './finish.ts';
import { PACKAGE_NAME, upgradedDependencies } from './package-names.ts';
import { out } from '../terminal/ui.ts';
import { applySecurityFixes } from './security-fixes.ts';

const ui = out();

// npm run upgrade [-- <version>] [--yes] [--force]
//
// In two halves. This version (the one installed now) picks the new
// version, shows what's new, asks, and installs it. Then it hands over
// to the NEW version's own copy of this command (--finish), which puts
// back the CMS's own files, updates content to the new format, and
// checks the site: only the new version knows what it changed.
// Nothing is committed, and the live site is not touched - npm run
// push offers the upgrade once it has been tested here.

const args = parseSyncArgs(process.argv.slice(2));
const vhostDir = process.cwd();
const siteRoot = resolve(vhostDir, '..');

function fail(message: string, ...more: string[]): never {
  ui.error(message, ...more);
  process.exit(1);
}

function installedVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(vhostDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'), 'utf-8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return fail("The CMS isn't installed here.", `Run ${ui.command('npm run upgrade')} from your site's vhost/ folder, after ${ui.command('npm install')}.`);
  }
}

function npm(npmArgs: string[], cwd = vhostDir): string {
  return execFileSync('npm', npmArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
}

// The CHANGELOG.md inside the version about to be installed, fetched
// the same way npm install will fetch it - so it's the real thing, from
// the same registry.
function changelogOf(name: string, version: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'cms-upgrade-'));
  try {
    const packed = JSON.parse(npm(['pack', `${name}@${version}`, '--pack-destination', scratch, '--json'], scratch)) as Array<{
      filename: string;
    }>;
    const tarball = join(scratch, packed[0]?.filename as string);
    execFileSync('tar', ['-xzf', tarball, '-C', scratch, 'package/CHANGELOG.md'], { stdio: 'ignore' });
    return readFileSync(join(scratch, 'package', 'CHANGELOG.md'), 'utf-8');
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function hasUncommittedChanges(): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'vhost', 'content', 'theme'], {
      cwd: siteRoot,
    });
    return status.toString('utf-8').trim() !== '';
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  const from = installedVersion();
  ui.header('minamo upgrade', `framework ${from}`);

  let latest: string;
  let versions: string[];
  const asking = ui.spinner('Checking for new versions');
  try {
    const info = JSON.parse(npm(['view', PACKAGE_NAME, 'versions', 'dist-tags', '--json'])) as {
      versions: string[] | string;
      'dist-tags': { latest: string };
    };
    versions = Array.isArray(info.versions) ? info.versions : [info.versions];
    latest = info['dist-tags'].latest;
  } catch {
    asking.stop();
    return fail(`Couldn't ask npm which versions of ${PACKAGE_NAME} exist.`, 'Check your internet connection and try again.');
  }
  asking.stop();

  const to = args.positional[0] ?? latest;
  if (!versions.includes(to)) {
    fail(`${PACKAGE_NAME} has no version ${to}. The latest is ${latest}.`);
  }
  if (compareVersions(to, from) === 0) {
    ui.success(`Already on ${from}${to === latest ? ', the latest' : ''}. Nothing to upgrade.`);
    return;
  }
  if (compareVersions(to, from) < 0) {
    fail(`${to} is older than the ${from} installed here.`, `${ui.command('npm run upgrade')} only goes forward.`);
  }
  if (!args.flags.has('--force') && hasUncommittedChanges()) {
    fail(
      'vhost/, content/ or theme/ has uncommitted changes.',
      "Commit them first, so the upgrade's own changes are easy to review (or pass --force).",
    );
  }

  ui.heading(`Upgrading the CMS from ${from} to ${to}.`);
  ui.blank();
  const reading = ui.spinner(`Reading what's new in ${to}`);
  const changelog = changelogOf(PACKAGE_NAME, to);
  reading.stop();
  if (changelog) {
    for (const section of changesBetween(changelog, from, to)) {
      ui.line(ui.fancy ? ` ${ui.style(` ${section.version} `, 'bold', 'cyan')}` : `--- ${section.version} ---`);
      ui.line(ui.fancy ? section.text.replace(/^/gm, ' ') : section.text);
      ui.blank();
    }
  } else {
    ui.warn(`Couldn't read the changelog for ${to}.`);
    ui.blank();
  }
  if (mayBreak(from, to)) {
    ui.warn(`Note: ${from} to ${to} is a bigger step, which can include breaking changes.`, 'Read the notes above before going ahead.');
    ui.blank();
  }

  if (!args.flags.has('--yes')) {
    const answer = (await ask(`${ui.fancy ? ` ${ui.style('?', 'cyan', 'bold')} ` : ''}Upgrade from ${from} to ${to}? (y/N) `)).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      ui.info('Cancelled. Nothing was changed.');
      return;
    }
  }

  const packagePath = join(vhostDir, 'package.json');
  const lockPath = join(vhostDir, 'package-lock.json');
  const packageBefore = readFileSync(packagePath, 'utf-8');
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, 'utf-8') : null;
  const pkg = JSON.parse(packageBefore) as { dependencies?: Record<string, string> };
  pkg.dependencies = upgradedDependencies(pkg.dependencies, to);
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const installing = ui.spinner(`Installing ${PACKAGE_NAME}@${to}`);
  try {
    // npm's own output only if it fails: it explains why.
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vhostDir, stdio: ['ignore', 'pipe', 'pipe'] });
    installing.succeed(`Installed ${PACKAGE_NAME}@${to}`);
    const securing = ui.spinner("Applying security fixes to the CMS's dependencies");
    const secured = applySecurityFixes(vhostDir);
    if (secured === 'updated') {
      securing.succeed("Applied security fixes to the CMS's dependencies");
    } else {
      securing.succeed('No security fixes needed');
    }
  } catch (error) {
    installing.stop();
    const output = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    if (output.trim()) {
      ui.line(output.trimEnd());
    }
    writeFileSync(packagePath, packageBefore);
    if (lockBefore !== null) {
      writeFileSync(lockPath, lockBefore);
    }
    fail(
      `Installing ${to} failed.`,
      'package.json and package-lock.json are back as they were.',
      `Run ${ui.command('npm install')} to restore ${from}.`,
    );
  }

  // Hand over to the version just installed.
  const next = join(vhostDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'upgrade', 'upgrade-cli.js');
  if (!existsSync(next)) {
    fail(`${to} is installed, but has no upgrade step of its own to finish with.`);
  }
  ui.blank();
  const finished = spawnSync(process.execPath, [next, '--finish'], { cwd: vhostDir, stdio: 'inherit' });
  process.exit(finished.status ?? 1);
}

async function finish(): Promise<void> {
  const version = installedVersion();
  const finishing = ui.spinner(`Finishing the upgrade to ${version}`);
  const result = await finishUpgrade(siteRoot).finally(() => finishing.stop());

  const changed = result.files.filter((file) => file.status !== 'unchanged');
  if (changed.length > 0) {
    ui.success("Updated the CMS's own files:");
    ui.changes(
      changed.map((file) => ({
        action: file.status,
        tone: file.status === 'created' ? 'add' : 'change',
        target: file.path,
      })),
    );
  }
  if (result.migrated.length > 0) {
    ui.success(`Updated ${result.migrated.length} content file${result.migrated.length === 1 ? '' : 's'} to the new content format.`);
  }
  if (result.migrationProblem) {
    ui.error(
      "Content couldn't be updated to the new format, so none of it was changed:",
      result.migrationProblem,
      `Fix that file, then run ${ui.command('npm run upgrade -- --finish')} again.`,
    );
  }
  if (result.check.ok) {
    ui.success('Site check: no problems found.');
  } else {
    // Reported, but not a failed upgrade: the check covers the whole
    // site, so these can be problems it already had.
    const count = result.check.findings.length;
    ui.warn(
      `Site check: ${count} problem${count === 1 ? '' : 's'} (some may be from before the upgrade).`,
      `Run ${ui.command('npm run check')} to see them.`,
    );
  }
  ui.blank();
  ui.box(`The CMS here is now ${version}`, [
    "Nothing was committed, and the live site hasn't changed.",
    `Test it with ${ui.command('npm run dev')}, review with ${ui.command('git diff')}, then put it live with ${ui.command('npm run push')}.`,
  ]);
  if (result.migrationProblem) {
    process.exit(1);
  }
}

await (args.flags.has('--finish') ? finish() : start());
