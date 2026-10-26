'use strict';
// Accounts: sign-up, sign-in, sessions, password change, account deletion, and the desktop app's
// browser sign-in (device-code flow, like `gh auth login`).
// Passwords are hashed with scrypt; session tokens are random and only their SHA-256 is stored.
const crypto = require('crypto');
const { HttpError } = require('./security');

const WEB_SESSION_DAYS = 30;
const APP_SESSION_DAYS = 90;
const APP_LOGIN_MINUTES = 10;
const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function scrypt(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, , salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Spent on unknown emails too, so response time doesn't reveal which emails have accounts.
let dummyHash = null;
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'Enter a valid email address');
  return e;
}
function cleanPassword(v) {
  const p = String(v || '');
  if (p.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters');
  if (p.length > 200) throw new HttpError(400, 'That password is too long');
  return p;
}
function cleanName(v) {
  const n = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  if (!n) throw new HttpError(400, 'Enter your name');
  return n;
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

class Accounts {
  constructor(db) { this.db = db; }

  async createSession(userId, kind, userAgent) {
    const t = token();
    const days = kind === 'app' ? APP_SESSION_DAYS : WEB_SESSION_DAYS;
    await this.db.query(
      `insert into sessions (id, user_id, kind, expires_at, user_agent) values ($1, $2, $3, now() + ($4 || ' days')::interval, $5)`,
      [sha256(t), userId, kind, String(days), String(userAgent || '').slice(0, 300)],
    );
    return { token: t, maxAge: days * 86400 };
  }

  async userForToken(t) {
    if (!t || typeof t !== 'string' || t.length > 100) return null;
    const row = await this.db.one(
      `update sessions set last_seen_at = now() where id = $1 and expires_at > now()
       returning user_id, kind`, [sha256(t)]);
    if (!row) return null;
    const u = await this.db.one('select * from users where id = $1', [row.user_id]);
    return u ? { user: u, kind: row.kind } : null;
  }

  async signup({ email, password, name }, userAgent) {
    const e = cleanEmail(email);
    const p = cleanPassword(password);
    const n = cleanName(name);
    const id = 'usr_' + crypto.randomBytes(9).toString('base64url');
    const hash = await hashPassword(p);
    try {
      await this.db.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)', [id, e, n, hash]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
      throw err;
    }
    const u = await this.db.one('select * from users where id = $1', [id]);
    return { user: publicUser(u), session: await this.createSession(id, 'web', userAgent) };
  }

  async login({ email, password }, userAgent) {
    const e = String(email || '').trim().toLowerCase().slice(0, 254);
    const p = String(password || '').slice(0, 200);
    const u = e ? await this.db.one('select * from users where lower(email) = $1', [e]) : null;
    const fail = new HttpError(401, 'Email or password is incorrect');
    if (!u) { await verifyPassword(p, await getDummyHash()); throw fail; }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    }
    if (!(await verifyPassword(p, u.password_hash))) {
      await this.db.query(
        `update users set failed_logins = failed_logins + 1,
           locked_until = case when failed_logins + 1 >= $2 then now() + ($3 || ' minutes')::interval else locked_until end
         where id = $1`, [u.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)]);
      throw fail;
    }
    await this.db.query('update users set failed_logins = 0, locked_until = null where id = $1', [u.id]);
    return { user: publicUser(u), session: await this.createSession(u.id, 'web', userAgent) };
  }

  logout(t) { return this.db.query('delete from sessions where id = $1', [sha256(String(t || ''))]); }

  async changePassword(user, { current, password }, keepToken) {
    if (!(await verifyPassword(String(current || ''), user.password_hash))) throw new HttpError(401, 'Current password is incorrect');
    const p = cleanPassword(password);
    await this.db.query('update users set password_hash = $2 where id = $1', [user.id, await hashPassword(p)]);
    // Sign out every other browser and app.
    await this.db.query('delete from sessions where user_id = $1 and id <> $2', [user.id, sha256(keepToken)]);
  }

  async signOutEverywhere(user) { await this.db.query('delete from sessions where user_id = $1', [user.id]); }

  // beforeDelete runs only once the password checks out (it removes the person's cloud projects).
  async deleteAccount(user, { password }, beforeDelete) {
    if (!(await verifyPassword(String(password || ''), user.password_hash))) throw new HttpError(401, 'Password is incorrect');
    if (beforeDelete) await beforeDelete(user);
    await this.db.query('delete from users where id = $1', [user.id]); // sessions, app logins and workspace records cascade
  }

  async sessions(user, currentToken) {
    const r = await this.db.query(
      'select id, kind, created_at, last_seen_at, user_agent from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc limit 50', [user.id]);
    const cur = sha256(String(currentToken || ''));
    return r.rows.map((s) => ({ kind: s.kind, createdAt: s.created_at, lastSeenAt: s.last_seen_at, userAgent: s.user_agent, current: s.id === cur }));
  }

  // ---- desktop app sign-in ----
  // The app gets a secret device code (kept) and a short user code (shown to the person). The person
  // approves the user code on the website while signed in; the app polls with its device code.
  async startAppLogin() {
    const device = token();
    const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
    const pick = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
    const userCode = `${pick()}-${pick()}`;
    await this.db.query(
      `insert into app_logins (device_hash, user_code, expires_at) values ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [sha256(device), userCode, String(APP_LOGIN_MINUTES)]);
    return { deviceCode: device, userCode, expiresIn: APP_LOGIN_MINUTES * 60, interval: 3 };
  }

  async approveAppLogin(user, userCode) {
    const code = String(userCode || '').trim().toUpperCase().slice(0, 20);
    const r = await this.db.query(
      'update app_logins set approved = true, user_id = $2 where user_code = $1 and expires_at > now() and not approved returning user_code', [code, user.id]);
    if (!r.rows.length) throw new HttpError(404, 'That code has expired or was already used. Start again from the app.');
  }

  async pollAppLogin(deviceCode, userAgent) {
    const h = sha256(String(deviceCode || ''));
    const row = await this.db.one('select * from app_logins where device_hash = $1', [h]);
    if (!row || new Date(row.expires_at) <= new Date()) { if (row) await this.db.query('delete from app_logins where device_hash = $1', [h]); return { status: 'expired' }; }
    if (!row.approved) return { status: 'pending' };
    // Single use: the row goes as the app session is created.
    const del = await this.db.query('delete from app_logins where device_hash = $1 and approved returning user_id', [h]);
    if (!del.rows.length) return { status: 'expired' };
    const u = await this.db.one('select * from users where id = $1', [del.rows[0].user_id]);
    if (!u) return { status: 'expired' };
    const s = await this.createSession(u.id, 'app', userAgent);
    return { status: 'approved', token: s.token, user: publicUser(u) };
  }

  cleanup() {
    return Promise.all([
      this.db.query('delete from sessions where expires_at <= now()'),
      this.db.query('delete from app_logins where expires_at <= now()'),
    ]);
  }
}

module.exports = { Accounts, publicUser, hashPassword, verifyPassword };
