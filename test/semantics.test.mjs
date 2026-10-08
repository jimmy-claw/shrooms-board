// Explicit assertions for the v2 semantics. Parity between two engines only proves
// they AGREE — twice now they agreed on a wrong answer (a no-op restore, an ignored
// rename) because both had the same gap. These assertions state the intent directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldBoard, mergeEvents } from '../engine/engine.mjs';
import { ev, DEFAULT_BOARD } from '../contract/events.mjs';

const DEV_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEV_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// a clock that stamps one event at a chosen wall time, so the tests can state HLC order
const a = (w) => ({ dev: DEV_A, send: () => ({ wall: w, ctr: 0, dev: DEV_A }) });
const b = (w) => ({ dev: DEV_B, send: () => ({ wall: w, ctr: 0, dev: DEV_B }) });
const fold = (...e) => foldBoard(mergeEvents(e));
const titles = (s) => s.boards.map((x) => x.title);
const cardTitles = (s) => s.cards.map((c) => c.title);

test('board.rename actually renames (a rename is an edit)', () => {
  const s = fold(ev.boardCreate('b1', 'Before', 1000, a(1)), ev.boardRename('b1', 'After', a(2)));
  assert.deepEqual(titles(s), ['After']);
});

test('board.delete hides its lists and cards; restore brings them back', () => {
  const log = [
    ev.boardCreate('b1', 'One', 1000, a(1)),
    ev.listCreate('l1', 'todo', 1000, a(2), 'b1'),
    ev.cardCreate('c1', 'l1', 'card', 1000, a(3), 'b1'),
  ];
  assert.deepEqual(cardTitles(fold(...log)), ['card'], 'visible before the delete');

  const del = [...log, ev.boardDelete('b1', a(4))];
  const s1 = fold(...del);
  assert.deepEqual(titles(s1), [], 'the board leaves the list');
  assert.deepEqual(s1.lists, [], 'its list is hidden (cascade is derived)');
  assert.deepEqual(cardTitles(s1), [], 'its card is hidden too');

  const s2 = fold(...del, ev.boardRestore('b1', a(5)));
  assert.deepEqual(titles(s2), ['One'], 'restore returns the board');
  assert.deepEqual(cardTitles(s2), ['card'], 'and its card, with no extra events');
});

test('a card deleted before its board stays deleted after the board is restored', () => {
  const log = [
    ev.boardCreate('b1', 'One', 1000, a(1)),
    ev.listCreate('l1', 'todo', 1000, a(2), 'b1'),
    ev.cardCreate('c1', 'l1', 'kept', 1000, a(3), 'b1'),
    ev.cardCreate('c2', 'l1', 'gone', 2000, a(4), 'b1'),
    ev.cardDelete('c2', a(5), 'b1'),
    ev.boardDelete('b1', a(6)),
    ev.boardRestore('b1', a(7)),
  ];
  assert.deepEqual(cardTitles(fold(...log)), ['kept']);
});

test('last delete/restore wins by HLC, from either device', () => {
  const base = [ev.boardCreate('b1', 'One', 1000, a(1))];
  const s1 = fold(...base, ev.boardDelete('b1', a(5)), ev.boardRestore('b1', a(9)));
  assert.deepEqual(titles(s1), ['One'], 'restore after delete wins');
  const s2 = fold(...base, ev.boardRestore('b1', a(5)), ev.boardDelete('b1', a(9)));
  assert.deepEqual(titles(s2), [], 'delete after restore wins');
});

test('v1 events with no board_id fold as the default board', () => {
  const s = fold(ev.listCreate('l1', 'legacy', 1000, a(1)), ev.cardCreate('c1', 'l1', 'old', 1000, a(2)));
  assert.deepEqual(cardTitles(s), ['old']);
  assert.equal(s.cards[0].board_id, DEFAULT_BOARD);
  assert.deepEqual(titles(s), [], 'and need no board record to exist');
});

test('two boards keep their own lists and cards', () => {
  const s = fold(
    ev.boardCreate('b1', 'One', 1000, a(1)),
    ev.boardCreate('b2', 'Two', 2000, a(2)),
    ev.listCreate('l1', 'todo', 1000, a(3), 'b1'),
    ev.listCreate('l2', 'todo', 1000, a(4), 'b2'),
    ev.cardCreate('c1', 'l1', 'in one', 1000, a(5), 'b1'),
    ev.cardCreate('c2', 'l2', 'in two', 1000, a(6), 'b2'),
  );
  assert.deepEqual(titles(s), ['One', 'Two']);
  assert.deepEqual(cardTitles(s), ['in one', 'in two']);
  assert.deepEqual(s.cards.map((c) => c.board_id), ['b1', 'b2']);
});
