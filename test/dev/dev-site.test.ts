import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { runDevSite, type DevSiteDeps } from '../../src/dev/dev-site.ts';
import type { DevTunnelEvent } from '../../src/services/dev-tunnel.ts';
import { createTmpSiteRoot, writeJson } from '../helpers/tmp-site.ts';
import { loadSiteConfig } from '../../src/config.ts';
import { writePidFile } from '../../src/services/pid-file.ts';
import { captureOutput } from '../helpers/capture-output.ts';

// A stand-in for the site (vhost/server.js) as npm run dev runs it: it
// reports ready on its port, and ends when asked.
class FakeSite extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv, port: number | null) {
    super();
    this.env = env;
    if (port !== null) {
      // The real site listens on PORT when it's set (npm run dev moving it
      // off a taken port), else on its configured one.
      const listening = env.PORT ? Number(env.PORT) : port;
      setImmediate(() => this.emit('message', { type: 'minamo-site-ready', port: listening }));
    } else {
      setImmediate(() => this.end(1, null));
    }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    setImmediate(() => this.end(null, signal));
    return true;
  }
  end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function setUp(options: { adminBaseUrl?: string | false; failToStart?: boolean } = {}) {
  const { siteRoot, cleanup } = createTmpSiteRoot({ git: true, contentDirs: true });
  writeJson(siteRoot, 'vhost/site.config.json', { port: 4123, ...(options.adminBaseUrl !== undefined ? { adminBaseUrl: options.adminBaseUrl } : {}) });
  const sites: FakeSite[] = [];
  const tunnels: Array<{ port: number; closed: boolean; report: (event: DevTunnelEvent) => void }> = [];
  let themeChanged: (file: string) => void = () => {};
  let watching = false;
  const captured = captureOutput();
  const deps = (more: Partial<DevSiteDeps> = {}): DevSiteDeps => ({
    vhostDir: `${siteRoot}/vhost`,
    argv: [],
    streams: captured.output,
    env: {},
    interactive: false,
    debounceMs: 1,
    isPortFree: async () => true,
    spawnSite: (env) => {
      const site = new FakeSite(env, options.failToStart ? null : 4123);
      sites.push(site);
      return site as unknown as ChildProcess;
    },
    startTunnel: async (port, tunnelDeps) => {
      const tunnel = { port, closed: false, report: tunnelDeps.report ?? (() => {}) };
      tunnels.push(tunnel);
      return {
        url: 'https://some-words.trycloudflare.com',
        close: () => {
          tunnel.closed = true;
        },
      };
    },
    watchTheme: (_dir, onChange) => {
      watching = true;
      themeChanged = onChange;
      return () => {
        watching = false;
      };
    },
    ...more,
  });
  return {
    deps,
    sites,
    tunnels,
    captured,
    changeTheme: (file = 'sections/hero.liquid') => themeChanged(file),
    isWatching: () => watching,
    siteRoot,
    cleanup,
  };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), 'condition never became true');
};

test('asks whether to open the tunnel, and a Yes (the default) opens it and prints the Edit in Minamo link', async () => {
  const setup = setUp();
  try {
    const questions: string[] = [];
    const session = await runDevSite(setup.deps({ interactive: true, ask: async (question) => (questions.push(question), '') }));
    assert.equal(questions.length, 1);
    assert.match(questions[0] ?? '', /Edit this site in Minamo while it runs\?.*\(Y\/n\)/);
    assert.deepEqual(setup.tunnels.map((tunnel) => tunnel.port), [4123]);
    const link = setup.captured.stdout.find((line) => line.startsWith('Edit in Minamo: '));
    assert.ok(link, 'expected the Edit in Minamo link');
    const fragment = new URLSearchParams(new URL(link.slice('Edit in Minamo: '.length)).hash.slice(1));
    assert.equal(fragment.get('site'), 'https://some-words.trycloudflare.com');
    assert.equal(fragment.get('key'), setup.sites[0]?.env.MINAMO_LOCAL_EDIT_KEY, 'the site accepts the key in the link');
    assert.equal(setup.sites[0]?.env.MINAMO_DEV_CHILD, '1');
    await session.stop();
    assert.equal(setup.tunnels[0]?.closed, true);
  } finally {
    setup.cleanup();
  }
});

test('a No runs it locally: no tunnel, no key', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ interactive: true, ask: async () => 'n' }));
    assert.equal(setup.tunnels.length, 0);
    assert.equal(setup.sites[0]?.env.MINAMO_LOCAL_EDIT_KEY, undefined);
    assert.ok(setup.captured.stdout.includes('Site running at http://127.0.0.1:4123'));
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('--tunnel and --local decide without asking, and with no one to ask it runs locally', async () => {
  for (const [argv, tunnels] of [[['--tunnel'], 1], [['--local'], 0], [[], 0]] as const) {
    const setup = setUp();
    try {
      const session = await runDevSite(
        setup.deps({ argv: [...argv], interactive: argv.length === 0 ? false : true, ask: async () => assert.fail('must not ask') }),
      );
      assert.equal(setup.tunnels.length, tunnels, `with ${argv.join(' ') || 'no terminal'}`);
      await session.stop();
    } finally {
      setup.cleanup();
    }
  }
});

test('a theme change restarts the site, keeping the tunnel and the key', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'] }));
    setup.changeTheme();
    setup.changeTheme('layouts/theme.liquid');
    await until(() => setup.sites.length === 2 && setup.captured.stdout.includes('Restarted the site'));
    assert.equal(setup.sites[0]?.signalCode, 'SIGTERM', 'the old site was stopped first');
    assert.equal(setup.tunnels.length, 1, 'the same tunnel throughout');
    assert.equal(setup.tunnels[0]?.closed, false);
    assert.equal(setup.sites[1]?.env.MINAMO_LOCAL_EDIT_KEY, setup.sites[0]?.env.MINAMO_LOCAL_EDIT_KEY, 'the same key, so the link still works');
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('the site crashing is reported, and the next theme change starts it again', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps());
    setup.sites[0]?.end(1, null);
    await until(() => setup.captured.stderr.some((line) => line.includes('The site stopped (exit code 1).')));
    setup.changeTheme();
    await until(() => setup.sites.length === 2 && setup.captured.stdout.includes('Restarted the site'));
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('the site stopped cleanly from elsewhere (npm run stop) stops everything', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'] }));
    setup.sites[0]?.end(null, 'SIGTERM');
    assert.equal(await session.done, 0);
    assert.equal(setup.tunnels[0]?.closed, true);
    assert.equal(setup.isWatching(), false);
  } finally {
    setup.cleanup();
  }
});

test('a site that cannot start at all (its port in use, say) ends npm run dev with an error and no tunnel', async () => {
  const setup = setUp({ failToStart: true });
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'] }));
    assert.equal(await session.done, 1);
    assert.equal(setup.tunnels.length, 0);
  } finally {
    setup.cleanup();
  }
});

test('a reopened tunnel at a new address prints a new link with the same key', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'] }));
    setup.tunnels[0]?.report({ kind: 'reopened', url: 'https://new-words.trycloudflare.com', changed: true });
    const links = setup.captured.stdout
      .filter((line) => line.startsWith('Edit in Minamo: '))
      .map((line) => new URLSearchParams(new URL(line.slice('Edit in Minamo: '.length)).hash.slice(1)));
    assert.deepEqual(links.map((fragment) => fragment.get('site')), ['https://some-words.trycloudflare.com', 'https://new-words.trycloudflare.com']);
    assert.equal(links[0]?.get('key'), links[1]?.get('key'));
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('with "adminBaseUrl": false the tunnel opens but there is no link and no key', async () => {
  const setup = setUp({ adminBaseUrl: false });
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'] }));
    assert.equal(setup.tunnels.length, 1);
    assert.ok(!setup.captured.stdout.some((line) => line.includes('Edit in Minamo')));
    assert.equal(setup.sites[0]?.env.MINAMO_LOCAL_EDIT_KEY, undefined);
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('a tunnel that fails to open leaves the site running locally', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(
      setup.deps({
        argv: ['--tunnel'],
        startTunnel: async () => {
          throw new Error('cloudflared stopped (exit code 1)');
        },
      }),
    );
    assert.ok(setup.captured.stderr.some((line) => line.includes("Couldn't open a tunnel")));
    assert.equal(setup.sites[0]?.exitCode, null, 'the site is still running');
    await session.stop();
    assert.equal(setup.sites[0]?.signalCode, 'SIGTERM');
  } finally {
    setup.cleanup();
  }
});

test('when something else has the site\'s port, npm run dev runs it on the next free one this time, and says so', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ argv: ['--tunnel'], isPortFree: async (port) => port !== 4123 && port !== 4124 }));
    assert.equal(setup.sites[0]?.env.PORT, '4125');
    assert.deepEqual(setup.tunnels.map((tunnel) => tunnel.port), [4125], 'the tunnel follows the port the site really got');
    assert.ok(setup.captured.stdout.some((line) => line.includes('Port 4123 is in use, so the site runs on 4125 this time')));

    // A restart keeps the same port for the rest of the session.
    await session.restart();
    assert.equal(setup.sites[1]?.env.PORT, '4125');
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('when the port is free, npm run dev leaves PORT alone', async () => {
  const setup = setUp();
  try {
    const session = await runDevSite(setup.deps({ argv: ['--local'] }));
    assert.equal(setup.sites[0]?.env.PORT, undefined);
    await session.stop();
  } finally {
    setup.cleanup();
  }
});

test('when it is this same site that has the port (already running), npm run dev does not start a second copy elsewhere', async () => {
  const setup = setUp();
  try {
    // This test's own process stands in for the copy already running.
    writePidFile(loadSiteConfig(setup.siteRoot), 4123);
    const session = await runDevSite(setup.deps({ argv: ['--local'], isPortFree: async (port) => port !== 4123 }));
    assert.equal(setup.sites[0]?.env.PORT, undefined, 'the site keeps its own port, and its own "already running" message');
    await session.stop();
  } finally {
    setup.cleanup();
  }
});
