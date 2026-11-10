import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadSiteConfig } from '../config.ts';
import { readAgentVersion } from '../routes/capabilities.ts';
import { loadServerConfig } from '../server-config.ts';
import { startDevTunnel, type DevTunnel, type DevTunnelDeps } from '../services/dev-tunnel.ts';
import { isPortFree, nextFreePort } from '../services/free-port.ts';
import { createLocalEditKey, DEV_CHILD_ENV, LOCAL_EDIT_KEY_ENV, localEditLink } from '../services/local-edit-link.ts';
import { isProcessAlive, readPidFile } from '../services/pid-file.ts';
import { createSiteConsole, type SiteConsole, type SiteConsoleStreams } from '../terminal/site-console.ts';
import { openInBrowser, type Shortcut } from '../terminal/shortcuts.ts';

// npm run dev: the one command for working on a site.
//
// It runs the site (vhost/server.js) as a child process and restarts it
// whenever a file under theme/ changes; content needs no restart, it's
// read fresh on every request. It asks whether to open a Cloudflare
// tunnel, so the site can be edited in Minamo while it runs, and prints
// the Edit in Minamo link.
//
// The tunnel, the key in that link and the keyboard shortcuts belong to
// this process, not the site, so they outlive every restart: the
// address and link stay the same all session, and an editor already open
// carries on. (Restarting with `node --watch` instead would close the
// tunnel on every theme save and open a new one at a new address.)
//
// npm start is untouched: it's what live hosting runs, where a tunnel
// would expose the site at a second address and put the key in the
// host's logs.

export interface DevSiteDeps {
  // vhost/, where npm runs this; the site root is one level up.
  vhostDir: string;
  argv: string[];
  streams?: SiteConsoleStreams;
  env?: NodeJS.ProcessEnv;
  // Whether a person is there to answer the question. Defaults to stdin
  // and stdout both being a terminal.
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  spawnSite?: (env: NodeJS.ProcessEnv) => ChildProcess;
  startTunnel?: (port: number, deps: Pick<DevTunnelDeps, 'report'>) => Promise<DevTunnel>;
  // Calls onChange for every change under dir; returns how to stop.
  watchTheme?: (dir: string, onChange: (file: string) => void) => () => void;
  // Restarts wait this long after the last change, so saving several
  // files at once restarts once.
  debounceMs?: number;
  // How long a stopping site gets before it's ended outright.
  stopTimeoutMs?: number;
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface DevSession {
  restart(reason?: string): Promise<void>;
  stop(): Promise<void>;
  // Resolves with the exit code once everything has stopped.
  done: Promise<number>;
}

interface ReadyMessage {
  type: 'minamo-site-ready';
  port: number;
}

function isReady(message: unknown): message is ReadyMessage {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'minamo-site-ready';
}

function defaultWatchTheme(dir: string, onChange: (file: string) => void): () => void {
  const watcher = watch(dir, { recursive: true }, (_event, file) => {
    const name = file ? basename(file.toString()) : '';
    // Editors' own temporary and lock files aren't theme changes.
    if (name.startsWith('.') || name.endsWith('~') || name.endsWith('.swp')) {
      return;
    }
    onChange(file ? file.toString() : '');
  });
  return () => watcher.close();
}

async function defaultAsk(question: string): Promise<string> {
  const { createPrompter } = await import('../site-sync/prompts.ts');
  return createPrompter(process.stdin, process.stdout).ask(question);
}

// Whether to open the tunnel: --tunnel or --local decide it outright (for
// scripts); otherwise asked, Yes by default; with no one to ask, local.
async function chooseTunnel(deps: DevSiteDeps, terminal: SiteConsole, interactive: boolean): Promise<boolean> {
  if (deps.argv.includes('--tunnel')) {
    return true;
  }
  if (deps.argv.includes('--local')) {
    return false;
  }
  if (!interactive) {
    terminal.out.info('Running without a tunnel (there is no terminal to ask). Use --tunnel to open one.');
    return false;
  }
  const out = terminal.out;
  const answer = await (deps.ask ?? defaultAsk)(
    ` ${out.style('?', 'cyan', 'bold')} ${out.style('Edit this site in Minamo while it runs?', 'bold')} ${out.style('This opens a public tunnel to it. (Y/n)', 'dim')} `,
  );
  return !/^\s*n/i.test(answer);
}

// The site's own port, or, when something else already has it, the next
// free one for this session only: two sites made before each got a port of
// its own both use 3000, and that shouldn't stop working on one of them.
// Not when it's this same site already running (npm start in another
// terminal, say): a second copy would only confuse, so the site's own
// "already running" message stands. npm start never does this.
async function portForSession(siteRoot: string, port: number, terminal: SiteConsole, free: (port: number) => Promise<boolean>): Promise<number> {
  if (await free(port)) {
    return port;
  }
  const running = readPidFile(loadSiteConfig(siteRoot));
  if (running && running.port === port && isProcessAlive(running.pid)) {
    return port;
  }
  const next = await nextFreePort(port, { isFree: free });
  if (next === null) {
    return port;
  }
  terminal.out.info(`Port ${port} is in use, so the site runs on ${next} this time. To keep it there, set "port" in vhost/site.config.json.`);
  return next;
}

export async function runDevSite(deps: DevSiteDeps): Promise<DevSession> {
  const vhostDir = deps.vhostDir;
  const siteRoot = resolve(vhostDir, '..');
  const env = deps.env ?? process.env;
  const terminal = createSiteConsole(deps.streams);
  const interactive = deps.interactive ?? (process.stdin.isTTY === true && terminal.out.fancy);
  const debounceMs = deps.debounceMs ?? 150;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;

  terminal.starting(siteRoot, readAgentVersion());
  const serverConfig = loadServerConfig(siteRoot);
  const wantsTunnel = await chooseTunnel(deps, terminal, interactive);
  const localEdit = wantsTunnel && serverConfig.adminBaseUrl ? createLocalEditKey() : undefined;

  const childEnv: NodeJS.ProcessEnv = { ...env, [DEV_CHILD_ENV]: '1' };
  const sessionPort = await portForSession(siteRoot, serverConfig.port, terminal, deps.isPortFree ?? isPortFree);
  if (sessionPort !== serverConfig.port) {
    childEnv.PORT = String(sessionPort);
  }
  if (localEdit) {
    childEnv[LOCAL_EDIT_KEY_ENV] = localEdit.key;
  }
  const spawnSite =
    deps.spawnSite ??
    ((spawnEnv: NodeJS.ProcessEnv) =>
      spawn(process.execPath, [join(vhostDir, 'server.js')], { cwd: vhostDir, env: spawnEnv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));

  let child: ChildProcess | undefined;
  let stopping = false;
  let restarting = false;
  let restartAgain = false;
  let tunnel: DevTunnel | undefined;
  let editLink: string | undefined;
  let stopWatching: (() => void) | undefined;
  let finish: (code: number) => void = () => {};
  const done = new Promise<number>((resolveDone) => {
    finish = resolveDone;
  });

  function exited(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolveExit) => proc.once('exit', () => resolveExit()));
  }

  // Starts the site; resolves with its port once it says it's up, or null
  // if it ends first (its own output says why).
  function startSite(): Promise<number | null> {
    const proc = spawnSite(childEnv);
    child = proc;
    return new Promise((resolveStart) => {
      let ready = false;
      proc.on('message', (message: unknown) => {
        if (isReady(message) && !ready) {
          ready = true;
          resolveStart(message.port);
        }
      });
      proc.once('exit', (code, signal) => {
        // Its exit put the shared terminal back as it found it.
        terminal.keysAgain();
        if (!ready) {
          resolveStart(null);
          return;
        }
        if (proc !== child || stopping || restarting) {
          return;
        }
        child = undefined;
        // Ended cleanly by someone else (npm run stop, or Ctrl+C reaching
        // it first): they meant to stop, so everything stops.
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
          void stop();
          return;
        }
        terminal.err.error(
          `The site stopped (exit code ${code ?? signal ?? 'none'}).`,
          `Fix the problem above. It starts again when the theme changes${terminal.out.fancy ? ', or press r' : ''}.`,
        );
      });
    });
  }

  async function stopSite(): Promise<void> {
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), stopTimeoutMs);
    await exited(proc);
    clearTimeout(timer);
  }

  async function restart(reason = 'Restarting the site'): Promise<void> {
    if (stopping) {
      return;
    }
    if (restarting) {
      restartAgain = true;
      return;
    }
    restarting = true;
    const spinner = terminal.out.spinner(reason);
    await stopSite();
    const port = stopping ? null : await startSite();
    restarting = false;
    if (port === null) {
      spinner.stop();
      if (!stopping) {
        terminal.err.error('The site failed to start.', `Fix the problem above. It starts again when the theme changes${terminal.out.fancy ? ', or press r' : ''}.`);
      }
    } else {
      spinner.succeed('Restarted the site');
    }
    if (restartAgain && !stopping) {
      restartAgain = false;
      await restart(reason);
    }
  }

  async function stop(code = 0): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    stopWatching?.();
    tunnel?.close();
    terminal.stopping();
    await stopSite();
    finish(code);
  }

  const port = await startSite();
  if (port === null) {
    // It couldn't start at all (the port in use, say): its output says
    // why, and there's nothing to keep running.
    stopping = true;
    finish(1);
    return { restart, stop, done };
  }
  const localUrl = `http://127.0.0.1:${port}`;
  terminal.running(localUrl);

  // Watching starts as soon as the site is up: opening the tunnel can
  // take a while, and a theme change meanwhile mustn't be missed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    stopWatching = (deps.watchTheme ?? defaultWatchTheme)(join(siteRoot, 'theme'), () => {
      clearTimeout(timer);
      timer = setTimeout(() => void restart('Theme changed. Restarting the site'), debounceMs);
    });
  } catch (error) {
    terminal.err.warn(
      "Couldn't watch theme/ for changes, so the site won't restart by itself.",
      error instanceof Error ? error.message : String(error),
    );
  }
  const unwatch = stopWatching;
  stopWatching = () => {
    clearTimeout(timer);
    unwatch?.();
  };

  if (wantsTunnel) {
    let opened = false;
    const opening = terminal.openingTunnel();
    const linkFor = (url: string): string | undefined =>
      localEdit && serverConfig.adminBaseUrl ? localEditLink(serverConfig.adminBaseUrl, url, localEdit.key) : undefined;
    try {
      tunnel = await (deps.startTunnel ?? startDevTunnel)(port, {
        report: (event) => {
          if (!opened) {
            opening.event(event);
            return;
          }
          terminal.tunnelEvent(event);
          // A new address means a new link (with the same key).
          if (event.kind === 'reopened' && event.changed) {
            editLink = linkFor(event.url);
            if (editLink) {
              terminal.editLink(editLink, true);
            }
          }
        },
      });
      opened = true;
      if (stopping) {
        tunnel.close();
      } else {
        opening.opened(tunnel.url);
        editLink = linkFor(tunnel.url);
        if (editLink) {
          terminal.editLink(editLink);
        }
      }
    } catch (error) {
      // The site itself is up and serving locally: a failed tunnel is
      // never a reason to stop it.
      opening.failed(error);
    }
  }

  const shortcuts: Shortcut[] = [
    ...(editLink ? [{ key: 'e', label: 'open editor', run: () => editLink && openInBrowser(editLink) }] : []),
    { key: 'o', label: 'open site', run: () => openInBrowser(localUrl) },
    { key: 'r', label: 'restart', run: () => void restart() },
    { key: 'q', label: 'stop' },
  ];
  // q and Ctrl+C stop it here, directly, rather than as a Ctrl+C to the
  // whole process group: npm then waits for the site to finish stopping
  // and exits cleanly, instead of returning to the prompt part way.
  terminal.listen(shortcuts, () => void stop());
  if (!terminal.out.fancy) {
    terminal.out.line('Restarts when a file under theme/ changes.');
  }

  return { restart, stop, done };
}
