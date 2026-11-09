import { basename } from 'node:path';
import { createUi, type Ui, type UiStream } from './ui.ts';
import { listenForShortcuts, openInBrowser, type ShortcutInput, type ShortcutListener } from './shortcuts.ts';
import { cloudflaredInstallCommand, CloudflaredNotInstalledError, type DevTunnelEvent } from '../services/dev-tunnel.ts';

// What a running site prints (npm start, npm run tunnel, npm run dev):
// startup, the tunnel and its Edit in Minamo link, problems, and the
// keyboard shortcuts. Everything goes through ui.ts, so on live hosting
// (no terminal) it's the same words as plain log lines.

export interface SiteConsoleStreams {
  stdout?: UiStream;
  stderr?: UiStream;
  stdin?: ShortcutInput;
}

export interface SiteConsole {
  out: Ui;
  err: Ui;
  starting(siteRoot: string, version: string): void;
  running(localUrl: string): void;
  themeWarning(message: string): void;
  tunnelHint(): void;
  openingTunnel(): { event(event: DevTunnelEvent): void; opened(url: string): void; failed(error: unknown): void };
  tunnelEvent(event: DevTunnelEvent): void;
  editLink(link: string, again?: boolean): void;
  listen(shortcuts: { localUrl: string; editLink: () => string | undefined }): void;
  stopping(): void;
  portInUse(port: number, runningPid?: number): void;
}

export function createSiteConsole(streams: SiteConsoleStreams = {}): SiteConsole {
  const out = createUi(streams.stdout ?? process.stdout);
  const err = createUi(streams.stderr ?? process.stderr);
  const stdin = streams.stdin ?? process.stdin;
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
        if (event.changed) {
          out.success('Tunnel open again, at a new address', event.url);
        } else {
          out.success('Tunnel open again', event.url);
        }
        break;
      case 'reopen-failed':
        err.warn(`Couldn't reopen the tunnel (attempt ${event.attempt} of ${event.attempts})`, event.reason);
        break;
      case 'gave-up':
        err.error('Gave up reopening the tunnel.', `The site is still running here. Stop it and run ${err.command('npm run tunnel')} again.`);
        break;
    }
  }

  return {
    out,
    err,
    starting(siteRoot, version) {
      out.header('minamo', `${basename(siteRoot)} · framework ${version}`);
    },
    running(localUrl) {
      if (out.fancy) {
        out.rows([['Site running', out.style(localUrl, 'cyan')]], { symbol: 'success' });
      } else {
        out.line(`Site running at ${localUrl}`);
      }
    },
    themeWarning(message) {
      err.warn(message);
    },
    tunnelHint() {
      out.info(`To edit this site in Minamo while it runs here, start it with ${out.command('npm run tunnel')} (--tunnel) instead.`);
    },
    openingTunnel() {
      const spinner = out.spinner('Opening a Cloudflare tunnel');
      return {
        event(event) {
          if (event.kind === 'retrying') {
            spinner.update(`Opening a Cloudflare tunnel (try ${event.attempt} of ${event.attempts})`);
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
            `The site is still running here. Try ${err.command('npm run tunnel')} again in a minute.`,
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
    listen({ localUrl, editLink }) {
      if (!out.fancy) {
        return;
      }
      listener = listenForShortcuts(stdin, [
        {
          key: 'e',
          label: 'open editor',
          run: () => {
            const link = editLink();
            if (link) {
              openInBrowser(link);
            }
          },
        },
        { key: 'o', label: 'open site', run: () => openInBrowser(localUrl) },
        // No action of its own: stops everything, as Ctrl+C does.
        { key: 'q', label: 'stop' },
      ]);
      if (listener) {
        const keys = [...(editLink() ? [['e', 'open editor']] : []), ['o', 'open site'], ['q', 'stop']];
        out.line(` ${keys.map(([key, label]) => `${out.style(key ?? '', 'bold')} ${out.style(label ?? '', 'dim')}`).join(out.style('  ·  ', 'dim'))}`);
      }
    },
    stopping() {
      listener?.stop();
      listener = null;
      // At a terminal only: in a host's logs the process ending says it.
      if (out.fancy) {
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
