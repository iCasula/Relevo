// Relevo Companion transport for Node: TLS 1.2 with a pre-shared key (TLS_PSK_WITH_AES_128_GCM_SHA256, the
// suite Network.framework offers) and WebSocket framing for JSON messages. Both ends: the host serves
// iPhones, and the desktop app connects to hosts as an iPhone would. No dependencies: WebSocket is small
// enough to do by hand.

import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 << 20;
const TLS_OPTIONS = {
  ciphers: 'PSK-AES128-GCM-SHA256',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
};

/** Same derivation as CompanionTransport.parameters on Apple platforms. */
export function pskKey(secret) {
  return crypto.createHmac('sha256', secret).update('relevo-companion-v1').digest();
}

/**
 * Listens for paired iPhones. Emits 'connection' with a WebSocketPeer once the handshake is done.
 * Only a client that knows the pairing secret completes TLS.
 */
export function createCompanionServer({ serverId, secret, port, host = '::' }, onPeer) {
  const psk = pskKey(secret);
  const server = tls.createServer({
    pskCallback: (_socket, identity) => (identity === serverId ? psk : null),
    pskIdentityHint: serverId,
    ...TLS_OPTIONS,
    // Every connection proves the current key (no session tickets to resume).
    secureOptions: crypto.constants.SSL_OP_NO_TICKET,
  }, (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    acceptWebSocket(socket, onPeer);
  });
  server.on('tlsClientError', () => {}); // wrong key, scanners: nothing to do
  server.listen(port, host);
  return server;
}

/**
 * Connects to a host like the iPhone does: TLS-PSK with the pairing secret, then a WebSocket. Resolves with a
 * WebSocketPeer; rejects with an error whose `reason` is 'key' (the host doesn't know this secret), 'refused'
 * or 'unreachable'.
 */
export function connectCompanion({ host, port, serverId, secret, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    const psk = pskKey(secret);
    let settled = false;
    const fail = (reason, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(Object.assign(new Error(message), { reason }));
    };
    const socket = tls.connect({
      host, port, ...TLS_OPTIONS,
      pskCallback: () => ({ psk, identity: serverId }),
      checkServerIdentity: () => undefined, // no certificate: the key is the proof
      session: undefined,
    });
    const timer = setTimeout(() => fail('unreachable', `${host}: sin respuesta`), timeout);
    socket.on('error', (e) => {
      const tlsAlert = /alert|handshake|decrypt|psk/i.test(e.message) || e.code?.startsWith?.('ERR_SSL');
      fail(e.code === 'ECONNREFUSED' ? 'refused' : tlsAlert ? 'key' : 'unreachable', `${host}: ${e.message}`);
    });
    socket.on('close', () => fail('key', `${host}: la conexión se cerró durante el saludo`));
    socket.once('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
      socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) { if (head.length > 16_384) fail('unreachable', `${host}: respuesta inválida`); return; }
        socket.off('data', onData);
        const response = head.subarray(0, end).toString('latin1');
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(response) || !response.toLowerCase().includes(accept.toLowerCase())) {
          fail('unreachable', `${host}: no es un host de Relevo`);
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 5000);
        const peer = new WebSocketPeer(socket, { client: true });
        const rest = head.subarray(end + 4);
        if (rest.length) peer._feed(rest);
        resolve(peer);
      };
      socket.on('data', onData);
    });
  });
}

/** A WebSocket on a plain HTTP server (the desktop app's page on 127.0.0.1); the caller checks who it is. */
export function acceptHTTPUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const peer = new WebSocketPeer(socket);
  if (head?.length) peer._feed(head);
  return peer;
}

function acceptWebSocket(socket, onPeer) {
  let head = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), 10_000);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > 16_384) socket.destroy();
      return;
    }
    socket.off('data', onData);
    clearTimeout(timer);
    const lines = head.subarray(0, end).toString('latin1').split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const key = headers['sec-websocket-key'];
    if (!/^GET /.test(lines[0]) || (headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const peer = new WebSocketPeer(socket);
    onPeer(peer);
    const rest = head.subarray(end + 4);
    if (rest.length) peer._feed(rest);
  };
  socket.on('data', onData);
  socket.on('error', () => socket.destroy());
}

/** One WebSocket connection. Emits 'message' (Buffer) and 'close'. */
export class WebSocketPeer extends EventEmitter {
  /** `client`: frames are masked, as RFC 6455 requires from the connecting side. */
  constructor(socket, { client = false } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.remote = socket.remoteAddress;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    // Keeps NAT/VPN mappings alive and notices iPhones that vanished.
    this.pinger = setInterval(() => this._frame(0x9, Buffer.alloc(0)), 20_000);
  }

  send(object) {
    if (!this.closed) this._frame(0x2, Buffer.from(JSON.stringify(object)));
  }

  close() {
    if (this.closed) return;
    this._frame(0x8, Buffer.alloc(0));
    this.socket.end();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.socket.destroy();
    this.emit('close');
  }

  _frame(opcode, payload) {
    if (this.socket.destroyed) return;
    const n = payload.length;
    let header;
    if (n < 126) {
      header = Buffer.from([0x80 | opcode, n]);
    } else if (n < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(n, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2);
    }
    if (this.client) {
      header[1] |= 0x80;
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      this.socket.write(Buffer.concat([header, mask, masked]));
      return;
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); offset = 10;
      }
      if (len > MAX_MESSAGE) { this.close(); return; }
      const maskLen = masked ? 4 : 0;
      if (b.length < offset + maskLen + len) return;
      const mask = masked ? b.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(b.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(offset + maskLen + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments);
          this.fragments = [];
          this.emit('message', message);
        }
      }
    }
  }
}
