// ============================================================================
// PulseVR Life — store selector (CONTRACT §2, §7)
// DATABASE_URL set → Neon Postgres (production). Unset → JSON file fallback.
// Game logic never knows which adapter is active; both expose the same
// async interface: init, getMemberById, getAllMembers, saveMember,
// getAdminById, getAllAdmins, saveAdmin, getListings, saveListing,
// deleteListing, getMessages, saveMessage, deleteMessage,
// deleteMessagesFor, clearMessages, getMeta, setMeta, close.
// ============================================================================

const path = require('path');
const { FileStore } = require('./store-file');
const { PgStore } = require('./store-pg');

function createStore() {
  if (process.env.DATABASE_URL) {
    return { store: new PgStore(process.env.DATABASE_URL), kind: 'postgres' };
  }
  const file = process.env.DATA_FILE
    || path.join(__dirname, '..', 'data', 'pulsevr-life.json');
  return { store: new FileStore(file), kind: 'file' };
}

module.exports = { createStore };
