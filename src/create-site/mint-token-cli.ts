#!/usr/bin/env node
import { resolve } from 'node:path';
import { MintTokenError, mintToken, parseScopes } from './mint-token.ts';
import { err, out } from '../terminal/ui.ts';

const targetArg = process.argv[2];
const scopesFlagIndex = process.argv.indexOf('--scopes');
const scopesArg = scopesFlagIndex !== -1 ? process.argv[scopesFlagIndex + 1] : undefined;

if (!targetArg) {
  err().error('No site folder given.', `Usage: ${err().command('mint-token <site-directory> [--scopes content,theme,media]')}`);
  process.exit(1);
}

const ui = out();
try {
  const scopes = parseScopes(scopesArg);
  const siteDir = resolve(process.cwd(), targetArg);
  const { raw } = mintToken(siteDir, scopes);
  ui.box(
    ui.fancy ? 'New access token' : 'New access token (save this now - it will not be shown again):',
    [...(ui.fancy ? ['Save this now. It will not be shown again.', ''] : []), ui.fancy ? ui.style(raw, 'bold') : `  ${raw}`],
    'warn',
  );
  ui.blank();
  ui.details([['Scopes', scopes.join(', ')]]);
} catch (error) {
  if (error instanceof MintTokenError) {
    err().error(error.message);
    process.exit(1);
  }
  throw error;
}
