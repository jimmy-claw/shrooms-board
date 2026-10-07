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
  'board.rename',
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

export const ev = {
  boardRename: (title, clock) => makeEvent('board.rename', { title }, clock),

  listCreate: (id, title, pos, clock) => makeEvent('list.create', { id, title, pos }, clock),
  listEdit: (id, fields, clock) => makeEvent('list.edit', { id, fields }, clock),
  listDelete: (id, clock) => makeEvent('list.delete', { id }, clock),

  cardCreate: (id, listId, title, pos, clock) =>
    makeEvent('card.create', { id, list_id: listId, title, pos }, clock),
  cardEdit: (id, fields, clock) => makeEvent('card.edit', { id, fields }, clock),
  cardDelete: (id, clock) => makeEvent('card.delete', { id }, clock),

  // Per-actor register: actor's own LWW value; present=false is the un-vote.
  cardAssign: (cardId, actor, present, clock) =>
    makeEvent('card.assign', { id: cardId, actor, present }, clock),

  commentCreate: (id, cardId, text, clock) =>
    makeEvent('comment.create', { id, card_id: cardId, text }, clock),
  commentDelete: (id, clock) => makeEvent('comment.delete', { id }, clock),
};

// Field keys allowed in *edit payloads, for validation at the API edge.
export const LIST_FIELDS = ['title', 'pos'];
export const CARD_FIELDS = ['title', 'desc', 'pos', 'list_id', 'due'];
