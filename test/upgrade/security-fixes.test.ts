import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySecurityFixes } from '../../src/upgrade/security-fixes.ts';

function vhost(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'security-fixes-'));
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/fast-uri":{"version":"3.1.8"}}}');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("runs npm audit fix for the site's own dependencies only, never forced", () => {
  const { dir, cleanup } = vhost();
  try {
    const calls: string[][] = [];
    applySecurityFixes(dir, (args) => calls.push(args));
    assert.deepEqual(calls, [['audit', 'fix', '--omit=dev', '--no-fund']]);
    assert.ok(!calls[0]?.includes('--force'));
  } finally {
    cleanup();
  }
});

test('reports updated when the lockfile changed, even if npm exits non-zero for what it could not fix', () => {
  const { dir, cleanup } = vhost();
  try {
    const outcome = applySecurityFixes(dir, () => {
      writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/fast-uri":{"version":"3.1.9"}}}');
      throw new Error('npm audit fix exited with 1');
    });
    assert.equal(outcome, 'updated');
  } finally {
    cleanup();
  }
});

test('reports unchanged, and never throws, when nothing changed or npm failed', () => {
  const { dir, cleanup } = vhost();
  try {
    assert.equal(applySecurityFixes(dir, () => {}), 'unchanged');
    assert.equal(
      applySecurityFixes(dir, () => {
        throw new Error('npm not found');
      }),
      'unchanged',
    );
  } finally {
    cleanup();
  }
});
