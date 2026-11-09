import { stripVTControlCharacters, styleText } from 'node:util';

// How this package talks to a person in a terminal: colour, symbols,
// spinners, boxes, aligned rows. Built on Node's own util.styleText, so
// it adds no dependency.
//
// Two modes, chosen per stream:
// - fancy, for a person at an interactive terminal: symbols (✔ ! ✖),
//   colour, spinners and boxes.
// - plain, for everything else (output piped to a file or a host's logs,
//   CI, tests), and whenever MINAMO_PLAIN is set: the same words, one
//   message to a line, nothing else. A site's server prints through
//   this on live hosting too, where its output is a log, not a screen.
//
// Colour on its own follows the usual conventions: NO_COLOR turns it
// off, FORCE_COLOR turns it on, otherwise it's on in fancy mode only.
// Colour only ever repeats what a symbol or word already says.

type Style = 'bold' | 'dim' | 'green' | 'yellow' | 'red' | 'cyan' | 'magenta' | 'underline';

export interface UiStream {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface Spinner {
  // Changes the message while it keeps spinning.
  update(text: string): void;
  succeed(text?: string, detail?: string): void;
  warn(text?: string, ...lines: string[]): void;
  fail(text?: string, ...lines: string[]): void;
  // Stops without printing anything in its place.
  stop(): void;
}

export interface Ui {
  readonly fancy: boolean;
  readonly colour: boolean;
  style(text: string, ...styles: Style[]): string;
  // A plain line.
  line(text?: string): void;
  blank(): void;
  // ✔ Done. Detail (dim) follows on the same line.
  success(text: string, detail?: string): void;
  // ! Something worth knowing, then lines explaining it.
  warn(text: string, ...lines: string[]): void;
  // ✖ What went wrong, then lines saying why and what to do.
  error(text: string, ...lines: string[]): void;
  // • A neutral note.
  info(text: string, ...lines: string[]): void;
  // The name of the tool and what it's working on, at the top of a run.
  header(title: string, subtitle?: string): void;
  // A bold heading for a group of lines that follow.
  heading(text: string): void;
  // Label and value pairs with the values lined up.
  rows(rows: Array<[label: string, value: string]>, options?: { symbol?: 'success' | 'none' }): void;
  // Indented label and value pairs under a result ("content: 2 new"):
  // labels dim and lined up in fancy mode, "label: value" in plain.
  details(rows: Array<[label: string, value: string]>): void;
  // An indented list.
  list(items: string[], options?: { bullet?: string }): void;
  // Changes to be made, one a line: the action coloured by what it does
  // (green adds, yellow changes, red removes), then what it applies to.
  changes(items: Array<{ action: string; tone: 'add' | 'change' | 'remove'; target: string }>): void;
  // A bordered box around a few lines, for the one thing to act on.
  box(title: string, lines: string[], tone?: 'info' | 'warn' | 'error'): void;
  // A command to type, shown so it stands out.
  command(text: string): string;
  spinner(text: string): Spinner;
}

export interface UiOptions {
  env?: NodeJS.ProcessEnv;
  // Defaults to stream.isTTY.
  interactive?: boolean;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const MAX_WIDTH = 78;

function wantsColour(env: NodeJS.ProcessEnv, fancy: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return false;
  }
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  }
  return fancy;
}

// The width text takes on screen, ignoring colour codes.
export function visibleLength(text: string): number {
  return [...stripVTControlCharacters(text)].length;
}

// Breaks text into lines no wider than width, at spaces. A word longer
// than the width (a URL, say) stays whole on its own line.
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(' ')) {
      if (current === '') {
        current = word;
      } else if (visibleLength(current) + 1 + visibleLength(word) <= width) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export function createUi(stream: UiStream, options: UiOptions = {}): Ui {
  const env = options.env ?? process.env;
  const plainRequested = env.MINAMO_PLAIN !== undefined && env.MINAMO_PLAIN !== '' && env.MINAMO_PLAIN !== '0';
  const fancy = (options.interactive ?? stream.isTTY === true) && !plainRequested && env.TERM !== 'dumb';
  const colour = wantsColour(env, fancy);
  // Spinners running now, newest last. Only the newest is drawn (on the
  // last line); when it ends, the one before it shows again. One timer
  // animates whichever is on show.
  const running: Array<{ message: () => string }> = [];
  let spinnerDrawn = false;
  let spinnerFrame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function clearSpinner(): void {
    if (spinnerDrawn) {
      stream.write('\r\u001b[2K');
      spinnerDrawn = false;
    }
  }

  function drawSpinner(): void {
    const top = running.at(-1);
    if (!top) {
      return;
    }
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] ?? '';
    stream.write(`\r\u001b[2K ${style(frame, 'cyan')} ${top.message()}...`);
    spinnerDrawn = true;
  }

  function style(text: string, ...styles: Style[]): string {
    if (!colour || styles.length === 0) {
      return text;
    }
    return styleText(styles, text, { validateStream: false });
  }

  function width(): number {
    return Math.max(40, Math.min(stream.columns ?? 80, MAX_WIDTH));
  }

  // Everything goes through here, so a running spinner is cleared first
  // and drawn again after, rather than written over.
  function write(text: string): void {
    clearSpinner();
    stream.write(text);
    drawSpinner();
  }

  function line(text = ''): void {
    write(`${text}\n`);
  }

  function symbolLine(symbol: string, text: string, detail?: string): void {
    if (!fancy) {
      line(detail ? `${text} ${detail}` : text);
      return;
    }
    line(` ${symbol} ${text}${detail ? ` ${style(detail, 'dim')}` : ''}`);
  }

  function explain(lines: string[]): void {
    for (const extra of lines) {
      line(fancy ? `   ${extra}` : extra);
    }
  }

  const ui: Ui = {
    fancy,
    colour,
    style,
    line,
    blank: () => line(),
    success(text, detail) {
      symbolLine(style('✔', 'green'), text, detail);
    },
    warn(text, ...lines) {
      symbolLine(style('!', 'yellow', 'bold'), fancy ? style(text, 'yellow') : text);
      explain(lines);
    },
    error(text, ...lines) {
      symbolLine(style('✖', 'red', 'bold'), fancy ? style(text, 'red', 'bold') : text);
      explain(lines);
    },
    info(text, ...lines) {
      symbolLine(style('•', 'cyan'), text);
      explain(lines);
    },
    header(title, subtitle) {
      if (!fancy) {
        line(subtitle ? `${title}: ${subtitle}` : title);
        return;
      }
      line();
      line(` ${style(` ${title} `, 'bold', 'magenta')}${subtitle ? `  ${style(subtitle, 'dim')}` : ''}`);
      line();
    },
    heading(text) {
      line(fancy ? ` ${style(text, 'bold')}` : text);
    },
    rows(rows, rowOptions = {}) {
      const labelWidth = Math.max(...rows.map(([label]) => visibleLength(label)));
      for (const [label, value] of rows) {
        if (!fancy) {
          line(`${label}: ${value}`);
          continue;
        }
        const padded = label + ' '.repeat(labelWidth - visibleLength(label));
        const symbol = rowOptions.symbol === 'success' ? `${style('✔', 'green')} ` : '';
        line(` ${symbol}${padded}   ${value}`);
      }
    },
    details(rows) {
      const labelWidth = Math.max(...rows.map(([label]) => visibleLength(label)));
      for (const [label, value] of rows) {
        line(fancy ? `   ${style(label.padEnd(labelWidth), 'dim')}  ${value}` : `  ${label}: ${value}`);
      }
    },
    changes(items) {
      const actionWidth = Math.max(...items.map((item) => visibleLength(item.action)));
      for (const item of items) {
        const action = item.action.padEnd(actionWidth);
        const toned = style(action, item.tone === 'add' ? 'green' : item.tone === 'remove' ? 'red' : 'yellow', ...(item.tone === 'remove' ? (['bold'] as const) : []));
        line(`  ${fancy ? ` ${toned}` : action}  ${item.target}`);
      }
    },
    list(items, listOptions = {}) {
      const bullet = listOptions.bullet ?? (fancy ? style('•', 'dim') : '-');
      for (const item of items) {
        line(`   ${bullet} ${item}`);
      }
    },
    box(title, lines, tone = 'info') {
      if (!fancy) {
        line(title);
        for (const text of lines) {
          line(text);
        }
        return;
      }
      const colourFor = tone === 'warn' ? 'yellow' : tone === 'error' ? 'red' : 'cyan';
      const inner = width() - 4;
      const border = (text: string) => style(text, colourFor);
      const titleText = ` ${style(title, 'bold')} `;
      const topRule = Math.max(0, inner - visibleLength(titleText) - 1);
      line(` ${border('╭─')}${titleText}${border(`${'─'.repeat(topRule)}╮`)}`);
      for (const text of lines.flatMap((entry) => wrap(entry, inner - 2))) {
        const padding = Math.max(0, inner - 2 - visibleLength(text));
        line(` ${border('│')} ${text}${' '.repeat(padding)} ${border('│')}`);
      }
      line(` ${border(`╰${'─'.repeat(inner)}╯`)}`);
    },
    command(text) {
      return fancy ? style(text, 'cyan') : text;
    },
    spinner(text) {
      let message = text;
      const entry = { message: () => message };
      let ended = false;

      if (!fancy) {
        line(`${message}...`);
      } else {
        if (running.length === 0) {
          stream.write('\u001b[?25l');
          ticker = setInterval(() => {
            spinnerFrame++;
            drawSpinner();
          }, SPINNER_INTERVAL_MS);
          // Never what keeps the process alive.
          ticker.unref?.();
        }
        running.push(entry);
        drawSpinner();
      }

      function end(): void {
        if (ended) {
          return;
        }
        ended = true;
        if (!fancy) {
          return;
        }
        const index = running.indexOf(entry);
        if (index !== -1) {
          running.splice(index, 1);
        }
        clearSpinner();
        if (running.length === 0) {
          clearInterval(ticker);
          ticker = undefined;
          stream.write('\u001b[?25h');
        } else {
          drawSpinner();
        }
      }

      return {
        update(next) {
          message = next;
          if (!fancy) {
            line(`${message}...`);
          } else if (running.at(-1) === entry) {
            drawSpinner();
          }
        },
        succeed(done, detail) {
          end();
          if (fancy || done !== undefined) {
            ui.success(done ?? message, detail);
          }
        },
        warn(done, ...lines) {
          end();
          ui.warn(done ?? message, ...lines);
        },
        fail(done, ...lines) {
          end();
          ui.error(done ?? message, ...lines);
        },
        stop: end,
      };
    },
  };
  return ui;
}

// The two everything in this package prints through: progress, prompts
// and problems on stderr, results on stdout (so a script can capture the
// result alone).
let stdoutUi: Ui | undefined;
let stderrUi: Ui | undefined;

export function out(): Ui {
  stdoutUi ??= createUi(process.stdout);
  return stdoutUi;
}

export function err(): Ui {
  stderrUi ??= createUi(process.stderr);
  return stderrUi;
}
