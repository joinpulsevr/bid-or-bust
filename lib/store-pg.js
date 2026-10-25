// ============================================================================
// PulseVR Life — Neon Postgres store via `pg` (CONTRACT §2, §7)
// Production adapter, selected when DATABASE_URL is set. Tables store one
// JSONB document per row so the §7 interface stays identical to the file
// adapter. Neon requires SSL; rejectUnauthorized:false matches Neon's
// hosted certs (standard for server-side pool connections).
// ============================================================================

const { Pool } = require('pg');

class PgStore {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS members  (member_id TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS admins   (admin_id  TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS listings  (id        TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS messages  (id        TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS meta      (key       TEXT PRIMARY KEY, value JSONB NOT NULL);
    `);
  }

  async getMemberById(id) {
    const r = await this.pool.query('SELECT data FROM members WHERE member_id = $1', [id]);
    return r.rows.length ? r.rows[0].data : null;
  }

  async getAllMembers() {
    const r = await this.pool.query('SELECT data FROM members');
    return r.rows.map((row) => row.data);
  }

  async saveMember(m) {
    await this.pool.query(
      `INSERT INTO members (member_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (member_id) DO UPDATE SET data = EXCLUDED.data`,
      [m.memberId, JSON.stringify(m)],
    );
  }

  async getAdminById(id) {
    const r = await this.pool.query('SELECT data FROM admins WHERE admin_id = $1', [id]);
    return r.rows.length ? r.rows[0].data : null;
  }

  async getAllAdmins() {
    const r = await this.pool.query('SELECT data FROM admins');
    return r.rows.map((row) => row.data);
  }

  // Honors transient `prevId` for admin:changeId (old row replaced).
  async saveAdmin(a) {
    const { prevId, ...rest } = a;
    if (prevId && prevId !== a.adminId) {
      await this.pool.query('DELETE FROM admins WHERE admin_id = $1', [prevId]);
    }
    await this.pool.query(
      `INSERT INTO admins (admin_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (admin_id) DO UPDATE SET data = EXCLUDED.data`,
      [a.adminId, JSON.stringify(rest)],
    );
  }

  async getListings() {
    const r = await this.pool.query('SELECT data FROM listings');
    return r.rows.map((row) => row.data);
  }

  async saveListing(l) {
    await this.pool.query(
      `INSERT INTO listings (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [l.id, JSON.stringify(l)],
    );
  }

  async deleteListing(id) {
    await this.pool.query('DELETE FROM listings WHERE id = $1', [id]);
  }

  // --- v2: private messages (same JSON-doc pattern as listings) ------------
  async getMessages() {
    const r = await this.pool.query('SELECT data FROM messages');
    return r.rows.map((row) => row.data);
  }

  async saveMessage(m) {
    await this.pool.query(
      `INSERT INTO messages (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [m.id, JSON.stringify(m)],
    );
  }

  async deleteMessage(id) {
    await this.pool.query('DELETE FROM messages WHERE id = $1', [id]);
  }

  async deleteMessagesFor(memberId) {
    await this.pool.query(
      'DELETE FROM messages WHERE data->>\'fromMemberId\' = $1 OR data->>\'toMemberId\' = $1',
      [memberId],
    );
  }

  async clearMessages() {
    await this.pool.query('DELETE FROM messages');
  }

  async getMeta(key) {
    const r = await this.pool.query('SELECT value FROM meta WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  }

  async setMeta(key, value) {
    await this.pool.query(
      `INSERT INTO meta (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async close() { await this.pool.end(); }
}

module.exports = { PgStore };
