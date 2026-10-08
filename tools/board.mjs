#!/usr/bin/env node
// board - a CLI over the board hub's HTTP API.
//
// schema-v2 §3: "A CLI (board list|add|move|comment) over that HTTP is a
// convenience, not a second protocol." So this authors real events with its own
// dev id and HLC and posts them to the hub; it does not have a private way in.
// Anything the CLI can do, curl can do.
//
//   board boards                     the boards on the hub
//   board show <board>               lists and cards
//   board add <board> <list> <title> a new card at the end of that list
//   board move <board> <card> <list> move a card
//   board comment <board> <card> <text>
//   board events <board> [since]     the board's event stream (for agents)
//
//   --hub <url>    or $BOARD_HUB     default http://localhost:8407
//   --json                           machine-readable output
//
// Ids may be given as a unique prefix. Lists may be given by title.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../contract/hlc.mjs';
import { ev } from '../contract/events.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const jsonOut = has('--json');
const hub = (flag('--hub', null) || process.env.BOARD_HUB || 'http://localhost:8407').replace(/\/$/, '');
const [cmd, ...args] = argv;

// --- this CLI is one device in the log --------------------------------------
// A stable dev id, so its events are attributable and its HLC is monotonic across
// invocations. A new dev every run would still fold, but the log would fill with
// identities and no one could tell which writes were the CLI's.
const STATE_DIR = join(homedir(), '.config', 'shrooms-board');
const CLI_STATE = join(STATE_DIR, 'cli.json');
function cliDev() {
  if (existsSync(CLI_STATE)) {
    try {
      const s = JSON.parse(readFileSync(CLI_STATE, 'utf8'));
      if (typeof s.dev === 'string' && /^[0-9a-f]{32}$/.test(s.dev)) return s.dev;
    } catch { /* fall through and rewrite it */ }
  }
  const dev = randomBytes(16).toString('hex');
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CLI_STATE, JSON.stringify({ dev }, null, 2));
  return dev;
}
const clock = new Clock(cliDev());

// --- talking to the hub -----------------------------------------------------
async function get(path) {
  const r = await fetch(hub + path);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(hub + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* leave it null */ }
  if (r.status !== 202 && r.status !== 200) {
    throw new Error(`POST ${path} -> ${r.status} ${text.slice(0, 300)}`);
  }
  return parsed;
}
const send = (boardId, events) => post(`/boards/${encodeURIComponent(boardId)}/events`, { events });

// --- resolving things a human would type ------------------------------------
// Ids are UUIDs and nobody types those. A unique prefix is enough, and an
// ambiguous one is an error rather than a guess.
function pick(items, wanted, what, key = 'id') {
  const exact = items.find((i) => i[key] === wanted);
  if (exact) return exact;
  const hits = items.filter((i) => String(i[key]).startsWith(wanted));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`${what} "${wanted}" is ambiguous: ${hits.map((h) => h[key].slice(0, 8)).join(', ')}`);
  }
  throw new Error(`no ${what} matches "${wanted}"`);
}
async function resolveBoard(wanted) {
  const { boards } = await get('/boards');
  if (!boards.length) throw new Error('the hub has no boards yet');
  if (!wanted) {
    if (boards.length > 1) throw new Error(`which board? ${boards.map((b) => `${b.id.slice(0, 8)} (${b.title || 'untitled'})`).join(', ')}`);
    return boards[0];
  }
  return pick(boards, wanted, 'board');
}
async function resolveList(board, wanted) {
  const st = await get(`/boards/${encodeURIComponent(board.id)}/state`);
  const byTitle = st.lists.find((l) => (l.title || '').toLowerCase() === wanted.toLowerCase());
  return byTitle || pick(st.lists, wanted, 'list');
}
async function resolveCard(board, wanted) {
  const st = await get(`/boards/${encodeURIComponent(board.id)}/state`);
  const byTitle = st.cards.filter((c) => (c.title || '').toLowerCase() === wanted.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`two cards are titled "${wanted}" - use an id prefix`);
  return pick(st.cards, wanted, 'card');
}

// --- commands ---------------------------------------------------------------
async function cmdBoards() {
  const { boards, head } = await get('/boards');
  if (jsonOut) return console.log(JSON.stringify({ boards, head }, null, 2));
  if (!boards.length) return console.log('no boards');
  for (const b of boards) console.log(`${b.id.slice(0, 8)}  ${b.title || '(untitled)'}`);
}

async function cmdShow(boardArg) {
  const board = await resolveBoard(boardArg);
  const st = await get(`/boards/${encodeURIComponent(board.id)}/state`);
  if (jsonOut) return console.log(JSON.stringify(st, null, 2));
  console.log(`${board.title || '(untitled)'}  [${board.id.slice(0, 8)}]`);
  for (const l of st.lists) {
    const cards = st.cards.filter((c) => c.list_id === l.id);
    console.log(`  ${l.title || '(untitled)'}  [${l.id.slice(0, 8)}]  ${cards.length} card(s)`);
    for (const c of cards) {
      const who = (c.assignees || []).length ? `  @${c.assignees.join(' @')}` : '';
      console.log(`    ${c.id.slice(0, 8)}  ${c.title}${who}`);
    }
  }
  const orphan = st.cards.filter((c) => !st.lists.some((l) => l.id === c.list_id));
  for (const c of orphan) console.log(`  (no list)  ${c.id.slice(0, 8)}  ${c.title}`);
  const inv = st.invariants || {};
  if (inv.ok === false) console.log(`  !! invariants: ${JSON.stringify(inv.problems)}`);
}

async function cmdAdd(boardArg, listArg, title) {
  if (!listArg || !title) throw new Error('usage: board add <board> <list> <title>');
  const board = await resolveBoard(boardArg);
  const list = await resolveList(board, listArg);
  const st = await get(`/boards/${encodeURIComponent(board.id)}/state`);
  const pos = st.cards.filter((c) => c.list_id === list.id).reduce((m, c) => Math.max(m, c.pos || 0), 0) + 1000;
  const id = randomUUID();
  const res = await send(board.id, [ev.cardCreate(id, list.id, title, pos, clock, board.id)]);
  if (jsonOut) return console.log(JSON.stringify({ card: id, list: list.id, pos, result: res }, null, 2));
  console.log(`added ${id.slice(0, 8)} to ${list.title || list.id.slice(0, 8)}`);
}

async function cmdMove(boardArg, cardArg, listArg) {
  if (!cardArg || !listArg) throw new Error('usage: board move <board> <card> <list>');
  const board = await resolveBoard(boardArg);
  const card = await resolveCard(board, cardArg);
  const list = await resolveList(board, listArg);
  const res = await send(board.id, [ev.cardEdit(card.id, { list_id: list.id }, clock, board.id)]);
  if (jsonOut) return console.log(JSON.stringify({ card: card.id, list: list.id, result: res }, null, 2));
  console.log(`moved ${card.id.slice(0, 8)} to ${list.title || list.id.slice(0, 8)}`);
}

async function cmdComment(boardArg, cardArg, text) {
  if (!cardArg || !text) throw new Error('usage: board comment <board> <card> <text>');
  const board = await resolveBoard(boardArg);
  const card = await resolveCard(board, cardArg);
  const id = randomUUID();
  const res = await send(board.id, [ev.commentCreate(id, card.id, text, clock, board.id)]);
  if (jsonOut) return console.log(JSON.stringify({ comment: id, card: card.id, result: res }, null, 2));
  console.log(`commented on ${card.id.slice(0, 8)}`);
}

async function cmdEvents(boardArg, since) {
  const board = await resolveBoard(boardArg);
  const q = since !== undefined ? `?since=${encodeURIComponent(since)}` : '';
  const res = await get(`/boards/${encodeURIComponent(board.id)}/events${q}`);
  if (jsonOut) return console.log(JSON.stringify(res, null, 2));
  for (const r of res.events) {
    const p = r.event.payload || {};
    console.log(`${String(r.seq).padStart(4)}  ${r.event.type.padEnd(15)} ${(p.title || p.id || '').toString().slice(0, 50)}`);
  }
  console.log(`head ${res.head}`);
}

// --- main -------------------------------------------------------------------
const USAGE = `board - a CLI over the board hub

  board boards                          the boards on the hub
  board show <board>                    lists and cards
  board add <board> <list> <title>      a new card at the end of that list
  board move <board> <card> <list>      move a card
  board comment <board> <card> <text>   comment on a card
  board events <board> [since]          the board's event stream

  --hub <url>   the hub (default $BOARD_HUB, else http://localhost:8407)
  --json        machine-readable output

Ids may be unique prefixes; lists may be given by title.`;

const commands = {
  boards: cmdBoards,
  show: cmdShow,
  add: cmdAdd,
  move: cmdMove,
  comment: cmdComment,
  events: cmdEvents,
};

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    process.exit(1);
  }
  await fn(...args);
} catch (err) {
  console.error(`board: ${err.message}`);
  process.exit(1);
}
