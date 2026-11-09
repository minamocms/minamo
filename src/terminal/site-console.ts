import { basename } from 'node:path';
import { createUi, type Ui, type UiStream } from './ui.ts';
import { listenForShortcuts, type Shortcut, type ShortcutInput, type ShortcutListener } from './shortcuts.ts';
import { cloudflaredInstallCommand, CloudflaredNotInstalledError, type DevTunnelEvent } from '../services/dev-tunnel.ts';

// What a running site prints: on its own (npm start, and on live
// hosting), and under npm run dev (dev/dev-site.ts), which adds the
// tunnel, its Edit in Minamo link, restarts and keyboard shortcuts.
// Everything goes through ui.ts, so with no terminal (a host's logs)
// it's the same words as plain log lines.

export interface SiteConsoleStreams {
  stdout?: UiStream;
  stderr?: UiStream;
  stdin?: ShortcutInput;
}

export interface SiteConsoleOptions {
  // A site running under npm run dev: that prints the header, where it's
  // running and what to press, so the site itself only reports problems.
  quiet?: boolean;
}

export interface SiteConsole {
  out: Ui;
  err: Ui;
  starting(siteRoot: string, version: string): void;
  running(localUrl: string): void;
  themeWarning(message: string): void;
  devHint(): void;
  openingTunnel(): { event(event: DevTunnelEvent): void; opened(url: string): void; failed(error: unknown): void };
  tunnelEvent(event: DevTunnelEvent): void;
  editLink(link: string, again?: boolean): void;
  // Starts listening for the shortcuts and lists them. False when there's
  // no terminal to listen at.
  // onStop: what q and Ctrl+C do. By default, Ctrl+C to the whole
  // process group, as the terminal would (npm start under npm).
  listen(shortcuts: Shortcut[], onStop?: () => void): boolean;
  // After a process sharing the terminal ends (see ShortcutListener).
  keysAgain(): void;
  stopping(): void;
  portInUse(port: number, runningPid?: number): void;
}

export function createSiteConsole(streams: SiteConsoleStreams = {}, options: SiteConsoleOptions = {}): SiteConsole {
  const out = createUi(streams.stdout ?? process.stdout);
  const err = createUi(streams.stderr ?? process.stderr);
  const stdin = streams.stdin ?? process.stdin;
  const quiet = options.quiet === true;
  let listener: ShortcutListener | null = null;

  function tunnelEvent(event: DevTunnelEvent): void {
    switch (event.kind) {
      case 'retrying':
        // Shown by the opening spinner while it's running.
        break;
      case 'dns-slow':
        err.warn('The tunnel is open, but its address is slow to appear in DNS.', 'It may take a minute before it loads.');
        break;
      case 'dropped':
        err.warn('The tunnel dropped. Reopening it...');
        break;
      case 'reopened':
        out.success(event.changed ? 'Tunnel open again, at a new address' : 'Tunnel open again', event.url);
        break;
      case 'reopen-failed':
        err.warn(`Couldn't reopen the tunnel (attempt ${event.attempt} of ${event.attempts})`, event.reason);
        break;
      case 'gave-up':
        err.error('Gave up reopening the tunnel.', `The site is still running here. Stop it and run ${err.command('npm run dev')} again.`);
        break;
    }
  }

  return {
    out,
    err,
    starting(siteRoot, version) {
      if (!quiet) {
        out.header('minamo', `${basename(siteRoot)} · framework ${version}`);
      }
    },
    running(localUrl) {
      if (quiet) {
        return;
      }
      if (out.fancy) {
        out.rows([['Site running', out.style(localUrl, 'cyan')]], { symbol: 'success' });
      } else {
        out.line(`Site running at ${localUrl}`);
      }
    },
    themeWarning(message) {
      err.warn(message);
    },
    // At a terminal only: npm start is also what live hosting runs, and
    // a host's logs are no place for advice about working on the site.
    devHint() {
      if (!quiet && out.fancy) {
        out.info(`Working on this site? ${out.command('npm run dev')} opens it in Minamo and restarts it when the theme changes.`);
      }
    },
    openingTunnel() {
      const spinner = out.spinner('Opening a Cloudflare tunnel');
      // Said once the tunnel line is printed, not over the spinner.
      let slowDns = false;
      return {
        event(event) {
          if (event.kind === 'retrying') {
            spinner.update(`Opening a Cloudflare tunnel (try ${event.attempt} of ${event.attempts})`);
          } else if (event.kind === 'dns-slow') {
            slowDns = true;
          } else {
            tunnelEvent(event);
          }
        },
        opened(url) {
          spinner.stop();
          if (out.fancy) {
            out.rows([['Tunnel open ', out.style(url, 'cyan')]], { symbol: 'success' });
          } else {
            out.line(`Tunnel open (Cloudflare): ${url}`);
          }
          out.line(
            out.fancy
              ? `   ${out.style("Publicly reachable while this runs. Don't leave it running unattended.", 'dim')}`
              : "This address is publicly reachable for as long as this runs. Don't leave it running unattended.",
          );
          if (slowDns) {
            out.warn('Its address is slow to appear in DNS, so it may take a minute before it loads.');
          }
        },
        failed(error) {
          spinner.stop();
          if (error instanceof CloudflaredNotInstalledError) {
            err.error(
              "No tunnel: it needs cloudflared, which isn't installed.",
              `Install it with: ${err.command(cloudflaredInstallCommand())}`,
              'Then start the site again. No Cloudflare account is needed.',
              'The site is still running here meanwhile.',
            );
            return;
          }
          err.error(
            `Couldn't open a tunnel: ${error instanceof Error ? error.message : String(error)}`,
            `The site is still running here. Try ${err.command('npm run dev')} again in a minute.`,
          );
        },
      };
    },
    tunnelEvent,
    editLink(link, again = false) {
      out.blank();
      out.box(again ? 'Edit in Minamo (new link)' : 'Edit in Minamo', [
        out.fancy
          ? `Press ${out.style('e', 'bold')} to open this site in the Minamo editor, or open the link below.`
          : 'Open this link to edit this site in Minamo:',
        'It works until this site stops. Anyone with it (and a Minamo account) can edit the site, so share it with care.',
      ]);
      // Outside the box, on a line of its own: a border would break a
      // link this long across lines, and it could no longer be clicked.
      out.line(out.fancy ? ` ${out.style(link, 'cyan', 'underline')}` : `Edit in Minamo: ${link}`);
      out.blank();
    },
    listen(shortcuts, onStop) {
      if (quiet || !out.fancy) {
        return false;
      }
      listener = onStop ? listenForShortcuts(stdin, shortcuts, onStop) : listenForShortcuts(stdin, shortcuts);
      if (!listener) {
        return false;
      }
      out.line(
        ` ${shortcuts
          .map((shortcut) => `${out.style(shortcut.key, 'bold')} ${out.style(shortcut.label, 'dim')}`)
          .join(out.style('  ·  ', 'dim'))}`,
      );
      return true;
    },
    keysAgain() {
      listener?.reassert();
    },
    stopping() {
      listener?.stop();
      listener = null;
      // At a terminal only: in a host's logs the process ending says it.
      if (!quiet && out.fancy) {
        out.blank();
        out.success('Stopped the site.');
      }
    },
    portInUse(port, runningPid) {
      if (runningPid !== undefined) {
        err.error(`This site is already running on port ${port} (process ${runningPid}).`, `Stop it with "npm run stop" from vhost/, then start it again.`);
        return;
      }
      err.error(
        `Port ${port} is already in use.`,
        'Set a different port with the PORT environment variable (e.g. PORT=3001 node server.js), or "port" in vhost/site.config.json.',
      );
    },
  };
}
