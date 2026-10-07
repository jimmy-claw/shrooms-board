// Engine — pure functions over event arrays. No I/O, no clocks, no time.
// logos-multiwriter-sync decisions #1, #2, #4, #6.
//
//   mergeEvents(...logs)  union by id, sort by HLC   (idempotent/commutative/associative)
//   foldBoard(events)     pure deterministic fold -> current board state
//   checkInvariants(state) oracle after the fold — surfaced, never enforced at merge (#4)

import { compareHlc, isValidDev } from '../contract/hlc.mjs';

// Union by id (the idempotency key), then deterministic HLC sort.
// First occurrence wins on a duplicate id; the caller may pre-dedup.
export function mergeEvents(...logs) {
  const byId = new Map();
  for (const log of logs) {
    for (const e of log) {
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
  }
  return [...byId.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

// Per-record reconstruction: create + field-scoped edits (LWW by HLC) + terminal delete.
// Edits are lenient (may arrive before their create); an edit with no create at all
// is an orphan and ignored. Delete is terminal regardless of its HLC relative to edits:
// the record ends deleted and a late edit can never resurrect it.
function reconstruct(kind, events) {
  let create = null;
  const edits = [];
  let deleted = false;
  for (const e of events) { // events arrive pre-sorted by HLC
    if (e.type === `${kind}.create`) {
      if (!create) create = e; // duplicate record ids: first by HLC wins
    } else if (e.type === `${kind}.edit`) {
      edits.push(e);
    } else if (e.type === `${kind}.delete`) {
      deleted = true;
    }
  }
  if (!create) return null; // orphan edits ignored

  const rec = { id: create.payload.id, deleted, fields: {}, _hlc: create.hlc };
  for (const [k, v] of Object.entries(create.payload)) {
    if (k !== 'id') rec.fields[k] = { value: v, hlc: create.hlc };
  }
  for (const e of edits) {
    for (const [k, v] of Object.entries(e.payload.fields || {})) {
      rec.fields[k] = { value: v, hlc: e.hlc }; // LWW per field by HLC sort order
    }
    rec._hlc = e.hlc;
  }
  return rec;
}

// The fold. Returns plain JSON-able state:
//   { board: {title}, lists: [...], cards: [...], comments: [...], assigns: {cardId: {actor: bool}} }
// Assign registers are kept raw (actor -> present) so the aggregate is computed in the UI;
// the invariant oracle below asserts the count discipline (#4).
export function foldBoard(events) {
  const sorted = mergeEvents(events);
  const byType = { list: [], card: [], comment: [] };
  const boardRenames = [];
  for (const e of sorted) {
    if (e.type === 'board.rename') boardRenames.push(e);
    else if (byType[e.type.split('.')[0]]) byType[e.type.split('.')[0]].push(e);
    // 'card.assign' is handled after records are reconstructed (it targets cards)
  }

  const lists = new Map();
  const cards = new Map();
  const comments = new Map();
  for (const e of byType.list) {
    if (e.type === 'list.create' || e.type === 'list.edit') {
      const id = e.payload.id;
      const cur = lists.get(id) || [];
      cur.push(e);
      lists.set(id, cur);
    } else if (e.type === 'list.delete') {
      const id = e.payload.id;
      const cur = lists.get(id) || [];
      cur.push(e);
      lists.set(id, cur);
    }
  }
  for (const e of byType.card) {
    const id = e.payload.id;
    const cur = cards.get(id) || [];
    cur.push(e);
    cards.set(id, cur);
  }
  for (const e of byType.comment) {
    const id = e.payload.id;
    const cur = comments.get(id) || [];
    cur.push(e);
    comments.set(id, cur);
  }

  const listState = new Map();
  for (const [id, evs] of lists) {
    const r = reconstruct('list', evs);
    if (r) listState.set(id, r);
  }
  const cardState = new Map();
  for (const [id, evs] of cards) {
    const r = reconstruct('card', evs);
    if (r) cardState.set(id, r);
  }
  const commentState = new Map();
  for (const [id, evs] of comments) {
    const r = reconstruct('comment', evs);
    if (r) commentState.set(id, r);
  }

  // Per-actor registers (decision #2 bucket 2): actor -> {present, hlc}, LWW by HLC.
  const assigns = new Map(); // cardId -> Map(actor -> {present, hlc})
  for (const e of sorted) {
    if (e.type !== 'card.assign') continue;
    const cardId = e.payload.id;
    if (!assigns.has(cardId)) assigns.set(cardId, new Map());
    const reg = assigns.get(cardId);
    const actor = e.payload.actor;
    const prev = reg.get(actor);
    if (!prev || compareHlc(e.hlc, prev.hlc) > 0) {
      reg.set(actor, { present: !!e.payload.present, hlc: e.hlc });
    }
  }

  // View state: plain arrays sorted deterministically (pos, then id as tie-break).
  const view = { board: { title: null }, lists: [], cards: [], comments: [] };
  for (const e of boardRenames) { // last by HLC wins (array is HLC-sorted)
    view.board.title = e.payload.title;
  }

  const fieldVal = (rec, k) => (rec.fields[k] ? rec.fields[k].value : undefined);

  for (const r of listState.values()) {
    if (r.deleted) continue;
    view.lists.push({ id: r.id, title: fieldVal(r, 'title'), pos: fieldVal(r, 'pos') });
  }
  for (const r of cardState.values()) {
    if (r.deleted) continue;
    const cardId = r.id;
    const reg = assigns.get(cardId) || new Map();
    const assignees = [...reg.entries()].filter(([, v]) => v.present).map(([a]) => a);
    view.cards.push({
      id: cardId,
      list_id: fieldVal(r, 'list_id'),
      title: fieldVal(r, 'title'),
      desc: fieldVal(r, 'desc') ?? '',
      pos: fieldVal(r, 'pos'),
      due: fieldVal(r, 'due') ?? null,
      assignees, // aggregate over the register (#2)
    });
  }
  for (const r of commentState.values()) {
    if (r.deleted) continue;
    view.comments.push({ id: r.id, card_id: fieldVal(r, 'card_id'), text: fieldVal(r, 'text') });
  }

  const byPos = (a, b) => (a.pos ?? 0) - (b.pos ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  view.lists.sort(byPos);
  view.cards.sort(byPos);
  view.comments.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Register snapshot + tombstone ids for the oracle (JSON-able).
  view._assignRegisters = {};
  for (const [cardId, reg] of assigns) {
    if (!cardState.get(cardId)) continue;
    view._assignRegisters[cardId] = {};
    for (const [actor, v] of reg) view._assignRegisters[cardId][actor] = v.present;
  }
  // Every record id the fold knows, INCLUDING tombstones: referential integrity
  // means "references something that existed", not "references something live" —
  // a comment on a deleted card is legitimate state (decision #4).
  view._allIds = {
    lists: [...listState.keys()],
    cards: [...cardState.keys()],
    comments: [...commentState.keys()],
  };
  return view;
}

// Oracle (decision #4): computed AFTER the fold, asserted in tests, displayed in the
// UI as a warning — never enforced, never blocked, never dropped at merge time.
//   referential: every reference points at an id that EXISTS in the fold (tombstones
//   count as existing — a comment on a deleted card is legitimate state). An id that
//   never existed can only come from a bad merge or garbage input.
//   register-hygiene: no assign register for a card id the fold never saw.
// (The primary convergence gate is state-equality across shuffled orders, tested
// separately; this oracle is what a BAD merge specifically would violate.)
export function checkInvariants(state) {
  const all = state._allIds || { lists: [], cards: [], comments: [] };
  const listIds = new Set(all.lists);
  const cardIds = new Set(all.cards);
  const problems = [];
  for (const c of state.cards) {
    if (c.list_id === undefined || !listIds.has(c.list_id)) {
      problems.push({ kind: 'referential', what: `card ${c.id} references unknown list ${c.list_id}` });
    }
  }
  for (const m of state.comments) {
    if (!cardIds.has(m.card_id)) {
      problems.push({ kind: 'referential', what: `comment ${m.id} references unknown card ${m.card_id}` });
    }
  }
  for (const cardId of Object.keys(state._assignRegisters || {})) {
    if (!cardIds.has(cardId)) {
      problems.push({ kind: 'register-hygiene', what: `assign register for unknown card ${cardId}` });
    }
  }
  return { problems, ok: problems.length === 0 };
}

// Validate an inbound event enough to fold it safely. Deep validation of payload
// semantics lives at the API edge; the fold itself is total (never throws on
// well-typed events) so a bad event can never wedge convergence.
export function validateEvent(e) {
  const problems = [];
  if (!e || typeof e !== 'object') return ['event is not an object'];
  if (e.v !== 1) problems.push('v must be 1');
  if (typeof e.id !== 'string' || e.id.length < 8) problems.push('id must be a string');
  if (typeof e.type !== 'string') problems.push('type must be a string');
  if (!e.hlc || typeof e.hlc.wall !== 'number' || typeof e.hlc.ctr !== 'number' || !isValidDev(e.hlc.dev)) {
    problems.push('hlc must be {wall, ctr, dev}');
  }
  if (!isValidDev(e.dev)) problems.push('dev must be 32 hex chars');
  if (!e.payload || typeof e.payload !== 'object') problems.push('payload must be an object');
  return problems;
}
