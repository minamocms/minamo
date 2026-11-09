import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalEditKey, localEditLink } from '../../src/services/local-edit-link.ts';
import { verifyToken } from '../../src/services/token-auth.ts';

test('a local edit key is a fresh, long random token with every scope', () => {
  const first = createLocalEditKey();
  const second = createLocalEditKey();
  assert.notEqual(first.key, second.key);
  assert.ok(first.key.length >= 43, 'at least 32 random bytes');
  assert.match(first.key, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyToken([first.token], first.key), ['content', 'theme', 'media']);
  assert.equal(verifyToken([first.token], second.key), null);
});

test('the link puts the site address and key after #, so neither is sent to the admin server in the request', () => {
  const link = localEditLink('https://cms.minamo.app/', 'https://red-papers-lick.trycloudflare.com', 'abc_DEF-123');
  assert.equal(link, 'https://cms.minamo.app/local#site=https%3A%2F%2Fred-papers-lick.trycloudflare.com&key=abc_DEF-123');
  const parsed = new URL(link);
  assert.equal(parsed.pathname, '/local');
  assert.equal(parsed.search, '');
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  assert.equal(fragment.get('site'), 'https://red-papers-lick.trycloudflare.com');
  assert.equal(fragment.get('key'), 'abc_DEF-123');
});
