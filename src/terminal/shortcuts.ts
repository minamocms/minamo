import { spawn } from 'node:child_process';

// Single-key shortcuts while a site runs in a terminal ("e" opens the
// editor, and so on), the way other development servers offer them.
//
// Only at an interactive terminal: anywhere else (a host's process
// manager, output piped somewhere, tests) nothing listens, and stdin is
// left alone.
//
// Listening for single keys puts the terminal in raw mode, where Ctrl+C
// no longer raises SIGINT by itself. So Ctrl+C (and the stop key) sends
// SIGINT to the whole process group, exactly what the terminal would
// have done: npm, and `node --watch` behind npm run dev, stop with the
// site just as they did before.

export interface ShortcutInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  unref?(): unknown;
}

export interface Shortcut {
  key: string;
  label: string;
  // What the key does. Leave it out for a key that stops everything,
  // exactly as Ctrl+C does.
  run?: () => void;
}

export interface ShortcutListener {
  stop(): void;
  // Puts the terminal back as it should be: single-key mode while
  // listening, normal once stopped. Needed after a child process sharing
  // the terminal ends: Node puts the terminal back the way it found it
  // when a process exits, which can turn single-key mode off under this
  // one, or (a child started while it was on) leave it on after this one
  // has stopped.
  reassert(): void;
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

export function interruptProcessGroup(): void {
  try {
    // 0: every process in this one's group, as the terminal's own Ctrl+C.
    process.kill(0, 'SIGINT');
  } catch {
    process.kill(process.pid, 'SIGINT');
  }
}

export function listenForShortcuts(
  input: ShortcutInput,
  shortcuts: Shortcut[],
  interrupt: () => void = interruptProcessGroup,
): ShortcutListener | null {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return null;
  }
  const byKey = new Map(shortcuts.map((shortcut) => [shortcut.key.toLowerCase(), shortcut]));
  let stopped = false;

  const onData = (chunk: Buffer | string): void => {
    for (const key of chunk.toString()) {
      if (key === CTRL_C || key === CTRL_D) {
        listener.stop();
        interrupt();
        return;
      }
      const shortcut = byKey.get(key.toLowerCase());
      if (shortcut && !shortcut.run) {
        listener.stop();
        interrupt();
        return;
      }
      shortcut?.run?.();
    }
  };

  const listener: ShortcutListener = {
    reassert() {
      // Both, the wanted one last: the terminal handle remembers the mode
      // it last set and would otherwise skip setting it again.
      input.setRawMode?.(stopped);
      input.setRawMode?.(!stopped);
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
    },
  };

  input.setRawMode(true);
  input.on('data', onData);
  input.resume();
  // Waiting for a key never keeps the process alive by itself.
  input.unref?.();
  // However the process ends, the terminal goes back to normal.
  process.once('exit', () => listener.stop());
  return listener;
}

// Opens a web address in the default browser.
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['explorer.exe', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser to open: the address is printed anyway.
  }
}
