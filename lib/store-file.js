// ============================================================================
// PulseVR Life — JSON file store (local/dev/test fallback, CONTRACT §2, §7)
// Atomic writes: write a temp file in the same directory, then rename.
// All writes are serialized through a promise chain so concurrent socket
// actions cannot interleave a read/write pair.
// ============================================================================

const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { members: [], admins: [], listings: [], messages: [], meta: {} };
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data.members = Array.isArray(parsed.members) ? parsed.members : [];
        this.data.admins = Array.isArray(parsed.admins) ? parsed.admins : [];
        this.data.listings = Array.isArray(parsed.listings) ? parsed.listings : [];
        this.data.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        this.data.meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // corrupt file: fail loudly, don't wipe
      // No file yet — start empty; seeding happens in lib/seed.js.
    }
  }

  // Run fn exclusively, then persist. Read-only callers bypass the queue.
  async _mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn();
      await this._write();
      return result;
    });
    // Keep the chain alive even if one write fails.
    this.queue = run.catch(() => {});
    return run;
  }

  async _write() {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.data), 'utf8');
    await fs.promises.rename(tmp, this.filePath);
  }

  async getMemberById(id) {
    return this.data.members.find((m) => m.memberId === id) || null;
  }

  async getAllMembers() { return this.data.members.map((m) => ({ ...m })); }

  async saveMember(m) {
    return this._mutate(() => {
      const i = this.data.members.findIndex((x) => x.memberId === m.memberId);
      if (i >= 0) this.data.members[i] = { ...m };
      else this.data.members.push({ ...m });
    });
  }

  async getAdminById(id) {
    return this.data.admins.find((a) => a.adminId === id) || null;
  }

  async getAllAdmins() { return this.data.admins.map((a) => ({ ...a })); }

  // saveAdmin honors a transient `prevId`: when an admin changes their ID
  // (admin:changeId), the old record is replaced, not duplicated.
  async saveAdmin(a) {
    return this._mutate(() => {
      const { prevId, ...rest } = a;
      const i = this.data.admins.findIndex((x) => x.adminId === a.adminId || (prevId && x.adminId === prevId));
      if (i >= 0) this.data.admins[i] = { ...rest };
      else this.data.admins.push({ ...rest });
    });
  }

  async getListings() { return this.data.listings.map((l) => ({ ...l })); }

  async saveListing(l) {
    return this._mutate(() => {
      const i = this.data.listings.findIndex((x) => x.id === l.id);
      if (i >= 0) this.data.listings[i] = { ...l };
      else this.data.listings.push({ ...l });
    });
  }

  async deleteListing(id) {
    return this._mutate(() => {
      this.data.listings = this.data.listings.filter((x) => x.id !== id);
    });
  }

  // --- v2: private messages (same JSON-doc pattern as listings) ------------
  async getMessages() { return this.data.messages.map((m) => ({ ...m })); }

  async saveMessage(m) {
    return this._mutate(() => {
      const i = this.data.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) this.data.messages[i] = { ...m };
      else this.data.messages.push({ ...m });
    });
  }

  async deleteMessage(id) {
    return this._mutate(() => {
      this.data.messages = this.data.messages.filter((x) => x.id !== id);
    });
  }

  async deleteMessagesFor(memberId) {
    return this._mutate(() => {
      this.data.messages = this.data.messages.filter(
        (x) => x.fromMemberId !== memberId && x.toMemberId !== memberId);
    });
  }

  async clearMessages() {
    return this._mutate(() => { this.data.messages = []; });
  }

  async getMeta(key) {
    const v = this.data.meta[key];
    return v === undefined ? null : v;
  }

  async setMeta(key, value) {
    return this._mutate(() => { this.data.meta[key] = value; });
  }

  async close() { /* nothing to close for a file */ }
}

module.exports = { FileStore };
