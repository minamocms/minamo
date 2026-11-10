import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { TEMPLATE_ROOT, scaffoldSite } from '../../src/create-site/generate-site.ts';
import { renderPage } from '../../src/renderer/render-page.ts';
import { resolveSiteSettings } from '../../src/services/site-settings.ts';
import { runSiteCheck } from '../../src/site-check/run-check.ts';

// The starter every new site begins from (src/create-site/template). It has
// to work out of the box, for any section an editor adds, and stay neutral:
// someone starting a client site shouldn't have to delete our product's copy.

function scaffolded(): { siteRoot: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'starter-test-'));
  const siteRoot = join(parent, 'site');
  scaffoldSite(siteRoot);
  return { siteRoot, cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// What a section or block starts with when an editor adds it: each required
// property's default, nothing else.
function startingSettings(schema: object): Record<string, unknown> {
  const { required = [], properties = {} } = schema as { required?: string[]; properties?: Record<string, { default?: unknown }> };
  return Object.fromEntries(required.map((key) => [key, properties[key]?.default]));
}

test('a new site passes the site check: every page renders, with no broken links, missing files or excluded components', async () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    const result = await runSiteCheck(siteRoot);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.ok, true);
  } finally {
    cleanup();
  }
});

test('a new site has Home, About, Our team (nested under About), Contact and a 404 page, a main and a footer menu, and a page template', () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    const pages = filesUnder(join(siteRoot, 'content', 'pages')).map((path) => relative(join(siteRoot, 'content', 'pages'), path)).sort();
    assert.deepEqual(pages, ['404.json', 'about.json', 'about/team.json', 'contact.json', 'index.json']);
    const menus = readdirSync(join(siteRoot, 'content', 'menus')).sort();
    assert.deepEqual(menus, ['footer.json', 'main.json']);
    assert.deepEqual(readdirSync(join(siteRoot, 'theme', 'templates')), ['standard-page.json']);
  } finally {
    cleanup();
  }
});

test('every section renders as an editor first adds it, with each block it allows, and with no picture set', async () => {
  const { siteRoot, cleanup } = scaffolded();
  try {
    const { themeSchemas } = bootSite(siteRoot);
    assert.deepEqual(themeSchemas.warnings ?? [], []);
    const sectionTypes = Object.keys(themeSchemas.sections).sort();
    assert.deepEqual(sectionTypes, ['call-to-action', 'cards', 'contact-details', 'faq', 'gallery', 'hero', 'image-text', 'quote', 'rich-text']);

    const sections = sectionTypes.map((type) => {
      const schema = themeSchemas.sections[type] as { allowedBlocks?: string[] };
      const blocks = (schema.allowedBlocks ?? []).map((blockType) => ({
        id: `${type}-${blockType}`,
        type: blockType,
        settings: startingSettings(themeSchemas.blocks[blockType] as object),
      }));
      return { id: type, type, settings: startingSettings(schema), ...(blocks.length > 0 ? { blocks } : {}) };
    });
    writeFileSync(
      join(siteRoot, 'content', 'pages', 'every-section.json'),
      JSON.stringify({ schemaVersion: 7, name: 'Every section', title: 'Every section', type: 'page', layout: 'theme', published: true, sections }),
    );

    const booted = bootSite(siteRoot);
    const html = await renderPage(booted.config, booted.themeTemplates, booted.layouts, booted.engine, 'pages/every-section.json', 'public', resolveSiteSettings(booted.config, booted.themeSchemas));
    for (const type of sectionTypes) {
      assert.match(html, new RegExp(`data-section-id="${type}"`), `${type} renders`);
    }
    for (const block of sections.flatMap((section) => section.blocks ?? [])) {
      assert.match(html, new RegExp(`data-block-id="${block.id}"`), `${block.type} renders inside ${block.id.split('-')[0]}`);
    }
    // No picture is set anywhere, so there is nothing to drop onto and no
    // empty placeholder for a visitor to see.
    assert.doesNotMatch(html, /data-cms-media=|media--empty/);
  } finally {
    cleanup();
  }
});

test('the starter stays neutral: no mention of Minamo in its theme or content, and no em or en dashes anywhere in it', () => {
  for (const path of filesUnder(TEMPLATE_ROOT)) {
    const text = readFileSync(path, 'utf-8');
    const where = relative(TEMPLATE_ROOT, path);
    assert.doesNotMatch(text, /[–—]/, `${where} has an em or en dash`);
    if (where.startsWith('theme') || where.startsWith('content')) {
      assert.doesNotMatch(text, /minamo/i, `${where} mentions Minamo`);
    }
  }
});
