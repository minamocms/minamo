import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { scaffoldSite } from '../../src/create-site/generate-site.ts';
import { renderPage } from '../../src/renderer/render-page.ts';
import { resolveSiteSettings } from '../../src/services/site-settings.ts';

// A new site ships with site settings: its name, accent colour, font,
// contact details and social links come from them, defaulting to what the
// starter shows, and follow a saved change.
test('a new site\'s name, accent colour, font, contact details and social links come from its site settings, and follow a saved change', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'scaffold-settings-'));
  try {
    const siteRoot = join(parent, 'site');
    scaffoldSite(siteRoot);
    const render = () => {
      const booted = bootSite(siteRoot);
      assert.deepEqual(booted.themeSchemas.warnings ?? [], []);
      return renderPage(booted.config, booted.themeTemplates, booted.layouts, booted.engine, 'pages/index.json', 'public', resolveSiteSettings(booted.config, booted.themeSchemas));
    };

    const before = await render();
    assert.match(before, /<title>Home \| Your site name<\/title>/);
    assert.match(before, /--accent: #2b59c3;/);
    assert.doesNotMatch(before, /--font-body: var\(--font-serif\)/);
    assert.match(before, /href="mailto:hello@example\.com"/);
    assert.match(before, /Street address<br \/>\s*Suburb STATE 0000/, 'the address keeps its line breaks');
    assert.doesNotMatch(before, /class="social-links"/, 'no social links are set, so none are shown');

    writeFileSync(
      join(siteRoot, 'content', 'settings.json'),
      JSON.stringify({
        schemaVersion: 7,
        settings: {
          site_name: 'Example Studio',
          accent_colour: '#0f766e',
          body_font: 'Serif',
          email: '',
          address: '1 <b>Example</b> St\nCity',
          instagram_url: 'https://instagram.com/example',
        },
      }),
    );
    const after = await render();
    assert.match(after, /<title>Home \| Example Studio<\/title>/);
    assert.match(after, /--accent: #0f766e;/);
    assert.match(after, /--font-body: var\(--font-serif\)/);
    assert.doesNotMatch(after, /mailto:/, 'an email left empty is not shown');
    assert.match(after, /1 &lt;b&gt;Example&lt;\/b&gt; St<br \/>\s*City/, 'an address is escaped before its line breaks are added');
    assert.match(after, /href="https:\/\/instagram\.com\/example" aria-label="Instagram"/);
    assert.doesNotMatch(after, /aria-label="Facebook"/, 'a link left empty is not shown');
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
