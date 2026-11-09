#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, chooseParts, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { readAgentVersion } from '../routes/capabilities.ts';
import { compareVersions } from '../upgrade/changelog.ts';
import { deployedVersionProblem, describeDeployMethod, detectDeployMethod, runDeploy, waitForLiveVersion } from './deploy.ts';
import { executePush, preparePush, type PushPlan } from './push-site.ts';
import type { ThemePlan } from './theme-sync.ts';
import { SiteSyncError } from './remote-site.ts';
import { readSyncRecord } from './sync-record.ts';
import { err, out } from '../terminal/ui.ts';

// Progress, questions and problems on stderr; the result on stdout.
const ui = err();
const result = out();

const args = parseSyncArgs(process.argv.slice(2));
const dryRun = args.flags.has('--dry-run');

// Run from vhost/ (the scaffold's own "push" script), so the site root
// is one level up - the same relationship check-site relies on.
const config = loadSiteConfig(resolve(process.cwd(), '..'));

function fail(message: string, ...more: string[]): never {
  ui.error(message, ...more);
  process.exit(1);
}

// Push only ever goes back to the site this copy was pulled from, so
// with no address given, that's the one. A copy that has never pulled
// asks, as pull does.
const record = readSyncRecord(config);
const given = args.positional[0] ?? record?.siteUrl ?? (await ask('Live site address: '));
const siteUrl = normaliseSiteUrl(given);
if (!siteUrl) {
  fail(given.trim() === '' ? 'No address entered.' : `"${given}" is not a web address.`);
}

type Change = { action: string; tone: 'add' | 'change' | 'remove'; target: string };

function contentPlanChanges(plan: PushPlan): Change[] {
  const labels = {
    create: ['new page', 'add'],
    update: ['update', 'change'],
    delete: ['DELETE', 'remove'],
  } as const;
  const changes: Change[] = plan.changes.map((change) => ({
    action: labels[change.action][0],
    tone: labels[change.action][1],
    target: `content/${change.path}`,
  }));
  for (const operation of plan.redirectOperations) {
    const { from, to } = operation.entry;
    const [action, tone] = (
      { POST: ['add redirect', 'add'], PUT: ['change redirect', 'change'], DELETE: ['REMOVE redirect', 'remove'] } as const
    )[operation.method];
    changes.push({ action, tone, target: `${from}${operation.method === 'DELETE' ? '' : ` -> ${to}`}` });
  }
  for (const name of plan.mediaToUpload) {
    changes.push({ action: 'upload', tone: 'add', target: `media/${name}` });
  }
  if (plan.settings) {
    changes.push({ action: 'update', tone: 'change', target: 'content/settings.json (site settings)' });
  }
  return changes;
}

function themePlanChanges(plan: ThemePlan): Change[] {
  const labels = {
    create: ['new file', 'add'],
    update: ['update', 'change'],
    delete: ['DELETE', 'remove'],
  } as const;
  return plan.changes.map((change) => ({
    action: labels[change.action][0],
    tone: labels[change.action][1],
    target: `theme/${change.path}`,
  }));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function contentCount(plan: PushPlan): number {
  return plan.changes.length + plan.redirectOperations.length + plan.mediaToUpload.length + (plan.settings ? 1 : 0);
}

function conflictLines(conflicts: Array<{ path: string; reason: string }>, folder: string): string[] {
  return conflicts.map((conflict) => {
    const path = conflict.path === 'redirects.json' ? 'content/redirects.json' : `${folder}/${conflict.path}`;
    return `${path}: ${conflict.reason}`;
  });
}

// Narrowed once here, for the functions below.
const liveUrl: string = siteUrl;
const host = new URL(liveUrl).host;

async function confirmByAddress(): Promise<void> {
  const typed = await ask(` Type ${ui.style(host, 'bold')} to go ahead, or anything else to cancel: `.slice(ui.fancy ? 0 : 1));
  if (typed.trim().toLowerCase() !== host.toLowerCase()) {
    fail('Cancelled. Nothing was pushed.');
  }
}

// Step 1 when chosen: put the CMS here onto the live site by deploying,
// and wait until the live site says it is running it. Content and theme
// are only sent once it has, so they arrive on a CMS that understands
// them - and nothing else is sent if it doesn't.
async function upgradeLiveCms(liveVersion: string, localVersion: string): Promise<void> {
  const method = detectDeployMethod(config.siteRoot);
  ui.blank();
  ui.heading(`Step 1: upgrade the live site's CMS from ${liveVersion} to ${localVersion}, using ${describeDeployMethod(method)}.`);
  ui.list(['The live site restarts, and is unavailable for a moment.', 'Its content and theme are not touched by the upgrade.']);
  if (dryRun) {
    return;
  }
  ui.blank();
  await confirmByAddress();

  if (method.kind === 'manual') {
    ui.blank();
    ui.info(
      'Deploy the site now, the way you usually deploy to your host.',
      'To have push do it for you next time, put the command in vhost/deploy.json, for example { "command": "git push" }.',
    );
    await ask('Press Enter once the deploy has started: ');
  } else if (!runDeploy(method, config.siteRoot)) {
    fail('The deploy failed, so nothing else was pushed. Its output is above.');
  }

  const waiting = ui.spinner(`Waiting for the live site to come back on ${localVersion}`);
  let lastReported: string | null | undefined;
  const outcome = await waitForLiveVersion(liveUrl, localVersion, {
    onPoll: (seen) => {
      if (seen !== lastReported) {
        waiting.update(
          `Waiting for the live site to come back on ${localVersion} (${seen === null ? 'restarting, not answering yet' : `live site on ${seen}`})`,
        );
        lastReported = seen;
      }
    },
  });
  if (!outcome.ok) {
    waiting.stop();
    fail(`Stopped without pushing anything else: ${outcome.reason}.`, 'Check the deploy on your host.');
  }
  waiting.succeed(`The live site is now on ${localVersion}.`);
}

try {
  ui.header('minamo push', siteUrl);
  const token = await resolveToken(args, siteUrl);
  const prepare = async (message: string) => {
    const comparing = ui.spinner(message);
    try {
      const done = await preparePush(config, {
        siteUrl,
        token,
        onWait: (seconds) => comparing.update(`${message} (the live site asked to slow down; waiting ${seconds}s)`),
      });
      comparing.succeed(`Compared with ${siteUrl}`);
      return done;
    } catch (error) {
      comparing.stop();
      throw error;
    }
  };
  let prepared = await prepare(`Comparing this copy with ${siteUrl}`);

  const localVersion = readAgentVersion();
  const versionOrder = compareVersions(localVersion, prepared.liveVersion);
  if (versionOrder < 0) {
    ui.warn(
      `Note: the live site runs a newer CMS (${prepared.liveVersion}) than this copy (${localVersion}).`,
      `Run ${ui.command('npm run upgrade')} here to match it.`,
    );
  }

  const describe = () => {
    const content = prepared.content.ready ? prepared.content.value : null;
    const theme = prepared.theme.ready ? prepared.theme.value : null;
    return { content, theme, contentChanges: content ? contentCount(content.plan) : 0, themeChanges: theme ? theme.plan.changes.length : 0 };
  };
  const first = describe();
  const firstPush = (first.content?.firstPush ?? false) || (first.theme?.firstPush ?? false);
  if (firstPush) {
    ui.blank();
    ui.box(
      `First push from this copy to ${siteUrl}`,
      [
        "Until this copy has pulled from the live site, push can't tell your changes apart from changes made on the live site, so it lists everything that differs. Check the list carefully.",
        'Nothing is deleted from the live site on a first push.',
      ],
      'warn',
    );
  }
  const parts = await chooseParts(args, 'push', {
    content: first.content
      ? {
          available: true,
          detail: first.content.plan.conflicts.length > 0 ? plural(first.content.plan.conflicts.length, 'conflict') : first.contentChanges > 0 ? plural(first.contentChanges, 'change') : 'no changes',
          checked: first.contentChanges > 0 || first.content.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.content as { reason: string }).reason, checked: false },
    theme: first.theme
      ? {
          available: true,
          detail: first.theme.plan.conflicts.length > 0 ? plural(first.theme.plan.conflicts.length, 'conflict') : first.themeChanges > 0 ? `${plural(first.themeChanges, 'file')} changed` : 'no changes',
          checked: first.themeChanges > 0 || first.theme.plan.conflicts.length > 0,
        }
      : { available: false, detail: (prepared.theme as { reason: string }).reason, checked: false },
    cms:
      versionOrder > 0
        ? { available: true, detail: `live site: ${prepared.liveVersion}, here: ${localVersion}`, checked: true }
        : { available: false, detail: `the live site already runs ${prepared.liveVersion}`, checked: false },
  });
  if (!parts.content && !parts.theme && !parts.cms) {
    result.info('Nothing chosen. Nothing was pushed.');
    process.exit(0);
  }
  if ((parts.content || parts.theme) && prepared.liveSchemaOlder && !parts.cms) {
    fail(
      `The live site's CMS (${prepared.liveVersion}) uses an older content format than this copy's (${localVersion}), and could reject what it's sent.`,
      `Push the CMS upgrade with it (${ui.command('npm run push')}, and tick CMS upgrade).`,
    );
  }

  if (parts.cms) {
    const versionProblem = deployedVersionProblem(config.siteRoot, localVersion);
    if (versionProblem !== null) {
      fail(`Can't push the CMS upgrade, so nothing was pushed: ${versionProblem}`);
    }
    await upgradeLiveCms(prepared.liveVersion, localVersion);
    if (!parts.content && !parts.theme) {
      result.blank();
      if (dryRun) {
        result.info('Dry run: nothing was pushed.');
      } else {
        result.success(`Pushed to ${siteUrl}: the CMS upgrade to ${localVersion}.`);
      }
      process.exit(0);
    }
    if (dryRun) {
      result.blank();
      result.info('Dry run: nothing was pushed.', 'What content and theme would change is worked out once the upgrade is live.');
      process.exit(0);
    }
    // Planned again against the upgraded site: what it reports can have
    // changed with it (a theme it could not report before, for one).
    ui.blank();
    ui.heading('Step 2: your content and theme changes.');
    prepared = await prepare('Comparing again with the upgraded site');
  }

  const { content, theme, contentChanges, themeChanges } = describe();
  const pushContent = parts.content && content !== null;
  const pushTheme = parts.theme && theme !== null;
  if (parts.theme && theme === null) {
    ui.warn(`The theme can't be pushed: ${(prepared.theme as { reason: string }).reason}.`);
  }
  if (!pushContent && !pushTheme) {
    process.exit(parts.cms ? 0 : 1);
  }

  const contentConflicts = pushContent ? content.plan.conflicts : [];
  const themeConflicts = pushTheme ? theme.plan.conflicts : [];
  const mediaMissing = pushContent ? content.plan.mediaMissing : [];
  if (contentConflicts.length > 0 || themeConflicts.length > 0 || mediaMissing.length > 0) {
    ui.blank();
    ui.error('Nothing more was pushed.');
    if (contentConflicts.length > 0 || themeConflicts.length > 0) {
      ui.blank();
      ui.line(ui.fancy ? ' These were changed on the live site since your last pull, and pushing would overwrite that work:' : 'These were changed on the live site since your last pull, and pushing would overwrite that work:');
      ui.list([...conflictLines(themeConflicts, 'theme'), ...conflictLines(contentConflicts, 'content')]);
      ui.blank();
      ui.info(
        `To keep both: commit your work here, run ${ui.command('npm run pull')} to bring in the live changes, reapply yours on top, then push again.`,
      );
    }
    if (mediaMissing.length > 0) {
      ui.blank();
      ui.line(ui.fancy ? ' These images are used by pages being pushed, but are missing here and on the live site:' : 'These images are used by pages being pushed, but are missing here and on the live site:');
      ui.list(mediaMissing.map((name) => `media/${name}`));
    }
    process.exit(1);
  }

  const total = (pushContent ? contentChanges : 0) + (pushTheme ? themeChanges : 0);
  if (total === 0) {
    result.success('Nothing to push: the live site already has everything changed here since your last pull.');
    process.exit(0);
  }

  ui.blank();
  ui.heading(`This will change the LIVE site at ${siteUrl}:`);
  ui.blank();
  ui.changes([...(pushTheme ? themePlanChanges(theme.plan) : []), ...(pushContent ? contentPlanChanges(content.plan) : [])]);
  if (dryRun) {
    result.blank();
    result.info('Dry run: nothing was pushed.');
    process.exit(0);
  }

  const deletes = pushContent ? content.plan.changes.filter((change) => change.action === 'delete').length : 0;
  const warnings: string[] = [];
  if (pushTheme) {
    warnings.push('The theme files listed replace the live ones, and every page shows the new theme at once.');
  }
  if (pushContent) {
    warnings.push('Every page listed is published as it is here, replacing what visitors see now.');
  }
  if (deletes > 0) {
    warnings.push(`${plural(deletes, 'page')} ${deletes === 1 ? 'is' : 'are'} deleted from the live site.`);
  }
  if ((pushContent && content.firstPush) || (pushTheme && theme.firstPush)) {
    warnings.push('FIRST PUSH: every difference is listed, including any that came from editors on the live site. Anything listed replaces the live version.');
  } else {
    warnings.push('Anything changed on the live site since your last pull is left alone (none is listed above).');
  }
  warnings.push("Earlier versions stay in the live site's history, if you need to go back.");
  ui.blank();
  ui.box(
    ui.fancy ? 'This overwrites the live website, straight away' : 'WARNING: this overwrites the live website, straight away.',
    warnings.map((warning) => `${ui.fancy ? '•' : '-'} ${warning}`),
    'warn',
  );
  ui.blank();
  await confirmByAddress();

  const sending = ui.spinner(`Pushing to ${siteUrl}`);
  const pushed = await executePush(prepared, { content: pushContent, theme: pushTheme }).finally(() => sending.stop());
  result.blank();
  result.success(`Pushed to ${siteUrl}:`);
  const summary: Array<[string, string]> = [];
  if (parts.cms) {
    summary.push(['CMS', `upgraded to ${localVersion}`]);
  }
  if (pushed.theme) {
    summary.push(['theme', `${plural(pushed.theme.files, 'file')} changed, live now`]);
    for (const warning of pushed.theme.warnings) {
      summary.push(['warning', warning]);
    }
  }
  if (pushed.content) {
    const done = pushed.content;
    summary.push(['content', `${done.created} new, ${done.updated} updated, ${done.deleted} deleted`]);
    summary.push(['other', `${plural(done.redirects, 'redirect change')}, ${plural(done.mediaUploaded, 'image')} uploaded${done.settings ? ', site settings updated' : ''}`]);
  }
  result.details(summary);
} catch (error) {
  if (error instanceof SiteSyncError) {
    fail(error.message, ...(error.reason === 'unauthorised' ? [TOKEN_HELP] : []));
  }
  if (error instanceof Error && error.message.startsWith('vhost/deploy.json')) {
    fail(error.message);
  }
  throw error;
}
