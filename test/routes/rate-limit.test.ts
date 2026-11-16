import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootSite } from '../../src/boot.ts';
import { buildServer } from '../../src/server.ts';
import { loadServerConfig } from '../../src/server-config.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';

const CONTENT_TOKEN = 'rate-limit-test-token';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildRateLimitTestServer(rateLimit: { max: number; windowMs: number }) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', {
    tokens: [{ hash: hashOf(CONTENT_TOKEN), scopes: ['content'] }],
    rateLimit,
  });

  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  const app = buildServer(booted, serverConfig, { logger: false });

  return { app, siteRoot, cleanup };
}

test('H2: a write endpoint past its configured rate limit returns 429', async () => {
  const { app, cleanup } = buildRateLimitTestServer({ max: 2, windowMs: 60000 });
  try {
    const requestOnce = () =>
      app.inject({
        method: 'POST',
        url: '/v1/search/rebuild',
        headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
      });

    const first = await requestOnce();
    const second = await requestOnce();
    const third = await requestOnce();

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(third.statusCode, 429);
    const body = JSON.parse(third.body) as { statusCode: number; error: string; message: string };
    assert.equal(body.statusCode, 429);
    assert.equal(typeof body.message, 'string');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a GET route is never rate-limited, even when a sibling write route in the same file is', async () => {
  const { app, cleanup } = buildRateLimitTestServer({ max: 1, windowMs: 60000 });
  try {
    // Exhaust the write route's limit first.
    await app.inject({
      method: 'POST',
      url: '/v1/search/rebuild',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    const exhausted = await app.inject({
      method: 'POST',
      url: '/v1/search/rebuild',
      headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
    });
    assert.equal(exhausted.statusCode, 429);

    // A GET route (content.ts mixes GET and write routes in one file,
    // same registration order concern) must remain completely
    // unaffected - global: false means only routes carrying an
    // explicit rate-limit config marker are ever limited.
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/content',
        headers: { authorization: `Bearer ${CONTENT_TOKEN}` },
      });
      assert.equal(response.statusCode, 200);
    }
  } finally {
    await app.close();
    cleanup();
  }
});

test('H2: GET /v1/capabilities gets its own, more generous rate limit', async () => {
  const { app, cleanup } = buildRateLimitTestServer({ max: 60, windowMs: 60000 });
  try {
    // capabilities.ts's own CAPABILITIES_RATE_LIMIT (max: 300) is
    // independent of the configured write-route limit above (max: 60)
    // - requesting it more than 60 times in a row must still succeed,
    // proving it isn't sharing the write-route bucket/limit.
    let allSucceeded = true;
    for (let i = 0; i < 65; i++) {
      const response = await app.inject({ method: 'GET', url: '/v1/capabilities' });
      if (response.statusCode !== 200) {
        allSucceeded = false;
        break;
      }
    }
    assert.equal(allSucceeded, true);
  } finally {
    await app.close();
    cleanup();
  }
});

// Security audit, November 2026 (AM19): the limiter counted every
// request by address, before any token was checked, so requests that
// were always going to be refused could use up the limit the real admin
// needs, from the same address (a proxy's) or any other.
test('requests without a valid token never use up the allowance of one with a token, even from the same address', async () => {
  const { app, cleanup } = buildRateLimitTestServer({ max: 2, windowMs: 60000 });
  try {
    const rebuild = (authorization?: string) =>
      app.inject({ method: 'POST', url: '/v1/search/rebuild', headers: authorization ? { authorization } : {} });

    // Refused requests, then limited ones: all from the one address the
    // real admin also arrives from.
    for (const authorization of [undefined, 'Bearer wrong-token', 'Bearer another-wrong-token', undefined, 'Basic abc']) {
      const response = await rebuild(authorization);
      assert.ok([401, 429].includes(response.statusCode), String(response.statusCode));
    }
    assert.equal((await rebuild()).statusCode, 429, 'the address without a token is limited');

    assert.equal((await rebuild(`Bearer ${CONTENT_TOKEN}`)).statusCode, 200);
    assert.equal((await rebuild(`Bearer ${CONTENT_TOKEN}`)).statusCode, 200);
    assert.equal((await rebuild(`Bearer ${CONTENT_TOKEN}`)).statusCode, 429, 'the token still has its own limit');
  } finally {
    await app.close();
    cleanup();
  }
});

test('a token is limited as one, whatever address it arrives from', async () => {
  const { app, cleanup } = buildRateLimitTestServer({ max: 2, windowMs: 60000 });
  try {
    const rebuildFrom = (remoteAddress: string) =>
      app.inject({ method: 'POST', url: '/v1/search/rebuild', headers: { authorization: `Bearer ${CONTENT_TOKEN}` }, remoteAddress });

    assert.equal((await rebuildFrom('203.0.113.1')).statusCode, 200);
    assert.equal((await rebuildFrom('203.0.113.2')).statusCode, 200);
    assert.equal((await rebuildFrom('203.0.113.3')).statusCode, 429);
  } finally {
    await app.close();
    cleanup();
  }
});
