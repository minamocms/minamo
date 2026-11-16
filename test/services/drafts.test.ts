import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSiteConfig } from '../../src/config.ts';
import {
  DraftError,
  discardDraft,
  prepareDiscardDraft,
  prepareSaveDraft,
  saveDraft,
} from '../../src/services/drafts.ts';
import { computeEtag } from '../../src/services/etag.ts';
import { PathSafetyError } from '../../src/services/path-safety.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';
import { createTmpSiteRoot, writeAndCommit } from '../helpers/tmp-site.ts';

const themeSchemas: ThemeSchemas = { sections: {}, blocks: {}, acceptsBlocks: { sections: {}, blocks: {} } };

const validPage = {
  schemaVersion: 1,
  name: 'About',
  title: 'About',
  type: 'page',
  layout: 'theme',
  published: true,
  sections: [],
};

// Neither a draft nor a live file exists yet at these tests' target
// paths, so the If-Match comparison is skipped (saveDraftJob's
// null-etag case) - any non-empty placeholder satisfies it.
const NO_PRIOR_FILE_ETAG = 'no-prior-file';

function commitCount(siteRoot: string): number {
  return execFileSync('git', ['log', '--oneline'], { cwd: siteRoot })
    .toString('utf-8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
}

test('C2: saving a draft writes to /drafts/<path> and creates no git commit', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);

    await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);

    const draftPath = join(config.draftsRoot, 'pages/about.json');
    assert.ok(existsSync(draftPath));
    assert.deepEqual(JSON.parse(readFileSync(draftPath, 'utf-8')), validPage);
    assert.equal(commitCount(siteRoot), 1, 'saving a draft must not create a commit');
  } finally {
    cleanup();
  }
});

test('C3: saving a draft that fails schema validation writes nothing to disk', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const invalidPage = { schemaVersion: 1, title: 'About' }; // missing published, sections

    await assert.rejects(
      saveDraft(config, themeSchemas, 'pages/about.json', invalidPage, NO_PRIOR_FILE_ETAG),
      (error: unknown) => error instanceof DraftError && error.reason === 'validation-failed',
    );

    assert.equal(existsSync(join(config.draftsRoot, 'pages/about.json')), false);
  } finally {
    cleanup();
  }
});

// Group I: the real ajv errors reach the caller as a structured field
// (already field-pointing, e.g. /sections/0/settings/heading), not
// only stringified inside .message - what makes I5 (surfacing an
// invalid value against the specific field) achievable at all.
test('Group I: a validation-failed DraftError carries the real structured errors, pointing at the specific field', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const heroSchemas: ThemeSchemas = {
      sections: { hero: { type: 'object', required: ['heading'], properties: { heading: { type: 'string', minLength: 1 } } } },
      blocks: {},
      acceptsBlocks: { sections: { hero: false }, blocks: {} },
    };
    const invalidPage = {
      schemaVersion: 1,
      name: 'About',
      title: 'About',
      type: 'page',
      layout: 'theme',
      published: true,
      sections: [{ id: 'sec-1', type: 'hero', settings: {} }], // missing required "heading"
    };

    await assert.rejects(
      saveDraft(config, heroSchemas, 'pages/about.json', invalidPage, NO_PRIOR_FILE_ETAG),
      (error: unknown) => {
        assert.ok(error instanceof DraftError && error.reason === 'validation-failed');
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0]?.path, '/sections/0/settings/heading');
        assert.equal(error.errors[0]?.keyword, 'required');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('C7: discarding a draft deletes only the draft; the live file is byte-identical before and after', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const liveContent = JSON.stringify({ schemaVersion: 1, title: 'Live', published: true, sections: [] });
    writeAndCommit(siteRoot, 'content/pages/about.json', liveContent);
    const config = loadSiteConfig(siteRoot);

    await saveDraft(config, themeSchemas, 'pages/about.json', validPage, computeEtag(Buffer.from(liveContent)));
    const liveBefore = readFileSync(join(config.contentRoot, 'pages/about.json'));

    await discardDraft(config, 'pages/about.json');

    assert.equal(existsSync(join(config.draftsRoot, 'pages/about.json')), false);
    const liveAfter = readFileSync(join(config.contentRoot, 'pages/about.json'));
    assert.ok(liveBefore.equals(liveAfter), 'live file must be byte-identical after discarding a draft');
  } finally {
    cleanup();
  }
});

test('discarding a draft that does not exist is idempotent, not an error', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await assert.doesNotReject(discardDraft(config, 'pages/never-existed.json'));
  } finally {
    cleanup();
  }
});

test('E3: saving with a matching If-Match succeeds and returns the new ETag', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const newEtag = await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);

    const draftBytes = readFileSync(join(config.draftsRoot, 'pages/about.json'));
    assert.equal(newEtag, computeEtag(draftBytes));
  } finally {
    cleanup();
  }
});

test('a weak-prefixed If-Match (W/"...") matching the real content still succeeds, not a spurious conflict - a compressing proxy in front of a real deployment downgrades strong ETags to weak in transit (RFC 7232), and a client faithfully echoing that back must not be rejected', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const firstEtag = await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);

    const weakEtag = `W/${firstEtag}`;
    const newEtag = await saveDraft(config, themeSchemas, 'pages/about.json', { ...validPage, title: 'Changed' }, weakEtag);

    const draftBytes = readFileSync(join(config.draftsRoot, 'pages/about.json'));
    assert.equal(newEtag, computeEtag(draftBytes));
  } finally {
    cleanup();
  }
});

test('E2: saving with a stale If-Match returns a conflict and writes nothing', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);
    const draftBefore = readFileSync(join(config.draftsRoot, 'pages/about.json'));

    await assert.rejects(
      saveDraft(config, themeSchemas, 'pages/about.json', { ...validPage, title: 'Changed' }, '"stale-etag"'),
      (error: unknown) => error instanceof DraftError && error.reason === 'conflict',
    );

    const draftAfter = readFileSync(join(config.draftsRoot, 'pages/about.json'));
    assert.ok(draftBefore.equals(draftAfter), 'a conflicting write must leave the draft untouched');
  } finally {
    cleanup();
  }
});

test('E4: creating a draft from a live page for the first time checks If-Match against the live ETag, not a nonexistent draft', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const liveContent = JSON.stringify(validPage);
    writeAndCommit(siteRoot, 'content/pages/about.json', liveContent);
    const config = loadSiteConfig(siteRoot);

    // A stale If-Match matching neither the live file nor (obviously)
    // any draft, since no draft exists yet, must still be rejected
    // against the live ETag - proving the comparison target is the
    // live file, not silently skipped just because there's no draft.
    await assert.rejects(
      saveDraft(config, themeSchemas, 'pages/about.json', { ...validPage, title: 'New' }, '"wrong-etag"'),
      (error: unknown) => error instanceof DraftError && error.reason === 'conflict',
    );
    assert.equal(existsSync(join(config.draftsRoot, 'pages/about.json')), false);

    // The real live ETag succeeds.
    const newEtag = await saveDraft(
      config,
      themeSchemas,
      'pages/about.json',
      { ...validPage, title: 'New' },
      computeEtag(Buffer.from(liveContent)),
    );
    assert.ok(existsSync(join(config.draftsRoot, 'pages/about.json')));
    assert.equal(typeof newEtag, 'string');
  } finally {
    cleanup();
  }
});

test('prepareSaveDraft writes the draft, returns no git paths (drafts are never git-tracked), and its undo restores the prior state', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    // Seed a prior draft version, so undo has real prior bytes to restore.
    await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);
    const priorBytes = readFileSync(join(config.draftsRoot, 'pages/about.json'));
    const priorEtag = computeEtag(priorBytes);

    const prepared = await prepareSaveDraft(
      config,
      themeSchemas,
      'pages/about.json',
      { ...validPage, title: 'Changed' },
      priorEtag,
    );

    assert.deepEqual(prepared.paths, []);
    assert.equal(typeof prepared.etag, 'string');
    assert.ok(
      JSON.parse(readFileSync(join(config.draftsRoot, 'pages/about.json'), 'utf-8')).title === 'Changed',
      'the draft must actually be written',
    );

    const failures = prepared.undo();
    assert.deepEqual(failures, []);
    assert.ok(readFileSync(join(config.draftsRoot, 'pages/about.json')).equals(priorBytes), 'undo must restore the prior draft bytes');
  } finally {
    cleanup();
  }
});

test("prepareSaveDraft's undo deletes the draft if it did not exist before", async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const prepared = await prepareSaveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);

    assert.ok(existsSync(join(config.draftsRoot, 'pages/about.json')));
    const failures = prepared.undo();
    assert.deepEqual(failures, []);
    assert.equal(existsSync(join(config.draftsRoot, 'pages/about.json')), false);
  } finally {
    cleanup();
  }
});

test('prepareDiscardDraft discards the draft, returns no git paths, and its undo restores the discarded draft', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);
    const priorBytes = readFileSync(join(config.draftsRoot, 'pages/about.json'));

    const prepared = await prepareDiscardDraft(config, 'pages/about.json');

    assert.deepEqual(prepared.paths, []);
    assert.equal(existsSync(join(config.draftsRoot, 'pages/about.json')), false);

    const failures = prepared.undo();
    assert.deepEqual(failures, []);
    assert.ok(readFileSync(join(config.draftsRoot, 'pages/about.json')).equals(priorBytes), 'undo must restore the discarded draft');
  } finally {
    cleanup();
  }
});

test('E6: two concurrent saves racing with the same now-stale If-Match value - exactly one succeeds, the other conflicts', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    const config = loadSiteConfig(siteRoot);
    const startingEtag = await saveDraft(config, themeSchemas, 'pages/about.json', validPage, NO_PRIOR_FILE_ETAG);

    // Both requests read the same starting ETag from one earlier GET,
    // then race to PUT with that now-shared value - fired via
    // Promise.all, never awaited between them, matching Phase 1's own
    // write-queue concurrency test's directness. No artificial delay:
    // the If-Match check lives inside the queued job (saveDraftJob),
    // so the outcome is deterministic by construction, not by timing
    // luck - verified empirically across 2000 trials before this test
    // was written (see docs/phase-2-checklist.md's Group E notes).
    const results = await Promise.allSettled([
      saveDraft(config, themeSchemas, 'pages/about.json', { ...validPage, title: 'From A' }, startingEtag),
      saveDraft(config, themeSchemas, 'pages/about.json', { ...validPage, title: 'From B' }, startingEtag),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one of the two racing saves must succeed');
    assert.equal(rejected.length, 1, 'exactly one of the two racing saves must conflict');
    const [rejection] = rejected;
    assert.ok(rejection !== undefined && rejection.reason instanceof DraftError && rejection.reason.reason === 'conflict');
  } finally {
    cleanup();
  }
});

// Security audit, November 2026 (AM6): a draft could be saved anywhere
// under content/drafts/, and publishing then wrote it over whatever
// that path names in content/.
test('a draft is only ever saved or discarded for a page or a menu, and a path written another way is the same draft', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);

    for (const path of ['settings.json', 'redirects.json', './settings.json', 'drafts/pages/about.json', 'pages/about.liquid', 'pages/.hidden.json', 'other/about.json']) {
      await assert.rejects(
        saveDraft(config, themeSchemas, path, validPage, NO_PRIOR_FILE_ETAG),
        (error: unknown) => error instanceof PathSafetyError,
        path,
      );
      await assert.rejects(discardDraft(config, path), (error: unknown) => error instanceof PathSafetyError, path);
    }
    assert.equal(existsSync(join(config.draftsRoot, 'settings.json')), false);
    assert.equal(existsSync(join(config.draftsRoot, 'redirects.json')), false);

    await saveDraft(config, themeSchemas, './pages//about.json', validPage, NO_PRIOR_FILE_ETAG);
    assert.ok(existsSync(join(config.draftsRoot, 'pages', 'about.json')));
  } finally {
    cleanup();
  }
});

// AM7: "./menus/main.json" used to be validated as a page.
test('a menu path written another way is still validated as a menu', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);

    await assert.rejects(
      saveDraft(config, themeSchemas, './menus/main.json', validPage, NO_PRIOR_FILE_ETAG),
      (error: unknown) => error instanceof DraftError && error.reason === 'validation-failed',
    );
  } finally {
    cleanup();
  }
});

// Security audit, November 2026 (AM15, AM16): rich text was only
// cleaned by the admin's editor, in the browser.
const richThemeSchemas: ThemeSchemas = {
  sections: {
    text: {
      type: 'object',
      properties: {
        heading: { type: 'string' },
        body: { type: 'string', format: 'richtext' },
        link: { type: 'string', format: 'url' },
      },
    },
  },
  blocks: { note: { type: 'object', properties: { text: { type: 'string', format: 'richtext' } } } },
  acceptsBlocks: { sections: { text: true }, blocks: {} },
};

function richPage(settings: Record<string, unknown>, blockText = '<p>fine</p>'): object {
  return {
    ...validPage,
    sections: [{ id: 's1', type: 'text', settings, blocks: [{ id: 'b1', type: 'note', settings: { text: blockText } }] }],
  };
}

test('a saved draft has its rich text cleaned, in sections and in blocks, and nothing else changed', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);
    const dirty = '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src=x onerror=alert(1)>';

    const etag = await saveDraft(config, richThemeSchemas, 'pages/about.json', richPage({ heading: dirty, body: dirty, link: '/contact' }, dirty), NO_PRIOR_FILE_ETAG);

    const bytes = readFileSync(join(config.draftsRoot, 'pages', 'about.json'));
    const stored = JSON.parse(bytes.toString('utf-8')) as { sections: Array<{ settings: Record<string, string>; blocks: Array<{ settings: Record<string, string> }> }> };
    assert.equal(stored.sections[0]?.settings.body, '<p>Hello</p><img src="x">');
    assert.equal(stored.sections[0]?.blocks[0]?.settings.text, '<p>Hello</p><img src="x">');
    assert.equal(stored.sections[0]?.settings.heading, dirty, 'a plain text field is escaped by the template, and stored as typed');
    assert.equal(stored.sections[0]?.settings.link, '/contact');
    assert.equal(etag, computeEtag(bytes), 'the ETag is of what was stored');
  } finally {
    cleanup();
  }
});

test('a link field that is script is refused, and nothing is written', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);

    for (const link of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
      await assert.rejects(
        saveDraft(config, richThemeSchemas, 'pages/about.json', richPage({ body: '<p>x</p>', link }), NO_PRIOR_FILE_ETAG),
        (error: unknown) => error instanceof DraftError && error.reason === 'validation-failed',
        link,
      );
    }
    assert.equal(existsSync(join(config.draftsRoot, 'pages', 'about.json')), false);

    for (const link of ['/contact', '#top', 'https://example.com', 'mailto:hello@example.com', 'tel:+61400000000', '']) {
      await saveDraft(config, richThemeSchemas, `pages/ok-${Buffer.from(link).toString('hex') || 'empty'}.json`, richPage({ body: '<p>x</p>', link }), NO_PRIOR_FILE_ETAG);
    }
  } finally {
    cleanup();
  }
});

test('a menu item whose link is script is refused', async () => {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  try {
    writeAndCommit(siteRoot, 'README.md', 'seed');
    const config = loadSiteConfig(siteRoot);
    const menu = (url: string) => ({ schemaVersion: 1, items: [{ label: 'Home', url }] });

    await assert.rejects(
      saveDraft(config, themeSchemas, 'menus/main.json', menu('javascript:alert(1)'), NO_PRIOR_FILE_ETAG),
      (error: unknown) => error instanceof DraftError && error.reason === 'validation-failed',
    );
    await saveDraft(config, themeSchemas, 'menus/main.json', menu('/about'), NO_PRIOR_FILE_ETAG);
  } finally {
    cleanup();
  }
});
