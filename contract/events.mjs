// Event constructors — logos-multiwriter-sync decision #1.
// Event = { v:1, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }
// The id is the idempotency key: redelivery is a no-op (dedup by id).
//
// Write-shapes (decision #2), per field:
//   LWW-by-HLC            board.rename; list title/pos; card title/desc/due/pos/list_id
//   per-actor register    card.assign (actor-keyed, aggregate = distinct present actors)
//   append-only record    comment.create (supersede/tombstone like everything else)
// Deletes are sticky tombstones; edits supersede field-scoped and are lenient
// about arriving before their create (decision #1 + [^18]).

import { randomUUID } from 'node:crypto';
import { isValidDev } from './hlc.mjs';

export const EVENT_TYPES = [
  'board.create', 'board.rename', 'board.delete', 'board.restore',
  'list.create', 'list.edit', 'list.delete',
  'card.create', 'card.edit', 'card.delete',
  'card.assign',
  'comment.create', 'comment.delete',
];

export function makeEvent(type, payload, clock) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`makeEvent: unknown type ${type}`);
  const hlc = clock.send();
  return { v: 1, id: randomUUID(), type, hlc, dev: clock.dev, payload };
}

// v2: boards are partitions of one log. Every list/card/comment carries board_id in
// its PAYLOAD (not the envelope), so the event shape is unchanged and a board can
// later move to its own dataset without touching the format. boardId is an optional
// trailing argument so v1 call sites keep meaning "the default board".
export const DEFAULT_BOARD = 'default';

export const ev = {
  boardCreate: (id, title, pos, clock) => makeEvent('board.create', { id, title, pos }, clock),
  boardRename: (id, title, clock) => makeEvent('board.rename', { id, title }, clock),
  boardDelete: (id, clock) => makeEvent('board.delete', { id }, clock),
  boardRestore: (id, clock) => makeEvent('board.restore', { id }, clock),

  listCreate: (id, title, pos, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('list.create', { board_id: boardId, id, title, pos }, clock),
  listEdit: (id, fields, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('list.edit', { board_id: boardId, id, fields }, clock),
  listDelete: (id, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('list.delete', { board_id: boardId, id }, clock),

  cardCreate: (id, listId, title, pos, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('card.create', { board_id: boardId, id, list_id: listId, title, pos }, clock),
  cardEdit: (id, fields, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('card.edit', { board_id: boardId, id, fields }, clock),
  cardDelete: (id, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('card.delete', { board_id: boardId, id }, clock),

  // Per-actor register: actor's own LWW value; present=false is the un-vote.
  cardAssign: (cardId, actor, present, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('card.assign', { board_id: boardId, id: cardId, actor, present }, clock),

  commentCreate: (id, cardId, text, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('comment.create', { board_id: boardId, id, card_id: cardId, text }, clock),
  commentDelete: (id, clock, boardId = DEFAULT_BOARD) =>
    makeEvent('comment.delete', { board_id: boardId, id }, clock),
};

// Field keys allowed in *edit payloads, for validation at the API edge.
export const LIST_FIELDS = ['title', 'pos'];
export const CARD_FIELDS = ['title', 'desc', 'pos', 'list_id', 'due'];
