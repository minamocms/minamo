import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

// adminBaseUrl: a string sets it, false turns it off, and leaving it
// out (undefined here) writes no site.config.json at all, so the
// default applies. beforeBoot runs after the site root exists but
// before bootSite() - theme layouts (unlike ordinary page content) are
// read once at boot, so a test needing a working layout must write it
// there, not after.
function buildAdminRedirectTestServer(adminBaseUrl?: string | false, beforeBoot?: (siteRoot: string) => void) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  if (adminBaseUrl !== undefined) {
    writeJson(siteRoot, 'vhost/site.config.json', { adminBaseUrl });
  }
  beforeBoot?.(siteRoot);

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

function writeAdminPage(siteRoot: string, published: boolean): void {
  mkdirSync(join(siteRoot, 'theme', 'layouts'), { recursive: true });
  writeFileSync(join(siteRoot, 'theme', 'layouts', 'theme.liquid'), '{{ content_for_layout | raw }}');
  writeJson(siteRoot, 'content/pages/admin.json', {
    schemaVersion: 6,
    name: 'Admin',
    title: 'Admin',
    type: 'page',
    layout: 'theme',
    published,
    sections: [],
  });
}

test('AJ1: with no adminBaseUrl configured, GET /admin redirects to the hosted Minamo admin with ?site=<host>', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: { host: 'mysite.example.test' } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://cms.minamo.app/?site=mysite.example.test');
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /admin redirects to a configured adminBaseUrl, no Authorization header needed', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer('https://admin.example.com');
  try {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: { host: 'mysite.example.test' } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://admin.example.com/?site=mysite.example.test');
  } finally {
    await app.close();
    cleanup();
  }
});

test('GET /admin reflects the requesting host, port included', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer('https://admin.example.com');
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { host: 'mysite.example.test:4000' },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://admin.example.com/?site=mysite.example.test%3A4000');
  } finally {
    await app.close();
    cleanup();
  }
});

test('AJ2: with "adminBaseUrl": false and no page at /admin, it 404s like any other missing page', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer(false);
  try {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});

// The redirect is the fallback for a /admin that would otherwise 404,
// never a reserved path: a site can still have its own page there.
test('AJ3: a real published page at /admin renders normally instead of redirecting', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer(undefined, (siteRoot) => writeAdminPage(siteRoot, true));
  try {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  } finally {
    await app.close();
    cleanup();
  }
});

test('AJ3: a redirects.json entry at /admin wins over the admin redirect', async () => {
  const { app, siteRoot, cleanup } = buildAdminRedirectTestServer();
  try {
    writeJson(siteRoot, 'content/redirects.json', { '/admin': '/staff' });
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 301);
    assert.equal(response.headers.location, '/staff');
  } finally {
    await app.close();
    cleanup();
  }
});

test('AJ3: a theme/root/admin file wins over the admin redirect', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer(undefined, (siteRoot) => {
    mkdirSync(join(siteRoot, 'theme', 'root'), { recursive: true });
    writeFileSync(join(siteRoot, 'theme', 'root', 'admin'), 'a static file');
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'a static file');
  } finally {
    await app.close();
    cleanup();
  }
});

// Unpublished is "not on the public site yet": the visitor gets the
// admin rather than a 404, the same as if the draft didn't exist.
test('AJ3: an unpublished page at /admin falls back to the admin redirect', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer(undefined, (siteRoot) => writeAdminPage(siteRoot, false));
  try {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: { host: 'mysite.example.test' } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, 'https://cms.minamo.app/?site=mysite.example.test');
  } finally {
    await app.close();
    cleanup();
  }
});

test('only /admin itself redirects: /admin/anything is an ordinary missing page', async () => {
  const { app, cleanup } = buildAdminRedirectTestServer();
  try {
    const response = await app.inject({ method: 'GET', url: '/admin/settings' });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
    cleanup();
  }
});
