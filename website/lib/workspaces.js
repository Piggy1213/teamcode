'use strict';
// Cloud team workspaces: the TeamCode team server runs inside the website (mounted at /team) and stores
// workspaces on a persistent volume. Accounts own workspaces; Postgres records who owns which.
const crypto = require('crypto');
const { HttpError } = require('./security');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';

class Workspaces {
  constructor({ db, team, maxPerUser = 5 }) {
    Object.assign(this, { db, team, maxPerUser });
  }

  // What a client needs to join: the same fields as an invite code.
  _invite(row, base) {
    const w = this.team.coordinator.get(row.id);
    if (!w) return null;
    return { workspace: row.id, name: row.name, url: `${base}/team`, token: w.token, createdAt: row.created_at };
  }

  async list(user, base) {
    const r = await this.db.query('select * from workspaces where owner_id = $1 order by created_at desc', [user.id]);
    return r.rows.map((row) => this._invite(row, base)).filter(Boolean);
  }

  async create(user, { name }, base) {
    const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
    if (!n) throw new HttpError(400, 'Give the project a name');
    const { rows } = await this.db.query('select count(*)::int as n from workspaces where owner_id = $1', [user.id]);
    if (rows[0].n >= this.maxPerUser) throw new HttpError(403, `You can host up to ${this.maxPerUser} projects on TeamCode cloud. Delete one first.`);
    const id = `${slug(n)}-${crypto.randomBytes(4).toString('hex')}`;
    // Record ownership first, so a failure can't leave an unowned workspace on the volume.
    await this.db.query('insert into workspaces (id, owner_id, name) values ($1, $2, $3)', [id, user.id, n]);
    try {
      this.team.coordinator.ensureWorkspace(id, { name: n, token: crypto.randomBytes(24).toString('hex') });
    } catch (e) {
      await this.db.query('delete from workspaces where id = $1', [id]).catch(() => {});
      throw e;
    }
    return this._invite({ id, name: n, created_at: new Date() }, base);
  }

  async remove(user, { id }) {
    const r = await this.db.query('delete from workspaces where id = $1 and owner_id = $2 returning id', [String(id || ''), user.id]);
    if (!r.rows.length) throw new HttpError(404, 'Project not found');
    this.team.removeWorkspace(r.rows[0].id);
  }

  // Before an account is deleted: remove the workspaces it owns, files included.
  async removeAllFor(user) {
    const r = await this.db.query('select id from workspaces where owner_id = $1', [user.id]);
    for (const row of r.rows) this.team.removeWorkspace(row.id);
  }
}

module.exports = { Workspaces };
