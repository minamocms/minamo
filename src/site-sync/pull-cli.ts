#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { ask, chooseParts, parseSyncArgs, resolveToken, TOKEN_HELP } from './cli-helpers.ts';
import { normaliseSiteUrl } from './prompts.ts';
import { checkPullableSite, pullSite } from './pull-site.ts';
import { RemoteSite, SiteSyncError } from './remote-site.ts';
import { fetchLiveTheme } from './theme-sync.ts';
import { err, out } from '../terminal/ui.ts';

// Progress, questions and problems on stderr; the result on stdout.
const ui = err();
const result = out();

const args = parseSyncArgs(process.argv.slice(2));
const force = args.flags.has('--force');

const givenUrl = args.positional[0] ?? (await ask('Live site address: '));
const siteUrl = normaliseSiteUrl(givenUrl);
if (!siteUrl) {
  ui.error(
    givenUrl.trim() === '' ? 'No address entered.' : `"${givenUrl}" is not a web address.`,
    `Usage: ${ui.command('npm run pull [-- <live-site-address>] [--content] [--theme] [--force]')}`,
  );
  process.exit(1);
}
ui.header('minamo pull', siteUrl);

// Checked before asking for the token, so a mistyped address is found
// out without typing a token for nothing.
const checking = ui.spinner(`Checking ${siteUrl}`);
try {
  await checkPullableSite(siteUrl);
  checking.succeed(`Found the Minamo site at ${siteUrl}`);
} catch (error) {
  checking.stop();
  if (error instanceof SiteSyncError) {
    ui.error(error.message);
    process.exit(1);
  }
  throw error;
}

const token = await resolveToken(args, siteUrl);

// Run from vhost/ (the scaffold's own "pull" script), so the site root
// is one level up - the same relationship check-site relies on.
const config = loadSiteConfig(resolve(process.cwd(), '..'));

// Asked before anything is changed: the theme needs a token with the
// "theme" scope, found out here with one read rather than part way in.
const reading = ui.spinner('Reading what the live site has');
const liveTheme = await fetchLiveTheme(new RemoteSite(siteUrl, token)).catch(
  (error: unknown) => ({ unavailable: error instanceof Error ? error.message : String(error) }),
);
reading.stop();
const parts = await chooseParts(args, 'pull', {
  content: { available: true, detail: 'pages, menus, redirects, images', checked: true },
  theme:
    'theme' in liveTheme
      ? { available: true, detail: 'templates, styles, scripts', checked: true }
      : { available: false, detail: liveTheme.unavailable, checked: false },
});
if (!parts.content && !parts.theme) {
  ui.info('Nothing chosen. Nothing was pulled.');
  process.exit(0);
}

const pulling = ui.spinner(`Pulling from ${siteUrl}`);
try {
  const pulled = await pullSite(config, { siteUrl, token, force, parts });
  pulling.stop();
  result.blank();
  result.success(`Pulled from ${siteUrl}:`);
  const summary: Array<[string, string]> = [];
  if (pulled.theme) {
    summary.push(['theme', `${pulled.theme.files} files, ${pulled.theme.downloaded} downloaded`]);
  }
  if (pulled.content) {
    const content = pulled.content;
    summary.push(['content', `${content.pages} pages, ${content.menus} menus, ${content.drafts} drafts, ${content.redirects} redirects`]);
    summary.push(['images', `${content.mediaDownloaded} downloaded, ${content.mediaAlreadyPresent} already here`]);
  }
  result.details(summary);
  const removed = [
    ...(pulled.theme?.removed ?? []).map((path) => `removed theme/${path} (not on the live site)`),
    ...(pulled.content?.removed ?? []).map((path) => `removed content/${path} (not on the live site)`),
  ];
  if (removed.length > 0) {
    result.list(removed);
  }
  result.blank();
  result.info(
    'Nothing was committed.',
    `Review the changes with ${result.command('git status')} and ${result.command('git diff')} from the site folder.`,
  );
} catch (error) {
  pulling.stop();
  if (error instanceof SiteSyncError) {
    ui.error(error.message, ...(error.reason === 'unauthorised' ? [TOKEN_HELP] : []));
    process.exit(1);
  }
  throw error;
}
