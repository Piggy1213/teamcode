'use strict';
// Invite codes bundle everything a teammate needs to join: server URL, workspace id, token and name.
const PREFIX = 'tc1.';

function encodeInvite({ url, workspace, token, name }) {
  return PREFIX + Buffer.from(JSON.stringify({ u: url, w: workspace, k: token, n: name })).toString('base64url');
}

function decodeInvite(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(PREFIX)) throw new Error('That does not look like a TeamCode invite code (it should start with "tc1.")');
  try {
    const o = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!o.u || !o.w || !o.k) throw new Error();
    return { url: o.u.replace(/\/+$/, ''), workspace: o.w, token: o.k, name: o.n || o.w };
  } catch {
    throw new Error('Invite code is damaged — ask your teammate to copy it again');
  }
}

module.exports = { encodeInvite, decodeInvite };
