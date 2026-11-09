import { spawn, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import localtunnel from 'localtunnel';

// Two ways to open the dev tunnel, tried in this order:
//
// 1. Cloudflare's free "quick tunnel", through the `cloudflared` program
//    when it's installed (brew install cloudflared). Much faster:
//    measured from Sydney, a page took about 0.1s through it against
//    1.3s through localtunnel, and a full page with its images about
//    0.3s against 11s, with localtunnel dropping most of the images.
//    It's a separate program the developer installs, not an npm
//    dependency, so nothing extra ships in this package.
// 2. localtunnel, the fallback when cloudflared isn't installed or won't
//    start.
//
// localtunnel pulls in an old axios version with known high-severity
// advisories (SSRF/prototype-pollution class issues, see `npm audit`).
// Accepted, not ignored: this is an opt-in, dev-only feature (never on
// the request-handling path), and axios here only ever talks to the
// hardcoded localtunnel.me registration endpoint, never
// attacker-controlled input.
//
// Either way a dropped tunnel is reported and reopened rather than
// failing silently (an unnoticed drop otherwise shows up in the admin
// only as a 503 or a page that never loads).

export type DevTunnelProvider = 'cloudflared' | 'localtunnel';

export interface DevTunnel {
  // The current public address: reopening a dropped tunnel can change it.
  readonly url: string;
  readonly provider?: DevTunnelProvider;
  close: () => void;
}

// The parts of a localtunnel Tunnel this module uses.
export interface LocaltunnelLike {
  url: string;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  close(): void;
}

export interface DevTunnelDeps {
  spawnCloudflared?: (args: string[]) => ChildProcess;
  openLocaltunnel?: (options: { port: number; subdomain?: string }) => Promise<LocaltunnelLike>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  // Resolves once the new address can be looked up. Defaults to asking
  // public DNS until it can.
  waitForDns?: (hostname: string, signal: AbortSignal) => Promise<void>;
  // How long to wait for cloudflared to be ready.
  startTimeoutMs?: number;
  // Pause before reopening a dropped tunnel.
  reopenDelayMs?: number;
  // Give up after this many reopen attempts in a row fail.
  maxReopenAttempts?: number;
  // Called when a reopened tunnel has a new address. Without it, a
  // reminder to update the website's address in the admin is printed.
  onAddressChange?: (url: string) => void;
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const CONNECTION_REGISTERED = /Registered tunnel connection/;

export class CloudflaredNotInstalledError extends Error {
  constructor() {
    super('cloudflared is not installed');
  }
}

function defaultSpawnCloudflared(args: string[]): ChildProcess {
  return spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// cloudflared prints its new address a few seconds before that name
// exists in DNS. Looking it up too early (opening it in a browser, or
// fetching it) gets "not found", which the computer then remembers for a
// while, so the tunnel looks broken. Asking public DNS directly until the
// name exists, before printing it, avoids that.
async function defaultWaitForDns(hostname: string, signal: AbortSignal): Promise<void> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  while (!signal.aborted) {
    try {
      await resolver.resolve4(hostname);
      return;
    } catch {
      await delay(1_000);
    }
  }
}

function defaultOpenLocaltunnel(options: { port: number; subdomain?: string }): Promise<LocaltunnelLike> {
  return localtunnel(options);
}

interface Settings {
  spawnCloudflared: (args: string[]) => ChildProcess;
  openLocaltunnel: (options: { port: number; subdomain?: string }) => Promise<LocaltunnelLike>;
  log: (line: string) => void;
  warn: (line: string) => void;
  waitForDns: (hostname: string, signal: AbortSignal) => Promise<void>;
  startTimeoutMs: number;
  reopenDelayMs: number;
  maxReopenAttempts: number;
  onAddressChange: ((url: string) => void) | undefined;
}

function settingsFrom(deps: DevTunnelDeps): Settings {
  return {
    spawnCloudflared: deps.spawnCloudflared ?? defaultSpawnCloudflared,
    openLocaltunnel: deps.openLocaltunnel ?? defaultOpenLocaltunnel,
    log: deps.log ?? ((line) => console.log(line)),
    warn: deps.warn ?? ((line) => console.warn(line)),
    waitForDns: deps.waitForDns ?? defaultWaitForDns,
    startTimeoutMs: deps.startTimeoutMs ?? 30_000,
    reopenDelayMs: deps.reopenDelayMs ?? 2_000,
    maxReopenAttempts: deps.maxReopenAttempts ?? 5,
    onAddressChange: deps.onAddressChange,
  };
}

// Starts one cloudflared quick tunnel and resolves with its address once
// it's ready: cloudflared has printed the address and registered its
// connection, and the name is in DNS. onExit fires if the process ends
// after that.
function runCloudflared(
  port: number,
  settings: Settings,
  onExit: () => void,
): Promise<{ url: string; stop: () => void }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = settings.spawnCloudflared(['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]);
    } catch (error) {
      reject(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? new CloudflaredNotInstalledError() : error);
      return;
    }

    let started = false;
    let stopping = false;
    let output = '';
    let url: string | undefined;
    let registered = false;
    const dnsWait = new AbortController();

    const timer = setTimeout(() => {
      fail(new Error(`cloudflared's tunnel wasn't ready within ${Math.round(settings.startTimeoutMs / 1000)} seconds`));
    }, settings.startTimeoutMs);

    function fail(error: Error): void {
      if (started) {
        return;
      }
      started = true;
      clearTimeout(timer);
      dnsWait.abort();
      stopping = true;
      child.kill();
      reject(error);
    }

    function ready(readyUrl: string): void {
      if (started) {
        return;
      }
      started = true;
      clearTimeout(timer);
      resolve({
        url: readyUrl,
        stop: () => {
          stopping = true;
          child.kill();
        },
      });
    }

    // cloudflared prints its address (and everything else) to stderr;
    // stdout is read too in case a future version moves it.
    function read(chunk: Buffer | string): void {
      if (started || registered) {
        return;
      }
      output = (output + chunk.toString()).slice(-8_192);
      url ??= QUICK_TUNNEL_URL.exec(output)?.[0];
      if (url && CONNECTION_REGISTERED.test(output)) {
        registered = true;
        const readyUrl = url;
        settings.waitForDns(new URL(readyUrl).hostname, dnsWait.signal).then(
          () => ready(readyUrl),
          (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
        );
      }
    }
    child.stderr?.on('data', read);
    child.stdout?.on('data', read);

    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT' ? new CloudflaredNotInstalledError() : error);
    });

    child.on('exit', (code) => {
      if (!started) {
        const lastLine = output.trim().split('\n').at(-1) ?? '';
        fail(new Error(`cloudflared stopped before opening a tunnel (exit code ${code ?? 'none'})${lastLine ? `: ${lastLine}` : ''}`));
        return;
      }
      if (!stopping) {
        onExit();
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Opens a tunnel through `open`, then reopens it whenever it drops
// (reported through the `dropped` callback open receives), until close().
async function keepOpen(
  provider: DevTunnelProvider,
  open: (dropped: () => void) => Promise<{ url: string; stop: () => void }>,
  settings: Settings,
): Promise<DevTunnel> {
  let closed = false;
  let reopening = false;
  let current: { url: string; stop: () => void };

  async function reopen(): Promise<void> {
    if (closed || reopening) {
      return;
    }
    reopening = true;
    const previousUrl = current.url;
    settings.warn('The tunnel dropped. Reopening it...');
    for (let attempt = 1; attempt <= settings.maxReopenAttempts && !closed; attempt++) {
      await delay(settings.reopenDelayMs * attempt);
      if (closed) {
        break;
      }
      try {
        current = await open(dropped);
        reopening = false;
        if (closed) {
          current.stop();
          return;
        }
        if (current.url === previousUrl) {
          settings.log(`Tunnel open again: ${current.url}`);
        } else {
          settings.log(`Tunnel open again, at a new address: ${current.url}`);
          if (settings.onAddressChange) {
            settings.onAddressChange(current.url);
          } else {
            settings.warn("The address has changed, so update this website's address in the admin (Settings) to the new one.");
          }
        }
        return;
      } catch (error) {
        settings.warn(`Couldn't reopen the tunnel (attempt ${attempt} of ${settings.maxReopenAttempts}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    reopening = false;
    if (!closed) {
      settings.warn('Gave up reopening the tunnel. The site is still running locally; restart it to try again.');
    }
  }

  function dropped(): void {
    void reopen();
  }

  current = await open(dropped);
  return {
    get url() {
      return current.url;
    },
    provider,
    close: () => {
      closed = true;
      current.stop();
    },
  };
}

async function startCloudflaredTunnel(port: number, settings: Settings): Promise<DevTunnel> {
  return keepOpen('cloudflared', (dropped) => runCloudflared(port, settings, dropped), settings);
}

async function startLocaltunnel(port: number, settings: Settings): Promise<DevTunnel> {
  let subdomain: string | undefined;
  return keepOpen(
    'localtunnel',
    async (dropped) => {
      // Asking for the same subdomain again keeps the address the same
      // after a drop, whenever localtunnel still has it free.
      const tunnel = await settings.openLocaltunnel(subdomain ? { port, subdomain } : { port });
      subdomain = new URL(tunnel.url).hostname.split('.')[0];
      let stopping = false;
      let reported = false;
      const report = (): void => {
        if (!stopping && !reported) {
          reported = true;
          dropped();
        }
      };
      // Without an error listener, a dropped localtunnel connection
      // throws and takes the whole site down with it.
      tunnel.on('error', report);
      tunnel.on('close', report);
      return {
        url: tunnel.url,
        stop: () => {
          stopping = true;
          tunnel.close();
        },
      };
    },
    settings,
  );
}

export async function startDevTunnel(port: number, deps: DevTunnelDeps = {}): Promise<DevTunnel> {
  const settings = settingsFrom(deps);
  try {
    return await startCloudflaredTunnel(port, settings);
  } catch (error) {
    if (error instanceof CloudflaredNotInstalledError) {
      settings.log('Using localtunnel, which is slow. For a much faster tunnel, install cloudflared (on a Mac: brew install cloudflared) and start again.');
    } else {
      settings.warn(`Couldn't open a Cloudflare tunnel (${error instanceof Error ? error.message : String(error)}), so using localtunnel instead.`);
    }
  }
  return startLocaltunnel(port, settings);
}
