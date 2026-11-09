#!/usr/bin/env node
import { resolve } from 'node:path';
import { seedMedia } from './seed-media.ts';
import { err, out } from '../terminal/ui.ts';

const [targetArg, ...sourceArgs] = process.argv.slice(2);

if (!targetArg || sourceArgs.length === 0) {
  err().error('Nothing to add.', `Usage: ${err().command('seed-media <site-directory> <path> [<path> ...]')}`);
  process.exit(1);
}

const ui = out();
const siteDir = resolve(process.cwd(), targetArg);
const sourcePaths = sourceArgs.map((sourceArg) => resolve(process.cwd(), sourceArg));
const result = seedMedia(siteDir, sourcePaths);

for (const entry of result.entries) {
  if (entry.status === 'seeded') {
    if (ui.fancy) {
      ui.success(entry.sourcePath, `-> ${entry.url}`);
    } else {
      ui.line(`${entry.sourcePath} -> ${entry.url}`);
    }
  } else if (ui.fancy) {
    ui.warn(`${entry.sourcePath}: skipped`, entry.reason ?? '');
  } else {
    ui.line(`${entry.sourcePath}: skipped (${entry.reason})`);
  }
}

if (!result.ok) {
  process.exit(1);
}
