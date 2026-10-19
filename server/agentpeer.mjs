// Talking to an agent, wherever it lives.
//
// THE RULE, measured on 19/10 17:18: a shrooms-agent REFUSES any HTTP request that arrives from
// this machine's own mesh address and says why —
//     403 {"error":"a request from this machine's own mesh address: on this machine, use the
//                  agent's socket (/run/user/1000/shrooms-agent/agent.sock)"}
// The hub only ever addressed machines by mesh name, so after the agent restarted, the board
// could not see the sessions on its OWN machine: 123 failed bridge polls against pi5, and the
// tasks unsurfaced. The fix is not to loosen the agent — it is to use the socket it tells you to.
//
// So the decision lives here, once: local machine -> unix socket, anyone else -> mesh HTTP.
// Both are injected so the rule can be tested without a live agent on either side.
import { request as httpRequest } from 'node:http';

export const DEFAULT_SOCKET = () =>
  `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/shrooms-agent/agent.sock`;

export function makeAgentPeer({
  self,
  meshSuffix = 'office.mesh',
  port = 7387,
  socketPath = DEFAULT_SOCKET,
  fetchImpl = (...a) => fetch(...a),
  defaultTimeoutMs = 6000,
} = {}) {
  const socket = () => (typeof socketPath === 'function' ? socketPath() : socketPath);
  const isLocal = (machine) => String(machine) === String(self);

  const url = (machine, path) =>
    `http://${/[.:]/.test(machine) ? machine : `${machine}.${meshSuffix}`}:${port}${path}`;

  function overSocket(path, { method = 'GET', body, timeoutMs } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath: socket(), path, method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: buf }));
      });
      req.setTimeout(timeoutMs || defaultTimeoutMs,
        () => req.destroy(new Error(`agent socket ${path} -> timeout`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function getJSON(machine, path, timeoutMs) {
    if (isLocal(machine)) {
      const r = await overSocket(path, { timeoutMs });
      if (r.status < 200 || r.status >= 300) throw new Error(`GET socket ${path} -> ${r.status}`);
      return JSON.parse(r.text || '{}');
    }
    const u = url(machine, path);
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs || defaultTimeoutMs) });
    if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
    return r.json();
  }

  async function postJSON(machine, path, body, timeoutMs) {
    if (isLocal(machine)) {
      const r = await overSocket(path, { method: 'POST', body, timeoutMs });
      // the SAME shape as the remote branch, so a caller cannot tell them apart (and so the
      // status is available to the a2a interpreter rather than swallowed here)
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.text };
    }
    const u = url(machine, path);
    const r = await fetchImpl(u, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || defaultTimeoutMs),
    });
    return { ok: r.ok, status: r.status, text: await r.text().catch(() => '') };
  }

  return { isLocal, url, getJSON, postJSON, socketPath: socket };
}
