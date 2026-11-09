import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  cloudflaredInstallCommand,
  CloudflaredNotInstalledError,
  startDevTunnel,
  type DevTunnelDeps,
  type DevTunnelEvent,
} from '../../src/services/dev-tunnel.ts';

// A stand-in for a cloudflared process: say() writes to its stderr, the
// way cloudflared reports its address; crash() ends it unexpectedly.
class FakeCloudflared extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  say(text: string): void {
    this.stderr.write(text);
  }
  // What cloudflared prints once a quick tunnel is up: the address, then
  // a registered connection.
  open(url: string): void {
    this.say(`INF |  ${url}  |\n`);
    this.say('INF Registered tunnel connection connIndex=0 location=mel01 protocol=quic\n');
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  crash(code = 1): void {
    this.emit('exit', code, null);
  }
}

function notInstalled(): ChildProcess {
  const error = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' });
  const child = new FakeCloudflared([]);
  setImmediate(() => child.emit('error', error));
  return child as unknown as ChildProcess;
}

// Fast settings, and the events kept.
function deps(events: DevTunnelEvent[] = []): Pick<DevTunnelDeps, 'report' | 'waitForDns' | 'retryDelayMs' | 'reopenDelayMs'> {
  return { report: (event) => events.push(event), waitForDns: async () => {}, retryDelayMs: 1, reopenDelayMs: 1 };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'condition never became true');
};

test('opens a Cloudflare quick tunnel to the local site', async () => {
  const spawned: FakeCloudflared[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...deps(),
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      spawned.push(child);
      setImmediate(() => child.open('https://serum-inline-stand-bug.trycloudflare.com'));
      return child as unknown as ChildProcess;
    },
  });
  assert.equal(tunnel.url, 'https://serum-inline-stand-bug.trycloudflare.com');
  assert.deepEqual(spawned[0]?.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3123']);
  tunnel.close();
  assert.equal(spawned[0]?.killed, true, 'closing the tunnel must stop cloudflared');
});

test('fails straight away, without retrying, when cloudflared is not installed', async () => {
  const events: DevTunnelEvent[] = [];
  let spawns = 0;
  await assert.rejects(
    () =>
      startDevTunnel(3123, {
        ...deps(events),
        spawnCloudflared: () => {
          spawns++;
          return notInstalled();
        },
      }),
    CloudflaredNotInstalledError,
  );
  assert.equal(spawns, 1);
  assert.deepEqual(events, []);
});

test('the install command suits the computer', () => {
  assert.equal(cloudflaredInstallCommand('darwin'), 'brew install cloudflared');
  assert.match(cloudflaredInstallCommand('win32'), /^winget install/);
  assert.match(cloudflaredInstallCommand('linux'), /developers\.cloudflare\.com/);
});

test('tries again when cloudflared stops before opening a tunnel, and succeeds', async () => {
  const events: DevTunnelEvent[] = [];
  let spawns = 0;
  const tunnel = await startDevTunnel(3123, {
    ...deps(events),
    spawnCloudflared: (args) => {
      spawns++;
      const child = new FakeCloudflared(args);
      setImmediate(() => {
        if (spawns === 1) {
          child.say('2026-11-09T00:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests\n');
          child.crash(1);
        } else {
          child.open('https://second-try.trycloudflare.com');
        }
      });
      return child as unknown as ChildProcess;
    },
  });
  assert.equal(tunnel.url, 'https://second-try.trycloudflare.com');
  assert.equal(events[0]?.kind, 'retrying');
  assert.match((events[0] as { reason: string }).reason, /429 Too Many Requests/);
  tunnel.close();
});

test('gives up after three tries, with the last reason', async () => {
  let spawns = 0;
  await assert.rejects(
    () =>
      startDevTunnel(3123, {
        ...deps(),
        spawnCloudflared: (args) => {
          spawns++;
          const child = new FakeCloudflared(args);
          setImmediate(() => child.crash(1));
          return child as unknown as ChildProcess;
        },
      }),
    /cloudflared stopped \(exit code 1\)/,
  );
  assert.equal(spawns, 3);
});

test('a cloudflared that never connects is stopped and tried again', async () => {
  const spawned: FakeCloudflared[] = [];
  await assert.rejects(
    () =>
      startDevTunnel(3123, {
        ...deps(),
        startTimeoutMs: 10,
        startAttempts: 2,
        spawnCloudflared: (args) => {
          const child = new FakeCloudflared(args);
          spawned.push(child);
          return child as unknown as ChildProcess;
        },
      }),
    /didn't connect within/,
  );
  assert.equal(spawned.length, 2);
  assert.ok(spawned.every((child) => child.killed), 'a cloudflared that never started must not be left running');
});

test('waits for the connection to register and the name to be in DNS before giving out the address', async () => {
  let child: FakeCloudflared | undefined;
  const dnsLookups: string[] = [];
  let dnsReady: () => void = () => {};
  let settled = false;
  const pending = startDevTunnel(3123, {
    ...deps(),
    waitForDns: (hostname) => {
      dnsLookups.push(hostname);
      return new Promise((resolve) => {
        dnsReady = resolve;
      });
    },
    spawnCloudflared: (args) => {
      child = new FakeCloudflared(args);
      return child as unknown as ChildProcess;
    },
  });
  void pending.then(() => {
    settled = true;
  });
  await until(() => child !== undefined);
  child?.say('INF |  https://not-yet.trycloudflare.com  |\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'an address with no registered connection is not ready');
  assert.deepEqual(dnsLookups, []);
  child?.say('INF Registered tunnel connection connIndex=0\n');
  await until(() => dnsLookups.length === 1);
  assert.equal(dnsLookups[0], 'not-yet.trycloudflare.com');
  assert.equal(settled, false, 'not ready until the name is in DNS');
  dnsReady();
  const tunnel = await pending;
  assert.equal(tunnel.url, 'https://not-yet.trycloudflare.com');
  tunnel.close();
});

test('gives out the address anyway, saying so, when DNS is slow to have it', async () => {
  const events: DevTunnelEvent[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...deps(events),
    dnsTimeoutMs: 10,
    waitForDns: () => new Promise(() => {}),
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      setImmediate(() => child.open('https://slow-dns.trycloudflare.com'));
      return child as unknown as ChildProcess;
    },
  });
  assert.equal(tunnel.url, 'https://slow-dns.trycloudflare.com');
  assert.deepEqual(events, [{ kind: 'dns-slow', url: 'https://slow-dns.trycloudflare.com' }]);
  tunnel.close();
});

test('reopens a tunnel that stops unexpectedly, reporting the new address', async () => {
  const events: DevTunnelEvent[] = [];
  const spawned: FakeCloudflared[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...deps(events),
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      const n = spawned.push(child);
      setImmediate(() => child.open(`https://tunnel-number-${n}.trycloudflare.com`));
      return child as unknown as ChildProcess;
    },
  });
  assert.equal(tunnel.url, 'https://tunnel-number-1.trycloudflare.com');
  spawned[0]?.crash();
  await until(() => tunnel.url === 'https://tunnel-number-2.trycloudflare.com');
  assert.deepEqual(events, [
    { kind: 'dropped' },
    { kind: 'reopened', url: 'https://tunnel-number-2.trycloudflare.com', changed: true },
  ]);
  tunnel.close();
  assert.equal(spawned[1]?.killed, true, 'closing must stop the reopened cloudflared');
});

test('closing the tunnel on shutdown is never reported as a drop', async () => {
  const events: DevTunnelEvent[] = [];
  let spawnCount = 0;
  const tunnel = await startDevTunnel(3123, {
    ...deps(events),
    spawnCloudflared: (args) => {
      spawnCount++;
      const child = new FakeCloudflared(args);
      setImmediate(() => child.open('https://only-one.trycloudflare.com'));
      return child as unknown as ChildProcess;
    },
  });
  tunnel.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawnCount, 1);
  assert.deepEqual(events, []);
});

test('gives up reopening, saying so, after the attempts run out', async () => {
  const events: DevTunnelEvent[] = [];
  let spawnCount = 0;
  const tunnel = await startDevTunnel(3123, {
    ...deps(events),
    maxReopenAttempts: 2,
    spawnCloudflared: (args) => {
      spawnCount++;
      const child = new FakeCloudflared(args);
      setImmediate(() => (spawnCount === 1 ? child.open('https://first.trycloudflare.com') : child.crash(1)));
      if (spawnCount === 1) {
        setTimeout(() => child.crash(1), 5);
      }
      return child as unknown as ChildProcess;
    },
  });
  await until(() => events.some((event) => event.kind === 'gave-up'));
  assert.equal(spawnCount, 3, 'one original start plus two reopen attempts');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['dropped', 'reopen-failed', 'reopen-failed', 'gave-up'],
  );
  tunnel.close();
});
