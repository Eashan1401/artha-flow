// ARTHA FLOW websocket hub. Hand rolled, zero dependencies.
//
// What this file does, in plain English:
//   1. It answers the HTTP upgrade for the path /ws and does the handshake.
//   2. It reads frames a browser sends us. Browsers always mask their frames.
//   3. It writes frames back. A server never masks.
//   4. It pings every 30 seconds and drops a socket that missed two pongs.
//   5. It broadcasts engine events to whoever asked for them.
//
// FRAGMENTATION DECISION (the contract asks us to state it):
//   We BUFFER continuation frames and join them into one message.
//   A message starts with a text or binary frame that has fin = 0, then carries on
//   through opcode 0 frames, and finishes on the first opcode 0 frame with fin = 1.
//   Control frames (ping, pong, close) are allowed in the middle and are handled
//   straight away, because the spec allows them to be injected mid message.
//   We cap one joined message at MAX_MESSAGE bytes. Over that we close with 1009,
//   which stops a bad or hostile client eating memory one small frame at a time.
//   We only speak JSON text. A binary message gets a clean 1003 close, not a crash.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Opcodes from RFC 6455.
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Close codes we use.
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

// Limits. These exist so a week of uptime cannot grow without a ceiling.
const MAX_MESSAGE = 1 * 1024 * 1024;      // biggest joined message we will accept
const MAX_READ_BUFFER = 2 * 1024 * 1024;  // biggest half read frame we will hold
const MAX_WRITE_BACKLOG = 4 * 1024 * 1024; // a socket this far behind gets dropped
const PING_EVERY_MS = 30_000;
const MAX_MISSED_PONGS = 2;

/**
 * Build the websocket hub.
 *
 * options:
 *   version         string, sent in the hello message
 *   getWaitingPrompts  function returning a number, sent in the hello message
 *   allowedOrigins  array of exact origin strings that may connect. An upgrade with
 *                   no Origin header is allowed, because curl and the CLI send none.
 *                   A browser on another site always sends one, so this blocks it.
 */
export function createWsHub({ version = '0.0.0', getWaitingPrompts = () => 0, allowedOrigins = [] } = {}) {
  /** @type {Set<object>} every live client */
  const clients = new Set();
  let nextId = 1;
  let closed = false;

  const pingTimer = setInterval(pingEveryone, PING_EVERY_MS);
  // Do not hold the process open just for the ping timer.
  if (typeof pingTimer.unref === 'function') pingTimer.unref();

  function handleUpgrade(req, socket, head) {
    // Anything that fails here gets a plain HTTP answer and the socket ends.
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const versionHeader = String(req.headers['sec-websocket-version'] || '');

    if (upgrade !== 'websocket' || !key) {
      return refuse(socket, 400, 'Bad websocket request.');
    }
    if (versionHeader && versionHeader !== '13') {
      return refuse(socket, 426, 'Websocket version 13 only.', 'Sec-WebSocket-Version: 13\r\n');
    }
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
      // This blocks a page on another site from opening a socket to our local tool.
      return refuse(socket, 403, 'Origin not allowed.');
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      '\r\n'
    );

    socket.setNoDelay(true);
    // No socket level timeout. We do our own liveness with ping and pong.
    socket.setTimeout(0);

    const client = {
      id: nextId++,
      socket,
      buf: Buffer.alloc(0),
      frag: null,            // { opcode, chunks, size } while a message is split up
      missedPongs: 0,
      all: false,            // subscribed to everything
      runIds: new Set(),     // subscribed to these run ids only
      closing: false,
      openedAt: Date.now()
    };
    clients.add(client);

    socket.on('data', (chunk) => onData(client, chunk));
    socket.on('error', () => drop(client));
    socket.on('close', () => drop(client));
    socket.on('end', () => drop(client));

    // The upgrade may have carried the first bytes of the first frame with it.
    if (head && head.length) onData(client, head);

    send(client, { type: 'hello', version, waitingPrompts: safeWaiting() });
  }

  function safeWaiting() {
    try {
      const n = getWaitingPrompts();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  function refuse(socket, status, message, extraHeaders = '') {
    const text = {
      400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required'
    }[status] || 'Error';
    try {
      socket.write(
        'HTTP/1.1 ' + status + ' ' + text + '\r\n' +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'Content-Length: ' + Buffer.byteLength(message) + '\r\n' +
        extraHeaders +
        '\r\n' + message
      );
    } catch {
      // The socket already went. Nothing to do.
    }
    try { socket.destroy(); } catch { /* already gone */ }
  }

  // ---------------------------------------------------------------- reading

  function onData(client, chunk) {
    if (client.closing || client.socket.destroyed) return;

    client.buf = client.buf.length ? Buffer.concat([client.buf, chunk]) : chunk;

    if (client.buf.length > MAX_READ_BUFFER) {
      // A frame header claiming a huge body, or a client that never finishes a frame.
      return closeSocket(client, CLOSE_TOO_BIG, 'Frame too big.');
    }

    // Read as many whole frames as the buffer currently holds.
    for (;;) {
      if (client.closing || client.socket.destroyed) return;
      let frame;
      try {
        frame = readFrame(client.buf);
      } catch (err) {
        return closeSocket(client, err.wsCode || CLOSE_PROTOCOL_ERROR, err.message);
      }
      if (!frame) break;                              // not enough bytes yet, wait
      client.buf = client.buf.subarray(frame.consumed);
      handleFrame(client, frame);
    }
  }

  /**
   * Try to read one whole frame from the front of buf.
   * Returns null when we do not have all the bytes yet, which is normal.
   * Throws on a protocol error, with err.wsCode set to the close code to send.
   */
  function readFrame(buf) {
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw protocolError('Reserved bits must be zero.');

    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) {
        const e = new Error('Frame longer than the limit.');
        e.wsCode = CLOSE_TOO_BIG;
        throw e;
      }
      len = Number(big);
      offset = 10;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    // Copy the payload out. We must copy, because we unmask in place and the
    // source buffer is shared with the bytes of the next frame.
    const payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset, offset + len);
    if (mask) {
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    }

    return { fin, opcode, masked, payload, consumed: offset + len };
  }

  function protocolError(message) {
    const e = new Error(message);
    e.wsCode = CLOSE_PROTOCOL_ERROR;
    return e;
  }

  function handleFrame(client, frame) {
    const { fin, opcode, masked, payload } = frame;

    // A client must always mask. An unmasked client frame is a protocol error.
    if (!masked) return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'Client frames must be masked.');

    // Control frames: never fragmented, never longer than 125 bytes.
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) {
        return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'Bad control frame.');
      }
      if (opcode === OP_PING) return writeFrame(client, OP_PONG, payload);
      if (opcode === OP_PONG) { client.missedPongs = 0; return; }
      if (opcode === OP_CLOSE) {
        // Echo the close code back, then end. This is the clean close.
        let code = CLOSE_NORMAL;
        if (payload.length >= 2) code = payload.readUInt16BE(0);
        if (code < 1000 || code === 1004 || code === 1005 || code === 1006) code = CLOSE_PROTOCOL_ERROR;
        return closeSocket(client, code, '');
      }
      return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'Unknown control opcode.');
    }

    // Data frames.
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (client.frag) return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'New message started before the last one finished.');
      if (fin) return deliver(client, opcode, payload);
      client.frag = { opcode, chunks: [payload], size: payload.length };
      return;
    }

    if (opcode === OP_CONTINUATION) {
      if (!client.frag) return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'Continuation frame with nothing to continue.');
      client.frag.size += payload.length;
      if (client.frag.size > MAX_MESSAGE) {
        client.frag = null;
        return closeSocket(client, CLOSE_TOO_BIG, 'Message too big.');
      }
      client.frag.chunks.push(payload);
      if (!fin) return;
      const joined = Buffer.concat(client.frag.chunks, client.frag.size);
      const op = client.frag.opcode;
      client.frag = null;
      return deliver(client, op, joined);
    }

    return closeSocket(client, CLOSE_PROTOCOL_ERROR, 'Unknown opcode.');
  }

  function deliver(client, opcode, payload) {
    if (opcode === OP_BINARY) {
      // We only ever speak JSON text on this socket.
      return closeSocket(client, CLOSE_UNSUPPORTED_DATA, 'This socket only takes text.');
    }
    if (payload.length > MAX_MESSAGE) {
      return closeSocket(client, CLOSE_TOO_BIG, 'Message too big.');
    }

    const text = payload.toString('utf8');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // A bad message from one client should not kill the feed for everyone.
      return send(client, { type: 'error', message: 'Message was not valid JSON.' });
    }
    onMessage(client, msg, text);
  }

  function onMessage(client, msg, rawText) {
    if (!msg || typeof msg !== 'object') {
      return send(client, { type: 'error', message: 'Message must be a JSON object.' });
    }
    switch (msg.type) {
      case 'subscribe': {
        if (msg.all === true) {
          client.all = true;
          client.runIds.clear();
          return send(client, { type: 'subscribed', all: true });
        }
        const runId = Number(msg.runId);
        if (!Number.isInteger(runId) || runId <= 0) {
          return send(client, { type: 'error', message: 'subscribe needs runId or all:true.' });
        }
        // Cap how many runs one socket can watch, so a loop client cannot grow a set forever.
        if (client.runIds.size >= 500) client.runIds.clear();
        client.runIds.add(runId);
        return send(client, { type: 'subscribed', runId });
      }
      case 'unsubscribe': {
        if (msg.all === true) { client.all = false; client.runIds.clear(); return send(client, { type: 'unsubscribed', all: true }); }
        const runId = Number(msg.runId);
        client.runIds.delete(runId);
        return send(client, { type: 'unsubscribed', runId });
      }
      case 'ping':
        // Application level ping, not the protocol one. Answer in JSON.
        return send(client, { type: 'pong', ts: new Date().toISOString() });
      case 'echo':
        // Small helper used by our own tests. It sends back the length we received,
        // which is how we prove long and fragmented frames arrive whole.
        return send(client, { type: 'echo', length: rawText.length, bytes: Buffer.byteLength(rawText) });
      default:
        return send(client, { type: 'error', message: 'Unknown message type: ' + String(msg.type) });
    }
  }

  // ---------------------------------------------------------------- writing

  /** Build one unmasked server frame. */
  function encodeFrame(opcode, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = body.length;
    let header;

    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;   // fin set, server frames are never fragmented
      header[1] = len;             // no mask bit, servers never mask
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, body], header.length + len);
  }

  function writeFrame(client, opcode, payload) {
    if (client.socket.destroyed || !client.socket.writable) return false;
    try {
      client.socket.write(encodeFrame(opcode, payload));
    } catch {
      drop(client);
      return false;
    }
    // A reader that stopped reading must not be allowed to fill our memory.
    if (client.socket.writableLength > MAX_WRITE_BACKLOG) {
      drop(client);
      return false;
    }
    return true;
  }

  /** Send one JSON object to one client. */
  function send(client, obj) {
    let text;
    try {
      text = JSON.stringify(obj);
    } catch {
      return false;
    }
    return writeFrame(client, OP_TEXT, Buffer.from(text, 'utf8'));
  }

  function closeSocket(client, code, reason) {
    if (client.closing) return;
    client.closing = true;
    try {
      const reasonBuf = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      if (client.socket.writable && !client.socket.destroyed) {
        client.socket.write(encodeFrame(OP_CLOSE, payload));
      }
    } catch {
      // The socket may already be gone. That is fine, we are closing anyway.
    }
    // Give the close frame a moment to leave, then hang up.
    const t = setTimeout(() => { try { client.socket.destroy(); } catch { /* gone */ } }, 200);
    if (typeof t.unref === 'function') t.unref();
    try { client.socket.end(); } catch { /* gone */ }
    drop(client);
  }

  function drop(client) {
    if (!clients.has(client)) return;
    clients.delete(client);
    client.buf = Buffer.alloc(0);
    client.frag = null;
  }

  function pingEveryone() {
    if (closed) return;
    for (const client of [...clients]) {
      if (client.socket.destroyed) { drop(client); continue; }
      if (client.missedPongs >= MAX_MISSED_PONGS) {
        // Two pings went out with no pong back. The other side is gone.
        try { client.socket.destroy(); } catch { /* gone */ }
        drop(client);
        continue;
      }
      client.missedPongs++;
      writeFrame(client, OP_PING, Buffer.alloc(0));
    }
  }

  // ---------------------------------------------------------------- outward

  /**
   * Send one engine event to every socket that asked for it.
   *
   * Routing rule, stated plainly so nobody has to guess:
   *   - a socket with all:true gets every event
   *   - a socket subscribed to run 7 gets only events carrying runId 7
   *   - an event with no runId goes to all:true sockets only
   */
  function broadcast(event) {
    if (!event || typeof event !== 'object') return 0;
    let text;
    try {
      text = JSON.stringify(event);
    } catch {
      return 0;
    }
    const frame = encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
    const runId = event.runId === undefined || event.runId === null ? null : Number(event.runId);

    let sent = 0;
    for (const client of [...clients]) {
      const wants = client.all || (runId !== null && client.runIds.has(runId));
      if (!wants) continue;
      if (client.socket.destroyed || !client.socket.writable) { drop(client); continue; }
      try {
        client.socket.write(frame);
        if (client.socket.writableLength > MAX_WRITE_BACKLOG) { drop(client); continue; }
        sent++;
      } catch {
        drop(client);
      }
    }
    return sent;
  }

  function clientCount() {
    return clients.size;
  }

  function close() {
    closed = true;
    clearInterval(pingTimer);
    for (const client of [...clients]) {
      closeSocket(client, CLOSE_GOING_AWAY, 'Server shutting down.');
    }
    clients.clear();
  }

  return { handleUpgrade, broadcast, clientCount, close, CLOSE_POLICY };
}
