import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { isPortFree, nextFreePort, pickSitePort, SITE_PORT_RANGE } from '../../src/services/free-port.ts';

function listenAnywhere(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test('isPortFree is false while something listens on the port, and true once it stops', async () => {
  const { server, port } = await listenAnywhere('0.0.0.0');
  assert.equal(await isPortFree(port), false);
  await close(server);
  assert.equal(await isPortFree(port), true);
});

test('isPortFree is false when the port is taken only on localhost', async () => {
  const { server, port } = await listenAnywhere('127.0.0.1');
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await close(server);
  }
});

test('pickSitePort picks a random port in 3000 to 3999, passing over taken ones', async () => {
  const tries = [0, 0.5, 0.999];
  const asked: number[] = [];
  const port = await pickSitePort({
    random: () => tries.shift() ?? 0,
    isFree: async (candidate) => (asked.push(candidate), candidate !== 3000 && candidate !== 3500),
  });
  assert.deepEqual(asked, [3000, 3500, 3999]);
  assert.equal(port, 3999);
  assert.deepEqual(SITE_PORT_RANGE, { min: 3000, max: 3999 });
});

test('pickSitePort falls back to 3000 when every port it tries is taken', async () => {
  assert.equal(await pickSitePort({ random: () => 0.42, isFree: async () => false }, 5), 3000);
});

test('nextFreePort finds the first free port after a taken one, or null when none is near', async () => {
  assert.equal(await nextFreePort(3000, { isFree: async (port) => port === 3003 }), 3003);
  assert.equal(await nextFreePort(3000, { isFree: async () => false }, 10), null);
});
