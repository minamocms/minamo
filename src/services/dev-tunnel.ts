import { spawn, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';

// The dev tunnel (`npm run tunnel`): Cloudflare's free "quick tunnel",
// through the `cloudflared` program (brew install cloudflared; no
// Cloudflare account needed). It's a separate program the developer
// installs, not an npm dependency, so nothing extra ships in this
// package.
//
// There is deliberately no fallback. localtunnel was one until 0.14.0,
// and was dropped: it was slow (measured from Sydney, about 1.3s a page
// against 0.1s, and 11s for a page with its images against 0.3s), it
// dropped most images, and its "click to continue" reminder page broke
// the admin's preview for anyone who hadn't clicked through it. A
// tunnel that looks open but shows a broken page is worse than a clear
// message saying what to install.
//
// A dropped tunnel is reported and reopened rather than failing
// silently (an unnoticed drop otherwise shows up in the admin only as a
// page that never loads).

export interface DevTunnel {
  // The current public address: reopening a dropped tunnel changes it.
  readonly url: string;
  close: () => void;
}

// What happens to a tunnel after it opens (and on the way), for whoever
// started it to show.
export type DevTunnelEvent =
  | { kind: 'retrying'; attempt: number; attempts: number; reason: string }
  | { kind: 'dns-slow'; url: string }
  | { kind: 'dropped' }
  | { kind: 'reopened'; url: string; changed: boolean }
  | { kind: 'reopen-failed'; attempt: number; attempts: number; reason: string }
  | { kind: 'gave-up' };

export interface DevTunnelDeps {
  spawnCloudflared?: (args: string[]) => ChildProcess;
  report?: (event: DevTunnelEvent) => void;
  // Resolves once the new address can be looked up. Defaults to asking
  // public DNS until it can.
  waitForDns?: (hostname: string, signal: AbortSignal) => Promise<void>;
  // How long to wait for cloudflared to connect.
  startTimeoutMs?: number;
  // How long to wait, once connected, for the address to be in DNS
  // before giving it out anyway.
  dnsTimeoutMs?: number;
  // Tries at opening it before giving up, and the pause between them.
  startAttempts?: number;
  retryDelayMs?: number;
  // Pause before reopening a dropped tunnel.
  reopenDelayMs?: number;
  // Give up after this many reopen attempts in a row fail.
  maxReopenAttempts?: number;
}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const CONNECTION_REGISTERED = /Registered tunnel connection/;

export class CloudflaredNotInstalledError extends Error {
  constructor() {
    super('cloudflared is not installed');
    this.name = 'CloudflaredNotInstalledError';
  }
}

// How to install cloudflared on the computer this runs on.
export function cloudflaredInstallCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'brew install cloudflared';
  }
  if (platform === 'win32') {
    return 'winget install --id Cloudflare.cloudflared';
  }
  return 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

function defaultSpawnCloudflared(args: string[]): ChildProcess {
  return spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// cloudflared prints its new address a few seconds before that name
// exists in DNS. Looking it up too early (opening it in a browser, or
// fetching it) gets "not found", which the computer then remembers for a
// while, so the tunnel looks broken. Asking public DNS directly until the
// name exists, before giving it out, avoids that.
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

function defaultReport(event: DevTunnelEvent): void {
  switch (event.kind) {
    case 'retrying':
      console.warn(`Couldn't open the tunnel (${event.reason}). Trying again (${event.attempt} of ${event.attempts})...`);
      break;
    case 'dns-slow':
      console.warn('The tunnel is open, but its address is slow to appear in DNS, so it may take a minute to load.');
      break;
    case 'dropped':
      console.warn('The tunnel dropped. Reopening it...');
      break;
    case 'reopened':
      console.log(event.changed ? `Tunnel open again, at a new address: ${event.url}` : `Tunnel open again: ${event.url}`);
      break;
    case 'reopen-failed':
      console.warn(`Couldn't reopen the tunnel (attempt ${event.attempt} of ${event.attempts}): ${event.reason}`);
      break;
    case 'gave-up':
      console.warn('Gave up reopening the tunnel. The site is still running locally; restart it to try again.');
      break;
  }
}

interface Settings {
  spawnCloudflared: (args: string[]) => ChildProcess;
  report: (event: DevTunnelEvent) => void;
  waitForDns: (hostname: string, signal: AbortSignal) => Promise<void>;
  startTimeoutMs: number;
  dnsTimeoutMs: number;
  startAttempts: number;
  retryDelayMs: number;
  reopenDelayMs: number;
  maxReopenAttempts: number;
}

function settingsFrom(deps: DevTunnelDeps): Settings {
  return {
    spawnCloudflared: deps.spawnCloudflared ?? defaultSpawnCloudflared,
    report: deps.report ?? defaultReport,
    waitForDns: deps.waitForDns ?? defaultWaitForDns,
    startTimeoutMs: deps.startTimeoutMs ?? 30_000,
    dnsTimeoutMs: deps.dnsTimeoutMs ?? 20_000,
    startAttempts: deps.startAttempts ?? 3,
    retryDelayMs: deps.retryDelayMs ?? 3_000,
    reopenDelayMs: deps.reopenDelayMs ?? 2_000,
    maxReopenAttempts: deps.maxReopenAttempts ?? 5,
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Starts one cloudflared quick tunnel and resolves with its address once
// it's ready: cloudflared has printed the address and registered its
// connection, and the name is in DNS (or dnsTimeoutMs has passed).
// onExit fires if the process ends after that.
function runCloudflared(port: number, settings: Settings, onExit: () => void): Promise<{ url: string; stop: () => void }> {
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
      fail(new Error(`it didn't connect within ${Math.round(settings.startTimeoutMs / 1000)} seconds`));
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
        // Connected, so it works: a slow DNS answer is no reason to give
        // up on it, only to say it may take a moment.
        const dnsTimer = setTimeout(() => {
          dnsWait.abort();
          settings.report({ kind: 'dns-slow', url: readyUrl });
          ready(readyUrl);
        }, settings.dnsTimeoutMs);
        settings.waitForDns(new URL(readyUrl).hostname, dnsWait.signal).then(
          () => {
            clearTimeout(dnsTimer);
            ready(readyUrl);
          },
          (error: unknown) => {
            clearTimeout(dnsTimer);
            fail(error instanceof Error ? error : new Error(String(error)));
          },
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
        const lastLine =
          output
            .trim()
            .split('\n')
            .at(-1)
            ?.replace(/^\S+\s+(INF|ERR|WRN)\s+/, '') ?? '';
        fail(new Error(`cloudflared stopped (exit code ${code ?? 'none'})${lastLine ? `: ${lastLine}` : ''}`));
        return;
      }
      if (!stopping) {
        onExit();
      }
    });
  });
}

export async function startDevTunnel(port: number, deps: DevTunnelDeps = {}): Promise<DevTunnel> {
  const settings = settingsFrom(deps);
  let closed = false;
  let reopening = false;
  let current: { url: string; stop: () => void } | undefined;

  const open = (): Promise<{ url: string; stop: () => void }> => runCloudflared(port, settings, dropped);

  async function reopen(): Promise<void> {
    if (closed || reopening || !current) {
      return;
    }
    reopening = true;
    const previousUrl = current.url;
    settings.report({ kind: 'dropped' });
    for (let attempt = 1; attempt <= settings.maxReopenAttempts && !closed; attempt++) {
      await delay(settings.reopenDelayMs * attempt);
      if (closed) {
        break;
      }
      try {
        current = await open();
        reopening = false;
        if (closed) {
          current.stop();
          return;
        }
        settings.report({ kind: 'reopened', url: current.url, changed: current.url !== previousUrl });
        return;
      } catch (error) {
        if (error instanceof CloudflaredNotInstalledError) {
          break;
        }
        settings.report({ kind: 'reopen-failed', attempt, attempts: settings.maxReopenAttempts, reason: messageOf(error) });
      }
    }
    reopening = false;
    if (!closed) {
      settings.report({ kind: 'gave-up' });
    }
  }

  function dropped(): void {
    void reopen();
  }

  // Opening: a quick tunnel occasionally isn't handed out at the first
  // ask, so a couple more tries before giving up. Not installed is never
  // worth retrying.
  for (let attempt = 1; ; attempt++) {
    try {
      current = await open();
      break;
    } catch (error) {
      if (error instanceof CloudflaredNotInstalledError || attempt >= settings.startAttempts) {
        throw error;
      }
      settings.report({ kind: 'retrying', attempt: attempt + 1, attempts: settings.startAttempts, reason: messageOf(error) });
      await delay(settings.retryDelayMs);
    }
  }

  const opened = current;
  return {
    get url() {
      return (current ?? opened).url;
    },
    close: () => {
      closed = true;
      (current ?? opened).stop();
    },
  };
}
