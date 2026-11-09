import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSiteConsole } from '../../src/terminal/site-console.ts';
import { CloudflaredNotInstalledError, cloudflaredInstallCommand } from '../../src/services/dev-tunnel.ts';
import { captureOutput } from '../helpers/capture-output.ts';

test('no cloudflared: says the tunnel needs it, how to install it, and that the site still runs', () => {
  const captured = captureOutput();
  const terminal = createSiteConsole(captured.output);
  terminal.openingTunnel().failed(new CloudflaredNotInstalledError());
  const printed = captured.all().join('\n');
  assert.match(printed, /needs cloudflared, which isn't installed/);
  assert.ok(printed.includes(`Install it with: ${cloudflaredInstallCommand()}`));
  assert.match(printed, /still running here/);
});

test('a tunnel that will not open: gives the reason and what to try', () => {
  const captured = captureOutput();
  createSiteConsole(captured.output).openingTunnel().failed(new Error('cloudflared stopped (exit code 1): 429 Too Many Requests'));
  const printed = captured.stderr.join('\n');
  assert.match(printed, /Couldn't open a tunnel: cloudflared stopped \(exit code 1\): 429 Too Many Requests/);
  assert.match(printed, /npm run dev again in a minute/);
});

test('plain output keeps the lines scripts and logs look for', () => {
  const captured = captureOutput();
  const terminal = createSiteConsole(captured.output);
  terminal.running('http://127.0.0.1:3000');
  const opening = terminal.openingTunnel();
  opening.opened('https://words.trycloudflare.com');
  terminal.editLink('https://cms.minamo.app/local#site=x&key=y');
  assert.ok(captured.stdout.includes('Site running at http://127.0.0.1:3000'));
  assert.ok(captured.stdout.includes('Tunnel open (Cloudflare): https://words.trycloudflare.com'));
  assert.ok(captured.stdout.includes('Edit in Minamo: https://cms.minamo.app/local#site=x&key=y'));
});
