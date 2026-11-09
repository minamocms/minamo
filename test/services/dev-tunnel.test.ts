import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { startDevTunnel, type DevTunnelDeps, type LocaltunnelLike } from '../../src/services/dev-tunnel.ts';

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

class FakeLocaltunnel extends EventEmitter implements LocaltunnelLike {
  closed = false;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
}

function notInstalled(): ChildProcess {
  const error = Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' });
  const child = new FakeCloudflared([]);
  setImmediate(() => child.emit('error', error));
  return child as unknown as ChildProcess;
}

function quiet(lines: string[] = []): Pick<DevTunnelDeps, 'log' | 'warn' | 'waitForDns'> {
  return { log: (line) => lines.push(line), warn: (line) => lines.push(line), waitForDns: async () => {} };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'condition never became true');
};

test('uses a Cloudflare quick tunnel to the local site when cloudflared is installed', async () => {
  const spawned: FakeCloudflared[] = [];
  const pending = startDevTunnel(3123, {
    ...quiet(),
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      spawned.push(child);
      setImmediate(() => child.open('https://serum-inline-stand-bug.trycloudflare.com'));
      return child as unknown as ChildProcess;
    },
    openLocaltunnel: () => assert.fail('localtunnel must not be used when cloudflared works'),
  });
  const tunnel = await pending;
  assert.equal(tunnel.url, 'https://serum-inline-stand-bug.trycloudflare.com');
  assert.equal(tunnel.provider, 'cloudflared');
  assert.deepEqual(spawned[0]?.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3123']);
  tunnel.close();
  assert.equal(spawned[0]?.killed, true, 'closing the tunnel must stop cloudflared');
});

test('falls back to localtunnel, with a hint to install cloudflared, when cloudflared is not installed', async () => {
  const lines: string[] = [];
  const opened: FakeLocaltunnel[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    spawnCloudflared: notInstalled,
    openLocaltunnel: async () => {
      const lt = new FakeLocaltunnel('https://red-papers-lick.loca.lt');
      opened.push(lt);
      return lt;
    },
  });
  assert.equal(tunnel.url, 'https://red-papers-lick.loca.lt');
  assert.equal(tunnel.provider, 'localtunnel');
  assert.ok(lines.some((line) => line.includes('brew install cloudflared')));
  tunnel.close();
  assert.equal(opened[0]?.closed, true);
});

test('falls back to localtunnel when cloudflared exits before opening a tunnel', async () => {
  const lines: string[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      setImmediate(() => {
        child.say('ERR failed to request quick Tunnel\n');
        child.crash(1);
      });
      return child as unknown as ChildProcess;
    },
    openLocaltunnel: async () => new FakeLocaltunnel('https://red-papers-lick.loca.lt'),
  });
  assert.equal(tunnel.provider, 'localtunnel');
  assert.ok(lines.some((line) => line.includes("Couldn't open a Cloudflare tunnel") && line.includes('failed to request quick Tunnel')));
  tunnel.close();
});

test('falls back to localtunnel when cloudflared never reports an address', async () => {
  const spawned: FakeCloudflared[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...quiet(),
    startTimeoutMs: 20,
    spawnCloudflared: (args) => {
      const child = new FakeCloudflared(args);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    openLocaltunnel: async () => new FakeLocaltunnel('https://red-papers-lick.loca.lt'),
  });
  assert.equal(tunnel.provider, 'localtunnel');
  assert.equal(spawned[0]?.killed, true, 'a cloudflared that never started must not be left running');
  tunnel.close();
});

test('reopens a Cloudflare tunnel that stops unexpectedly and says the address changed', async () => {
  const lines: string[] = [];
  const spawned: FakeCloudflared[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    reopenDelayMs: 1,
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
  assert.ok(lines.some((line) => line.includes('The tunnel dropped')));
  assert.ok(lines.some((line) => line.includes('new address') && line.includes('tunnel-number-2')));
  assert.ok(lines.some((line) => line.includes('update this website') && line.includes('admin')));
  tunnel.close();
  assert.equal(spawned[1]?.killed, true, 'closing must stop the reopened cloudflared');
});

test('reopens a dropped localtunnel, asking for the same address back', async () => {
  const lines: string[] = [];
  const requests: { port: number; subdomain?: string }[] = [];
  const opened: FakeLocaltunnel[] = [];
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    reopenDelayMs: 1,
    spawnCloudflared: notInstalled,
    openLocaltunnel: async (options) => {
      requests.push(options);
      const lt = new FakeLocaltunnel(`https://${options.subdomain ?? 'red-papers-lick'}.loca.lt`);
      opened.push(lt);
      return lt;
    },
  });
  opened[0]?.emit('error', new Error('connection refused: localtunnel.me:12345'));
  await until(() => opened.length === 2);
  assert.deepEqual(requests[1], { port: 3123, subdomain: 'red-papers-lick' });
  await until(() => lines.some((line) => line.startsWith('Tunnel open again: https://red-papers-lick.loca.lt')));
  tunnel.close();
  assert.equal(opened[1]?.closed, true);
});

test('closing the tunnel on shutdown is never reported as a drop', async () => {
  const lines: string[] = [];
  let spawnCount = 0;
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    reopenDelayMs: 1,
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
  assert.ok(!lines.some((line) => line.includes('dropped')));
});

test('gives up, saying so, after the reopen attempts run out', async () => {
  const lines: string[] = [];
  let spawnCount = 0;
  const tunnel = await startDevTunnel(3123, {
    ...quiet(lines),
    reopenDelayMs: 1,
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
  await until(() => lines.some((line) => line.includes('Gave up reopening the tunnel')));
  assert.equal(spawnCount, 3, 'one original start plus two reopen attempts');
  tunnel.close();
});

test('waits for the connection to register and the name to be in DNS before giving out the address', async () => {
  let child: FakeCloudflared | undefined;
  const dnsLookups: string[] = [];
  let dnsReady: () => void = () => {};
  let settled = false;
  const pending = startDevTunnel(3123, {
    ...quiet(),
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
