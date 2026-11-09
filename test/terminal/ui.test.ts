import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createUi, visibleLength, wrap } from '../../src/terminal/ui.ts';

function sink(isTTY: boolean, columns = 80) {
  let text = '';
  return {
    stream: { isTTY, columns, write: (chunk: string) => (text += chunk) },
    text: () => text,
    lines: () => stripVTControlCharacters(text).split('\n'),
  };
}

test('plain mode (not a terminal) prints the words alone: no colour, symbols, boxes or spinners', async () => {
  const output = sink(false);
  const ui = createUi(output.stream, { env: {} });
  assert.equal(ui.fancy, false);
  assert.equal(ui.colour, false);
  ui.success('Site running', 'http://127.0.0.1:3000');
  ui.warn('Careful', 'Because of this.');
  ui.error('Broken', 'Do this to fix it.');
  ui.box('Edit in Minamo', ['A line in the box.']);
  const spinner = ui.spinner('Opening a tunnel');
  spinner.succeed('Tunnel open');
  ui.details([['content', '1 new']]);
  assert.equal(
    output.text(),
    [
      'Site running http://127.0.0.1:3000',
      'Careful',
      'Because of this.',
      'Broken',
      'Do this to fix it.',
      'Edit in Minamo',
      'A line in the box.',
      'Opening a tunnel...',
      'Tunnel open',
      '  content: 1 new',
      '',
    ].join('\n'),
  );
});

test('MINAMO_PLAIN and TERM=dumb give plain output even at a terminal', () => {
  assert.equal(createUi(sink(true).stream, { env: { MINAMO_PLAIN: '1' } }).fancy, false);
  assert.equal(createUi(sink(true).stream, { env: { TERM: 'dumb' } }).fancy, false);
  assert.equal(createUi(sink(true).stream, { env: {} }).fancy, true);
});

test('colour follows NO_COLOR and FORCE_COLOR', () => {
  assert.equal(createUi(sink(true).stream, { env: { NO_COLOR: '1' } }).colour, false);
  assert.equal(createUi(sink(false).stream, { env: { FORCE_COLOR: '1' } }).colour, true);
  assert.equal(createUi(sink(true).stream, { env: { FORCE_COLOR: '0' } }).colour, false);
  const output = sink(true);
  createUi(output.stream, { env: { NO_COLOR: '1' } }).success('Done');
  assert.equal(output.text(), ' ✔ Done\n', 'symbols stay without colour');
});

test('fancy mode marks each kind of message with its symbol', () => {
  const output = sink(true);
  const ui = createUi(output.stream, { env: {} });
  ui.success('Done');
  ui.warn('Careful');
  ui.error('Broken', 'How to fix it.');
  ui.info('Note');
  assert.deepEqual(output.lines(), [' ✔ Done', ' ! Careful', ' ✖ Broken', '   How to fix it.', ' • Note', '']);
});

test('a box keeps every line the same width, wrapping long text inside it', () => {
  const output = sink(true, 50);
  createUi(output.stream, { env: {} }).box('Title', ['A sentence long enough that it has to wrap onto a second line inside the box.']);
  const lines = output.lines().filter(Boolean);
  assert.ok(lines.length >= 4);
  const widths = new Set(lines.map((line) => visibleLength(line)));
  assert.equal(widths.size, 1, `every line of the box is ${[...widths].join(' or ')} wide`);
  assert.match(lines[0] ?? '', /╭─ Title ─+╮/);
  assert.match(lines.at(-1) ?? '', /╰─+╯/);
});

test('wrap breaks at spaces and never splits a long word such as a link', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('see https://example.com/a/very/long/path here', 10), ['see', 'https://example.com/a/very/long/path', 'here']);
});

test('a spinner in fancy mode is replaced by its result, and other output is not drawn over', () => {
  const output = sink(true);
  const ui = createUi(output.stream, { env: {} });
  const spinner = ui.spinner('Working');
  ui.warn('Something happened meanwhile');
  spinner.succeed('Worked');
  // What the terminal shows: each \r and line-clear applied.
  const shown = stripVTControlCharacters(output.text().split('\r\u001b[2K').join('\u0000'))
    .split('\n')
    .map((line) => line.split('\u0000').at(-1));
  assert.deepEqual(shown, [' ! Something happened meanwhile', ' ✔ Worked', '']);
  assert.ok(output.text().includes('\u001b[?25h'), 'the cursor is shown again');
});

test('two spinners at once: the newer shows, and the older shows again when it ends', () => {
  const output = sink(true);
  const ui = createUi(output.stream, { env: {} });
  const opening = ui.spinner('Opening a tunnel');
  const restarting = ui.spinner('Restarting the site');
  restarting.succeed('Restarted the site');
  opening.succeed('Tunnel open');
  const shown = stripVTControlCharacters(output.text().split('\r\u001b[2K').join('\u0000'))
    .split('\n')
    .map((line) => line.split('\u0000').at(-1));
  assert.deepEqual(shown, [' ✔ Restarted the site', ' ✔ Tunnel open', '']);
  assert.ok(output.text().includes('Opening a tunnel...'), 'the older spinner was drawn again in between');
  assert.ok(output.text().includes('\u001b[?25h'), 'the cursor is shown again once both are done');
});
