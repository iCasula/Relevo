// Push notifications to the iPhone through Apple's APNs, with your own APNs key (.p8): the host signs a short
// token with it (ES256) and posts each notification over HTTP/2. No third party in between.

import http2 from 'node:http2';
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The provider token APNs asks for: valid up to an hour, renewed after 40 minutes. */
export function providerToken({ teamId, keyId, key }, now = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const input = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: crypto.createPrivateKey(key), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

/** Whether a .p8 key can be read (without sending anything). */
export function validKey(key) {
  try { return crypto.createPrivateKey(String(key ?? '')).asymmetricKeyType === 'ec'; } catch { return false; }
}

export class APNs {
  constructor(getConfig, log = () => {}) {
    this.getConfig = getConfig; // () => { teamId, keyId, key } or null
    this.log = log;
    this.jwt = null;
    this.sessions = new Map();
  }

  _token(config) {
    if (this.jwt && this.jwt.keyId === config.keyId && Date.now() - this.jwt.at < 40 * 60_000) return this.jwt.token;
    this.jwt = { token: providerToken(config), at: Date.now(), keyId: config.keyId };
    return this.jwt.token;
  }

  _session(host) {
    let s = this.sessions.get(host);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(`https://${host}`);
    s.on('error', () => {});
    s.on('close', () => this.sessions.delete(host));
    s.setTimeout(5 * 60_000, () => s.close());
    this.sessions.set(host, s);
    return s;
  }

  /**
   * One notification to one device. Resolves { ok, status, reason }; a token APNs no longer accepts comes back
   * with gone: true so the host forgets it.
   */
  send(device, { title, body, threadId, serverId, kind }) {
    const config = this.getConfig();
    if (!config) return Promise.resolve({ ok: false, reason: 'Falta la clave APNs' });
    let token;
    try { token = this._token(config); } catch (e) { return Promise.resolve({ ok: false, reason: `Clave APNs no válida: ${e.message}` }); }
    const host = device.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
    const payload = JSON.stringify({
      aps: { alert: { title: String(title).slice(0, 120), body: String(body ?? '').slice(0, 400) }, sound: 'default', 'thread-id': threadId ?? 'relevo', 'interruption-level': 'time-sensitive' },
      threadId, serverId, kind,
    });
    return new Promise((resolve) => {
      let req;
      try {
        req = this._session(host).request({
          ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${token}`,
          'apns-topic': device.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
        });
      } catch (e) { resolve({ ok: false, reason: e.message }); return; }
      let status = 0, data = '';
      req.setTimeout(20_000, () => { req.close(); resolve({ ok: false, reason: 'APNs no responde' }); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (d) => { data += d; });
      req.on('error', (e) => resolve({ ok: false, reason: e.message }));
      req.on('end', () => {
        let reason = null;
        try { reason = JSON.parse(data || '{}').reason ?? null; } catch {}
        if (['InvalidProviderToken', 'ExpiredProviderToken'].includes(reason)) this.jwt = null;
        resolve({ ok: status === 200, status, reason, gone: status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason) });
      });
      req.end(payload);
    });
  }

  close() { for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}
