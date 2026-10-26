'use strict';
// Postgres for accounts. Production uses DATABASE_URL (Railway's Postgres). Outside production, with no
// DATABASE_URL, an in-memory Postgres (PGlite) is used so the site runs and tests without a database server.
// Without either, connect() returns null and the site serves downloads with accounts switched off.

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  failed_logins integer not null default 0,
  locked_until timestamptz
);
create unique index if not exists users_email_key on users (lower(email));
create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text
);
create index if not exists sessions_user_idx on sessions (user_id);
create table if not exists app_logins (
  device_hash text primary key,
  user_code text not null unique,
  user_id text references users(id) on delete cascade,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
`;

async function connect(env = process.env) {
  let db = null;
  if (env.DATABASE_URL) {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });
  } else if (env.NODE_ENV !== 'production') {
    try { const { PGlite } = require('@electric-sql/pglite'); db = new PGlite(); } catch { /* dev dependency not installed */ }
  }
  if (!db) return null;
  // PGlite runs multi-statement SQL through exec(); pg runs it through a parameterless query().
  await (db.exec ? db.exec(SCHEMA) : db.query(SCHEMA));
  return {
    query: (text, params) => db.query(text, params),
    async one(text, params) { return (await db.query(text, params)).rows[0] || null; },
    close: () => (db.end ? db.end() : db.close()),
  };
}

module.exports = { connect };
