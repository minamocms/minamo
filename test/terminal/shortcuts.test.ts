import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { listenForShortcuts } from '../../src/terminal/shortcuts.ts';

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  paused = true;
  setRawMode(mode: boolean) {
    this.raw = mode;
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  unref() {}
  press(keys: string) {
    this.emit('data', Buffer.from(keys));
  }
}

test('runs the shortcut for each key pressed, upper or lower case', () => {
  const stdin = new FakeStdin();
  const pressed: string[] = [];
  const listener = listenForShortcuts(stdin, [
    { key: 'e', label: 'open editor', run: () => pressed.push('e') },
    { key: 'o', label: 'open site', run: () => pressed.push('o') },
  ]);
  assert.ok(listener);
  assert.equal(stdin.raw, true);
  stdin.press('e');
  stdin.press('O');
  stdin.press('x');
  assert.deepEqual(pressed, ['e', 'o']);
  listener.stop();
  assert.equal(stdin.raw, false, 'the terminal goes back to normal');
  stdin.press('e');
  assert.deepEqual(pressed, ['e', 'o'], 'nothing runs once stopped');
});

test('Ctrl+C restores the terminal and interrupts, as it would without shortcuts', () => {
  const stdin = new FakeStdin();
  let interrupted = 0;
  listenForShortcuts(stdin, [], () => interrupted++);
  stdin.press('\u0003');
  assert.equal(interrupted, 1);
  assert.equal(stdin.raw, false);
});

test('a key with no action of its own (q, stop) interrupts like Ctrl+C', () => {
  const stdin = new FakeStdin();
  let interrupted = 0;
  listenForShortcuts(stdin, [{ key: 'q', label: 'stop' }], () => interrupted++);
  stdin.press('q');
  assert.equal(interrupted, 1);
  assert.equal(stdin.raw, false);
});

test('does nothing when stdin is not a terminal', () => {
  const stdin = new FakeStdin();
  stdin.isTTY = false;
  assert.equal(listenForShortcuts(stdin, [{ key: 'e', label: 'x', run: () => {} }]), null);
  assert.equal(stdin.raw, false);
  assert.equal(stdin.paused, true);
});
