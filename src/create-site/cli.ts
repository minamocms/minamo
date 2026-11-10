#!/usr/bin/env node
import { resolve } from 'node:path';
import { ScaffoldError, scaffoldSite } from './generate-site.ts';
import { pickSitePort } from '../services/free-port.ts';
import { err, out } from '../terminal/ui.ts';

const targetArg = process.argv[2];
if (!targetArg) {
  err().error('No folder given.', `Usage: ${err().command('create-site <directory>')}`);
  process.exit(1);
}

const ui = out();
try {
  const targetDir = resolve(process.cwd(), targetArg);
  // A free port of its own, so it can run beside other sites.
  const port = await pickSitePort();
  const { raw } = scaffoldSite(targetDir, { port });
  ui.header('minamo', 'create-site');
  ui.success(`Created a new site at ${targetDir}`);
  ui.blank();
  ui.box(
    ui.fancy ? 'Your access token' : 'Your access token (save this now - it will not be shown again):',
    [
      ...(ui.fancy ? ['Save this now. It will not be shown again.', ''] : []),
      ui.fancy ? ui.style(raw, 'bold') : `  ${raw}`,
    ],
    'warn',
  );
  ui.blank();
  ui.heading('Next steps:');
  ui.list([ui.command(`cd ${targetArg}/vhost`), ui.command('npm install'), ui.command('npm run dev')], { bullet: ui.fancy ? ui.style('$', 'dim') : ' ' });
  ui.blank();
  ui.info(`It runs at http://localhost:${port} (set in vhost/site.config.json). npm run dev restarts it when the theme changes, and offers to open it in Minamo for editing.`);
} catch (error) {
  if (error instanceof ScaffoldError) {
    err().error(error.message);
    process.exit(1);
  }
  throw error;
}
