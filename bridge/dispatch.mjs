// shrooms-board — pointing an agent at a card (docs/task-bridge.md, build order step 3).
//
// The order is the whole point, and the review found the bug in the first draft:
//
//   1. derive the messageId FROM THE CARD, and so derive task_ref before anything is sent
//   2. write task_ref to the card
//   3. only then send
//
// Sending first and writing the ref from the reply duplicates the work: if the bridge dies
// in between, it comes back, sees a dispatch with no ref, and starts a SECOND agent turn on
// the same card. shrooms-agent treats a repeated messageId as the same task ("a messageId
// seen before is the same task"), so with this order a crash anywhere replays into the same
// task instead of a new one.
//
// The bridge never reads a card's prose to decide anything: if dispatch was not asked for,
// nothing is sent. It does put the card's title and description in the MESSAGE, because
// that is what the agent is being asked to work on.

import { Clock } from '../contract/hlc.mjs';
import { ev } from '../contract/events.mjs';
import { BRIDGE_DEV } from '../engine/engine.mjs';

// Stable per (card, dispatch request). The dispatch request is an event id, so asking
// twice from the same card event is the SAME task, and a new request makes a new one.
export function dispatchMessageId(cardId, dispatchEventId) {
  const card = String(cardId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const req = String(dispatchEventId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  if (!card || !req) throw new Error('dispatchMessageId needs a card id and a dispatch event id');
  return `board-${card}-${req}`;
}

export function dispatchRef(machine, session, messageId) {
  return `${machine}/${session}:${messageId}`;
}

// What the agent is asked to work on. The card id is in the text so a human reading the
// task can find the card, and so the agent can quote it back.
export function dispatchText(card) {
  const lines = [`Card ${card.id} on the shrooms board: ${card.title || '(untitled)'}`];
  if (card.desc) lines.push('', card.desc);
  lines.push('', 'Reply on the card by updating this task; the board reflects your task state.');
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {(args: {machine: string, session: string, messageId: string, text: string}) => Promise<any>} deps.send
 * @param {(events: Array) => void} deps.appendEvents
 * @param {(msg: string) => void} [deps.log]
 */
export function createDispatcher({ send, appendEvents, log = () => {} }) {
  const clock = new Clock(BRIDGE_DEV);

  // Returns { ref, messageId, wrote }. The link is written BEFORE the send, always.
  async function dispatch({ card, machine, session, dispatchEventId }) {
    if (!card || !card.id) throw new Error('dispatch needs a card');
    if (!machine || !session) throw new Error('dispatch needs a machine and a session');
    const messageId = dispatchMessageId(card.id, dispatchEventId);
    const ref = dispatchRef(machine, session, messageId);

    // 1. the link first. If we die now, the next attempt derives the SAME ref and the
    //    agent sees the SAME messageId, so no second turn starts.
    appendEvents([ev.cardEdit(card.id, { task_ref: ref }, clock, card.board_id)]);

    // 2. then send. A failure here is NOT fatal: the ref is already on the card, so the
    //    bridge's reflection will show `unknown` until the task exists, and a retry
    //    re-sends the same messageId - which is the same task, not a new one.
    try {
      await send({ machine, session, messageId, text: dispatchText(card) });
      return { ref, messageId, sent: true };
    } catch (err) {
      log(`dispatch: ${machine}/${session} send failed (${err.message}); the link is on the card and a retry reuses the same task`);
      return { ref, messageId, sent: false };
    }
  }

  return { dispatch, dev: BRIDGE_DEV };
}
