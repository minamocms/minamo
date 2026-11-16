import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRelativePath, PathSafetyError, sanitisePath } from '../../src/services/path-safety.ts';
import { createTmpSiteRoot } from '../helpers/tmp-site.ts';

test('B3: a content path containing ".." is rejected before any fs call', () => {
  // A nonexistent root proves rejection happens without touching disk:
  // if this call needed to stat the root, it would throw ENOENT instead.
  assert.throws(
    () => sanitisePath('/nonexistent/root', '../../etc/passwd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B4: a percent-encoded traversal (%2e%2e%2f) is rejected before any fs call', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%2e%2e%2fetc%2fpasswd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B4: an encoded slash disguising a segment boundary is also rejected', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', 'a%2f..%2fetc'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'traversal-segment',
  );
});

test('B5: an absolute path passed as a content path is rejected', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '/etc/passwd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'absolute-path',
  );
});

test('B5: an encoded absolute path is also rejected as absolute-path', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%2fetc%2fpasswd'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'absolute-path',
  );
});

test('malformed percent-encoding is rejected rather than passed through', () => {
  assert.throws(
    () => sanitisePath('/nonexistent/root', '%E0%A4%A'),
    (error: unknown) => error instanceof PathSafetyError && error.reason === 'malformed-encoding',
  );
});

test('a path resolving to exactly the root is rejected (resolves-to-root hardening)', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    assert.throws(
      () => sanitisePath(siteRoot, '.'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'resolves-to-root',
    );
    assert.throws(
      () => sanitisePath(siteRoot, ''),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'resolves-to-root',
    );
  } finally {
    cleanup();
  }
});

test('B6: a symlink inside the content tree pointing outside the site root is not followed', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  const { siteRoot: outsideRoot, cleanup: cleanupOutside } = createTmpSiteRoot();
  try {
    writeFileSync(join(outsideRoot, 'secret.json'), '{}');
    symlinkSync(join(outsideRoot, 'secret.json'), join(siteRoot, 'escape.json'));

    assert.throws(
      () => sanitisePath(siteRoot, 'escape.json'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'symlink-escape',
    );
  } finally {
    cleanup();
    cleanupOutside();
  }
});

test('a symlinked directory inside the content tree pointing outside the site root is not followed', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  const { siteRoot: outsideRoot, cleanup: cleanupOutside } = createTmpSiteRoot();
  try {
    mkdirSync(join(outsideRoot, 'secrets'));
    writeFileSync(join(outsideRoot, 'secrets', 'file.json'), '{}');
    symlinkSync(join(outsideRoot, 'secrets'), join(siteRoot, 'escape-dir'));

    assert.throws(
      () => sanitisePath(siteRoot, 'escape-dir/file.json'),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'symlink-escape',
    );
  } finally {
    cleanup();
    cleanupOutside();
  }
});

test('a legitimate path inside the site root, including one that does not exist yet, is accepted', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    const resolved = sanitisePath(siteRoot, 'pages/about/team.json');
    assert.equal(resolved, join(siteRoot, 'pages', 'about', 'team.json'));
  } finally {
    cleanup();
  }
});

// Regression: found by a live page-reviewer pass against a running
// server, not by inspection. realpathOfNearestExisting only expected
// ENOENT/ENOTDIR from realpathSync while walking up to find an existing
// ancestor; an over-length segment throws ENAMETOOLONG instead, which
// used to be rethrown raw, escaping every route handler's
// `instanceof PathSafetyError` check and surfacing as an unsanitised
// 500 rather than a clean 404/400.
test('a path segment longer than the filesystem limit is rejected as a PathSafetyError, not a raw ENAMETOOLONG', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    // The over-length segment must be the first non-existent component
    // path resolution reaches (directly under the real, existing
    // siteRoot) - buried under a nonexistent intermediate directory,
    // realpathSync would report that missing parent (ENOENT) first and
    // never reach the length check on the final segment.
    assert.throws(
      () => sanitisePath(siteRoot, `${'a'.repeat(300)}.json`),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'invalid-path',
    );
  } finally {
    cleanup();
  }
});

// Regression, same root cause as above: a null byte makes
// realpathSync throw a TypeError (ERR_INVALID_ARG_VALUE) rather than
// an ENOENT/ENOTDIR errno error, which also used to escape raw.
test('a path containing a null byte is rejected as a PathSafetyError, not a raw TypeError', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    assert.throws(
      () => sanitisePath(siteRoot, `pages/x${String.fromCharCode(0)}y.json`),
      (error: unknown) => error instanceof PathSafetyError && error.reason === 'invalid-path',
    );
  } finally {
    cleanup();
  }
});

// Security audit, November 2026 (AM2, AM3): the one form in which a
// request names a page or a menu.
test('contentRelativePath returns a page or menu path in one canonical form, however it was written', () => {
  for (const written of ['pages/about.json', './pages/about.json', 'pages//about.json', 'pages/./about.json', 'pages%2Fabout.json', 'pages/about%2Ejson']) {
    assert.equal(contentRelativePath(written), 'pages/about.json', written);
  }
  assert.equal(contentRelativePath('pages/blog/2026/hello-world.json'), 'pages/blog/2026/hello-world.json');
  assert.equal(contentRelativePath('pages/404.json'), 'pages/404.json');
  assert.equal(contentRelativePath('./menus/main.json'), 'menus/main.json');
});

test('contentRelativePath refuses everything that is not a page or a menu file', () => {
  const refused = [
    // What sits beside pages/ and menus/ in content/.
    'settings.json',
    'redirects.json',
    './settings.json',
    'drafts/pages/about.json',
    './drafts/pages/about.json',
    'drafts%2Fpages%2Fabout.json',
    'pages/../settings.json',
    'pages/%2e%2e/settings.json',
    '/pages/about.json',
    '%2Fpages%2Fabout.json',
    // Not a .json file, or not a file at all.
    'pages',
    'pages/',
    'pages/about',
    'pages/about.json/',
    'pages/about.liquid',
    'pages/.json',
    'pages/.hidden.json',
    'pages/.git/config.json',
    'other/about.json',
    'Pages/about.json',
    '',
    '.',
    // Anything a second decoding would change, or a name would not hold.
    'pages/a%2562.json',
    'pages/a%20b.json',
    'pages/caf%C3%A9.json',
    'pages/a\\b.json',
    `pages/a${String.fromCharCode(0)}b.json`,
    'pages/%E0%A4%A.json',
  ];
  for (const written of refused) {
    assert.throws(() => contentRelativePath(written), (error: unknown) => error instanceof PathSafetyError, JSON.stringify(written));
  }
});

test('what contentRelativePath returns is unchanged by sanitisePath decoding it again', () => {
  const { siteRoot, cleanup } = createTmpSiteRoot();
  try {
    for (const written of ['pages/about.json', './pages/blog/a.b_c-1.json', 'menus%2Fmain.json']) {
      const canonical = contentRelativePath(written);
      assert.equal(sanitisePath(siteRoot, canonical), join(siteRoot, canonical));
    }
  } finally {
    cleanup();
  }
});
