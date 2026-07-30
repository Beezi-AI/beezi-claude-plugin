import { getAccessToken as _getAccessToken } from './token.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { apiBase } from './config.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Claude Code runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// /beezi:login credentials the commands and hooks use (refresh included).
// Server→client push (the standing GET stream) is not bridged: the drafting
// tools are strictly request/response.

// Bounds a hung request, not normal tool latency (board writes take seconds).
const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_HEADER = 'mcp-session-id';
const NOT_LINKED_MESSAGE =
  'This machine is not linked to Beezi. Run /beezi:login in Claude Code, then retry.';
const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Run /beezi:login to relink.";

export function mcpUrl() {
  return process.env.BEEZI_MCP_URL ?? `${apiBase()}/mcp`;
}

// Yields the data payload of each SSE event (multi-line `data:` fields joined
// per the SSE spec). The server closes the stream once every response for the
// POST has been sent, which ends the iteration.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

export function createBridge(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const getToken = deps.getAccessToken ?? _getAccessToken;
  const url = deps.url ?? mcpUrl();
  const write = deps.write;
  const logError = deps.logError ?? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let sessionId = null;
  let initializeMsg = null;
  let reinit = null; // in-flight transparent re-initialize, shared by concurrent 404s

  const isInitialize = (msg) => !Array.isArray(msg) && msg.method === 'initialize';

  // Ids of the requests in the message (single or legacy batch); responses and
  // notifications carry none and get no synthesized error.
  function requestIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.method !== undefined)
      .map((m) => m.id);
  }

  function writeMessage(obj) {
    write(JSON.stringify(obj));
  }

  function errorResponse(id, message) {
    writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  async function post(msg, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
          ...machineHeaders(),
        },
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so
  // each lands as one line. `silent` drains instead — used for the transparent
  // re-initialize, whose response the client must not see twice.
  async function emit(res, { silent = false } = {}) {
    const newSession = res.headers.get(SESSION_HEADER);
    if (newSession) sessionId = newSession;
    if (res.status === 202 || res.status === 204) return;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for await (const data of sseEvents(res.body)) {
        if (!silent) writeMessage(JSON.parse(data));
      }
      return;
    }
    const text = await res.text();
    if (text && !silent) writeMessage(JSON.parse(text));
  }

  // The portal's MCP sessions are in-memory; an API restart between turns loses
  // them (HTTP 404). Rebuild one transparently — replay initialize (response
  // hidden) and the initialized notification — so the client never notices.
  function reinitialize(token) {
    reinit ??= (async () => {
      sessionId = null;
      const res = await post(initializeMsg, token);
      if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
      await emit(res, { silent: true });
      await emit(await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token));
    })().finally(() => {
      reinit = null;
    });
    return reinit;
  }

  async function serverErrorMessage(res) {
    try {
      const body = await res.json();
      // JSON-RPC errors nest under `error`; the portal's HTTP errors put the sentence at the
      // top level with `error` holding only the status name ("Forbidden"). Read both, so a
      // plan or permission refusal reaches the user in the server's own words.
      const message = body?.error?.message ?? (typeof body?.message === 'string' ? body.message : null);
      if (message) return `Beezi MCP error: ${message}`;
    } catch {
      /* non-JSON body */
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
  }

  async function handleMessage(msg) {
    const ids = requestIds(msg);
    let token = await getToken();
    if (!token) {
      ids.forEach((id) => errorResponse(id, NOT_LINKED_MESSAGE));
      return;
    }
    if (isInitialize(msg)) {
      initializeMsg = msg;
      sessionId = null;
    }
    try {
      let res = await post(msg, token);
      if (res.status === 404 && initializeMsg && !isInitialize(msg)) {
        await reinitialize(token);
        res = await post(msg, token);
      }
      // A 401 is the server telling us the token is dead — better evidence than the expires_at
      // we estimated locally, which is a pure guess when the token response omits expires_in.
      // Renew once on its word and retry, so a short-lived token doesn't strand the whole
      // MCP server until the user re-links by hand.
      if (res.status === 401) {
        const refreshed = await getToken({}, { forceRefresh: true }).catch(() => null);
        if (refreshed && refreshed !== token) {
          token = refreshed;
          res = await post(msg, token);
        }
      }
      if (res.ok) {
        await emit(res);
        return;
      }
      if (res.status === 401) {
        ids.forEach((id) => errorResponse(id, REJECTED_MESSAGE));
        return;
      }
      // 403 is authenticated-but-not-permitted: the account lacks access to this feature, and
      // no token can change that. Sending the user to /beezi:login (as a shared 401/403 branch
      // did) is advice that cannot work, so report what the server actually said.
      if (res.status === 403) {
        const forbidden = await serverErrorMessage(res);
        ids.forEach((id) => errorResponse(id, forbidden));
        return;
      }
      const message = await serverErrorMessage(res);
      ids.forEach((id) => errorResponse(id, message));
    } catch (error) {
      ids.forEach((id) =>
        errorResponse(id, `Beezi MCP request failed: ${error?.message ?? String(error)}`),
      );
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  return { handleLine, handleMessage };
}
