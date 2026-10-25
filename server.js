// ============================================================================
// PulseVR Life — live server game for Join PulseVR
// Express + Socket.IO. Mirrors the Bid or Bust layout (server.js + public/).
//
// SECURITY (CONTRACT §5, §8 — non-negotiable):
// - The server NEVER sends the member roster, any member ID except a
//   player's own (to that player only), or any admin ID to a client.
// - Leaderboard and marketplace payloads carry names only, never IDs.
// - All money, prices, stock and salaries come from the server catalog.
//   Client-supplied amounts are ignored.
// - Member sockets may only use player events; admin sockets only admin
//   events. Unauthenticated sockets get nothing but auth failures.
// - express.static serves ONLY public/.
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const { createStore } = require('./lib/store');
const { seedIfEmpty } = require('./lib/seed');
const catalogLib = require('./lib/catalog');
const game = require('./lib/game');

const { applyOverrides, getHome, getCar, getCareer, MBA_PRICE, SHIFT_CAP, promotionGate } = catalogLib;

const PORT = process.env.PORT || 3000;
const DAY_MS = Number(process.env.DAY_MS) || 120000;
const PLAY_FLUSH_MS = 60000;
// v2 knobs (production defaults = the real rules; the sim test compresses
// them so the suite stays fast — see README "v2 rules").
//   SHIFT_WINDOW_MS: rolling window for the 3-shift cap (default 24h).
//   PROMO_PLAYTIME_SCALE: multiplier on promotion playtime thresholds.
//   UTILITY_INTERVAL_DAYS: day-cycles between utility charges (default 30).
const SHIFT_WINDOW_MS = Number(process.env.SHIFT_WINDOW_MS || 86400000);
const PROMO_PLAYTIME_SCALE = Number(process.env.PROMO_PLAYTIME_SCALE || 1);
const UTILITY_INTERVAL_DAYS = Number(process.env.UTILITY_INTERVAL_DAYS || 30);
const TIERS = ['Rookie', 'Rising Star', 'VIP', 'Elite', 'Legend'];

const MILESTONE_NAMES = {
  'first-login': 'First Login',
  'first-job': 'First Shift Worked',
  'first-promotion': 'First Promotion',
  'first-home': 'First Home',
  'first-car': 'First Car',
  'first-sale': 'First Marketplace Sale',
  mba: 'MBA Purchased',
  ceo: 'Reached CEO',
  'rich-50k': 'Net Worth $50,000',
  'rich-100k': 'Net Worth $100,000',
  top1: 'Leaderboard #1',
};

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'pulsevr-life' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const { store, kind: storeKind } = createStore();

// --- socket registries (server-side only) ---------------------------------
const memberSockets = new Map(); // memberId -> Set<socket>
const adminSockets = new Map();  // adminId -> Set<socket>

function track(socket, map, key) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
}
function untrack(socket, map, key) {
  const set = map.get(key);
  if (set) { set.delete(socket); if (set.size === 0) map.delete(key); }
}
function authedSockets() {
  const out = [];
  for (const s of io.sockets.sockets.values()) if (s.data.auth) out.push(s);
  return out;
}
function emitToPlayer(memberId, event, data) {
  const set = memberSockets.get(memberId);
  if (set) for (const s of set) s.emit(event, data);
}
function emitToAdmin(adminId, event, data) {
  const set = adminSockets.get(adminId);
  if (set) for (const s of set) s.emit(event, data);
}

// --- catalog / day state ----------------------------------------------------
async function getCatalog() {
  const overrides = await store.getMeta('catalog');
  const catalog = applyOverrides(overrides);
  // Effective promotion gates (with the server's playtime scale) so the
  // client shows the same requirements the server enforces.
  catalog.promotionGates = {
    0: promotionGate(0, PROMO_PLAYTIME_SCALE),
    1: promotionGate(1, PROMO_PLAYTIME_SCALE),
  };
  return catalog;
}
async function getDay() {
  const day = await store.getMeta('day');
  return typeof day === 'number' ? day : 1;
}

// --- playtime points --------------------------------------------------------
// Per-socket accrual: +1 pt per 10s connected, tracked server-side.
// Each socket remembers the last wall-clock it flushed at; `carry` holds
// leftover seconds (< 10) so fractional flushes lose nothing.
function accruePlayExact(socket, player) {
  const play = socket.data.play;
  if (!play) return { pointsGained: 0 };
  const now = Date.now();
  const elapsed = (now - play.last) / 1000;
  const total = play.carry + elapsed;
  const pts = Math.floor(total / 10);
  play.carry = total - pts * 10;
  play.last = now;
  player.playSeconds = (player.playSeconds || 0) + Math.floor(elapsed);
  player.points = (player.points || 0) + pts;
  return { pointsGained: pts };
}

async function loadPlayerForSocket(socket) {
  const auth = socket.data.auth;
  if (!auth || auth.role !== 'member') return null;
  const player = await store.getMemberById(auth.memberId);
  if (!player) return null;
  accruePlayExact(socket, player);
  return player;
}

// --- milestones ---------------------------------------------------------------
function grantMilestone(player, id) {
  const milestones = player.milestones || [];
  if (milestones.includes(id)) return false;
  milestones.push(id);
  player.milestones = milestones;
  player.points = (player.points || 0) + 25;
  return true;
}
function toastMilestones(socketOrMemberId, unlocked) {
  for (const id of unlocked) {
    const toast = { title: 'Milestone Unlocked!', text: `${MILESTONE_NAMES[id] || id} — +25 pts`, delta: 25 };
    if (typeof socketOrMemberId === 'string') emitToPlayer(socketOrMemberId, 'game:event', toast);
    else socketOrMemberId.emit('game:event', toast);
  }
}

// v2: tile-reward toasts. Cash/tax rewards carry a delta; the exclusive car
// carries no delta (the toast text names the car instead).
function toastTileRewards(memberId, granted) {
  for (const g of granted) {
    const toast = { title: 'Tile Reward!', text: `${g.title} — ${g.text}` };
    if (g.kind !== 'car') toast.delta = g.amount;
    emitToPlayer(memberId, 'game:event', toast);
  }
}

// After a mutation: check rich/top1 milestones, persist (write-through
// BEFORE any ack is emitted), then push fresh state + leaderboard.
async function postAction(changedPlayers) {
  const all = await store.getAllMembers();
  const board = game.buildLeaderboard(all);
  const top1Name = board.length ? board[0].name : null;
  const catalog = await getCatalog();
  const day = await getDay();
  for (const player of changedPlayers) {
    const unlocked = [];
    const isTop1 = !!(top1Name && player.name === top1Name);
    // Apply milestone checks to the caller's (already mutated) object.
    const gained = game.checkMilestones(player, { isTop1 });
    unlocked.push(...gained);
    // v2: tile rewards for the player's new net worth (once-only).
    const tileGranted = game.applyTileRewards(player);
    await store.saveMember(player);
    if (unlocked.length) toastMilestones(player.memberId, unlocked);
    if (tileGranted.length) toastTileRewards(player.memberId, tileGranted);
    emitToPlayer(player.memberId, 'player:state', { player: game.publicPlayer(player, catalog, day) });
  }
  broadcastLeaderboard(board);
}

function broadcastLeaderboard(board) {
  const data = { leaderboard: board };
  for (const s of authedSockets()) s.emit('game:leaderboard', data);
}
async function broadcastAll() {
  const all = await store.getAllMembers();
  broadcastLeaderboard(game.buildLeaderboard(all));
  const listings = game.publicListings(await store.getListings());
  for (const s of authedSockets()) s.emit('game:marketplace', { listings });
}

// --- day cycle ------------------------------------------------------------------
let cycling = false;
async function runDayCycle() {
  if (cycling) return null;
  cycling = true;
  try {
    const catalog = await getCatalog();
    const all = await store.getAllMembers();
    const day = (await getDay()) + 1;
    const results = game.applyDayCycle(all, catalog, { day, utilityIntervalDays: UTILITY_INTERVAL_DAYS });
    // v2: tile rewards for post-cycle net worth (once-only per tile).
    for (const r of results) r.tileGranted = game.applyTileRewards(r.player);
    for (const { player } of results) await store.saveMember(player);
    await store.setMeta('day', day);
    // Milestones from the cycle (rich thresholds + top1).
    const board = game.buildLeaderboard(all);
    const top1Name = board.length ? board[0].name : null;
    for (const { player, events, utilityCharged, tileGranted } of results) {
      const unlocked = game.checkMilestones(player, { isTop1: !!(top1Name && player.name === top1Name) });
      if (unlocked.length || tileGranted.length) await store.saveMember(player);
      for (const ev of events) emitToPlayer(player.memberId, 'game:event', ev);
      if (utilityCharged > 0) {
        emitToPlayer(player.memberId, 'game:event', {
          title: 'Utilities Due',
          text: `Monthly utilities for your homes: -$${utilityCharged.toLocaleString()}`,
          delta: -utilityCharged,
        });
      }
      if (unlocked.length) toastMilestones(player.memberId, unlocked);
      if (tileGranted.length) toastTileRewards(player.memberId, tileGranted);
      emitToPlayer(player.memberId, 'player:state', { player: game.publicPlayer(player, catalog, day) });
    }
    for (const s of authedSockets()) s.emit('game:day', { day });
    broadcastLeaderboard(board);
    const listings = game.publicListings(await store.getListings());
    for (const s of authedSockets()) s.emit('game:marketplace', { listings });
    return day;
  } finally {
    cycling = false;
  }
}

// --- auth helpers ---------------------------------------------------------------
function newToken() { return crypto.randomBytes(24).toString('hex'); }

async function sendAuthSuccess(socket, role, account, player) {
  const catalog = await getCatalog();
  const all = await store.getAllMembers();
  const day = await getDay();
  const payload = {
    ok: true,
    role,
    token: account.token,
    catalog,
    leaderboard: game.buildLeaderboard(all),
    marketplace: game.publicListings(await store.getListings()),
    day,
  };
  if (role === 'member') payload.player = game.publicPlayer(player, catalog, day);
  else payload.admin = { name: account.name }; // NEVER an admin ID
  socket.emit('auth:result', payload);
}

function requireRole(socket, role) {
  if (!socket.data.auth || socket.data.auth.role !== role) {
    socket.emit('error', { message: 'Not authorized for this action.' });
    return false;
  }
  return true;
}

// v2: private mailbox. Sends ONLY the caller's own messages (names only,
// never member IDs) plus their unread count.
async function sendMailbox(socket, memberId) {
  try {
    const messages = await store.getMessages();
    socket.emit('mail:inbox', {
      messages: game.publicInbox(messages, memberId),
      unread: game.unreadCount(messages, memberId),
    });
  } catch { /* mailbox is best-effort; login already succeeded */ }
}

// ============================================================================
// Socket wiring
// ============================================================================
io.on('connection', (socket) => {
  socket.data.auth = null;
  socket.data.play = null;

  socket.on('auth:login', async (body) => {
    try {
      const data = body || {};
      const role = data.role;
      if (role !== 'member' && role !== 'admin') {
        socket.emit('auth:result', { ok: false, error: 'Invalid ID' });
        return;
      }
      // Resume with a stored token.
      if (data.token) {
        if (role === 'member') {
          const members = await store.getAllMembers();
          const player = members.find((m) => m.token === data.token);
          if (!player) { socket.emit('auth:result', { ok: false, error: 'Invalid ID' }); return; }
          if (player.removedAt) {
            socket.emit('auth:result', { ok: false, error: 'This player account is currently removed. Contact an admin.' });
            return;
          }
          socket.data.auth = { role: 'member', memberId: player.memberId };
          socket.data.play = { last: Date.now(), carry: 0 };
          track(socket, memberSockets, player.memberId);
          // v2: first login also ACTIVATES the player (inactive players
          // stay at $10,000, skipped by day cycles, until this moment).
          let loginChanged = false;
          if (!player.firstLoginAt) {
            player.firstLoginAt = new Date().toISOString();
            grantMilestone(player, 'first-login');
            loginChanged = true;
            toastMilestones(player.memberId, ['first-login']);
          }
          if (!player.active) { player.active = true; loginChanged = true; }
          if (loginChanged) await store.saveMember(player);
          await sendAuthSuccess(socket, 'member', player, player);
          await sendMailbox(socket, player.memberId);
        } else {
          const admins = await store.getAllAdmins();
          const admin = admins.find((a) => a.token === data.token);
          if (!admin) { socket.emit('auth:result', { ok: false, error: 'Invalid ID' }); return; }
          socket.data.auth = { role: 'admin', adminId: admin.adminId };
          track(socket, adminSockets, admin.adminId);
          await sendAuthSuccess(socket, 'admin', admin, null);
        }
        return;
      }
      // Fresh login with an ID.
      if (role === 'member') {
        const id = String(data.id || '').trim().toUpperCase();
        const player = await store.getMemberById(id);
        if (!player) { socket.emit('auth:result', { ok: false, error: 'Invalid ID' }); return; }
        if (player.removedAt) {
          socket.emit('auth:result', { ok: false, error: 'This player account is currently removed. Contact an admin.' });
          return;
        }
        if (!player.token) { player.token = newToken(); }
        let grantedFirstLogin = false;
        if (!player.firstLoginAt) {
          player.firstLoginAt = new Date().toISOString();
          grantedFirstLogin = grantMilestone(player, 'first-login');
        }
        // v2: first login activates the player (see token path above).
        if (!player.active) player.active = true;
        await store.saveMember(player);
        socket.data.auth = { role: 'member', memberId: player.memberId };
        socket.data.play = { last: Date.now(), carry: 0 };
        track(socket, memberSockets, player.memberId);
        await sendAuthSuccess(socket, 'member', player, player);
        await sendMailbox(socket, player.memberId);
        if (grantedFirstLogin) toastMilestones(player.memberId, ['first-login']);
      } else {
        const id = String(data.id || ''); // admins: exact match, no transform
        const admin = await store.getAdminById(id);
        if (!admin) { socket.emit('auth:result', { ok: false, error: 'Invalid ID' }); return; }
        if (!admin.token) { admin.token = newToken(); }
        await store.saveAdmin(admin);
        socket.data.auth = { role: 'admin', adminId: admin.adminId };
        track(socket, adminSockets, admin.adminId);
        await sendAuthSuccess(socket, 'admin', admin, null);
      }
    } catch (err) {
      socket.emit('error', { message: 'Login failed. Please try again.' });
    }
  });

  // --- player events ------------------------------------------------------
  socket.on('player:workShift', async () => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      if (!player.career) return socket.emit('error', { message: 'Pick a career first.' });
      const cur = game.currentLevel(player);
      if (!cur) return socket.emit('error', { message: 'Invalid career state.' });
      // v2: shift cap — max SHIFT_CAP shifts per rolling SHIFT_WINDOW_MS.
      // This is an overtime-progress game: no unlimited grinding.
      const nowMs = Date.now();
      const recent = game.pruneShiftHistory(player.shiftHistory, nowMs, SHIFT_WINDOW_MS);
      if (recent.length >= SHIFT_CAP) {
        return socket.emit('error', { message: `Shift limit reached — you can work ${SHIFT_CAP} shifts every 24 hours. Try again later.` });
      }
      player.shiftHistory = [...recent, nowMs];
      player.cash += cur.level.salary;
      player.careers[player.career].shifts = cur.shifts + 1;
      const firstJob = grantMilestone(player, 'first-job');
      await store.saveMember(player);
      if (firstJob) toastMilestones(player.memberId, ['first-job']);
      await postAction([player]);
    } catch { socket.emit('error', { message: 'Shift failed. Please try again.' }); }
  });

  socket.on('player:promote', async () => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const cur = game.currentLevel(player);
      if (!cur) return socket.emit('error', { message: 'Pick a career first.' });
      // v2: promotion needs BOTH the shift count AND cumulative playtime.
      const gate = promotionGate(cur.levelIndex, PROMO_PLAYTIME_SCALE);
      if (cur.shifts < gate.shifts) {
        return socket.emit('error', { message: `You need ${gate.shifts} shifts at this level to promote (${cur.shifts}/${gate.shifts}).` });
      }
      const played = player.playSeconds || 0;
      if (played < gate.playSeconds) {
        return socket.emit('error', { message: `You need ${gate.playSeconds}s of playtime to promote (you have ${played}s). Keep playing!` });
      }
      if (cur.levelIndex >= cur.career.levels.length - 1) {
        return socket.emit('error', { message: 'You are already at the top of this ladder.' });
      }
      player.careers[player.career].level = cur.levelIndex + 1;
      player.careers[player.career].shifts = 0;
      const firstPromo = grantMilestone(player, 'first-promotion');
      const reachedCeo = player.career === 'ceo' && cur.levelIndex + 1 === 2 ? grantMilestone(player, 'ceo') : false;
      await store.saveMember(player);
      if (firstPromo) toastMilestones(player.memberId, ['first-promotion']);
      if (reachedCeo) toastMilestones(player.memberId, ['ceo']);
      await postAction([player]);
    } catch { socket.emit('error', { message: 'Promotion failed. Please try again.' }); }
  });

  socket.on('player:buyMBA', async () => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      if (player.mba) return socket.emit('error', { message: 'You already own the MBA.' });
      if (player.cash < MBA_PRICE) return socket.emit('error', { message: `MBA costs $${MBA_PRICE.toLocaleString()}.` });
      player.cash -= MBA_PRICE;
      player.mba = true;
      const got = grantMilestone(player, 'mba');
      await store.saveMember(player);
      if (got) toastMilestones(player.memberId, ['mba']);
      await postAction([player]);
    } catch { socket.emit('error', { message: 'MBA purchase failed. Please try again.' }); }
  });

  socket.on('player:switchCareer', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const career = getCareer((body || {}).career);
      if (!career) return socket.emit('error', { message: 'Unknown career.' });
      if (career.mbaRequired && !player.mba) {
        return socket.emit('error', { message: 'The CEO track requires the MBA ($5,000).' });
      }
      player.career = career.id;
      if (!player.careers[career.id]) player.careers[career.id] = { level: 0, shifts: 0 };
      await store.saveMember(player);
      await postAction([player]);
    } catch { socket.emit('error', { message: 'Career switch failed. Please try again.' }); }
  });

  socket.on('player:buyHome', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const catalog = await getCatalog();
      const home = catalog.homes.find((h) => h.id === (body || {}).homeId);
      if (!home) return socket.emit('error', { message: 'Unknown home.' });
      if (home.stock !== null && home.stock <= 0) return socket.emit('error', { message: 'This home is sold out.' });
      if (player.cash < home.price) return socket.emit('error', { message: 'Not enough cash for this home.' });
      player.cash -= home.price;
      player.homes.push({
        instanceId: crypto.randomBytes(12).toString('hex'),
        homeId: home.id, name: home.name, value: home.price,
        purchasePrice: home.price, rent: home.rent,
        listedPrice: null, listingId: null,
      });
      // v2: first home owned starts the utility schedule (due one full
      // interval from the current day; the schedule then persists).
      if (player.nextUtilityDay == null) {
        player.nextUtilityDay = (await getDay()) + UTILITY_INTERVAL_DAYS;
      }
      const firstHome = grantMilestone(player, 'first-home');
      // Stock decrement persists BEFORE the client is told it succeeded.
      if (home.stock !== null) {
        const overrides = (await store.getMeta('catalog')) || {};
        if (!overrides.homes) overrides.homes = {};
        overrides.homes[home.id] = { ...(overrides.homes[home.id] || {}), stock: home.stock - 1 };
        await store.setMeta('catalog', overrides);
      }
      await store.saveMember(player);
      if (firstHome) toastMilestones(player.memberId, ['first-home']);
      await postAction([player]);
      for (const s of authedSockets()) s.emit('game:catalog', { catalog: await getCatalog() });
    } catch { socket.emit('error', { message: 'Home purchase failed. Please try again.' }); }
  });

  socket.on('player:buyCar', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const catalog = await getCatalog();
      const car = catalog.cars.find((c) => c.id === (body || {}).carId);
      if (!car) return socket.emit('error', { message: 'Unknown car.' });
      if (car.stock !== null && car.stock <= 0) return socket.emit('error', { message: 'This car is sold out.' });
      if (player.cash < car.price) return socket.emit('error', { message: 'Not enough cash for this car.' });
      player.cash -= car.price;
      player.cars.push({ carId: car.id, name: car.name, price: car.price });
      const firstCar = grantMilestone(player, 'first-car');
      if (car.stock !== null) {
        const overrides = (await store.getMeta('catalog')) || {};
        if (!overrides.cars) overrides.cars = {};
        overrides.cars[car.id] = { ...(overrides.cars[car.id] || {}), stock: car.stock - 1 };
        await store.setMeta('catalog', overrides);
      }
      await store.saveMember(player);
      if (firstCar) toastMilestones(player.memberId, ['first-car']);
      await postAction([player]);
      for (const s of authedSockets()) s.emit('game:catalog', { catalog: await getCatalog() });
    } catch { socket.emit('error', { message: 'Car purchase failed. Please try again.' }); }
  });

  socket.on('player:listHome', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const home = (player.homes || []).find((h) => h.homeId === (body || {}).homeId && !h.listingId);
      if (!home) return socket.emit('error', { message: 'You do not own an unlisted home of that type.' });
      let price = Math.floor(Number((body || {}).price));
      if (!Number.isFinite(price)) return socket.emit('error', { message: 'Listing price must be a number.' });
      price = Math.min(10000000, Math.max(100, price)); // server clamps
      const listing = {
        id: crypto.randomBytes(12).toString('hex'),
        homeId: home.homeId, homeName: home.name, price,
        sellerName: player.name, sellerMemberId: player.memberId,
        value: home.value, instanceId: home.instanceId,
      };
      await store.saveListing(listing);
      home.listedPrice = price;
      home.listingId = listing.id;
      await store.saveMember(player);
      await postAction([player]);
      const listings = game.publicListings(await store.getListings());
      for (const s of authedSockets()) s.emit('game:marketplace', { listings });
    } catch { socket.emit('error', { message: 'Listing failed. Please try again.' }); }
  });

  socket.on('player:unlistHome', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const listings = await store.getListings();
      const listing = listings.find((l) => l.id === (body || {}).listingId);
      if (!listing || listing.sellerMemberId !== player.memberId) {
        return socket.emit('error', { message: 'Listing not found.' });
      }
      await store.deleteListing(listing.id);
      const home = (player.homes || []).find((h) => h.instanceId === listing.instanceId);
      if (home) { home.listedPrice = null; home.listingId = null; }
      await store.saveMember(player);
      await postAction([player]);
      const fresh = game.publicListings(await store.getListings());
      for (const s of authedSockets()) s.emit('game:marketplace', { listings: fresh });
    } catch { socket.emit('error', { message: 'Unlist failed. Please try again.' }); }
  });

  socket.on('player:buyListing', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const buyer = await loadPlayerForSocket(socket);
      if (!buyer) return socket.emit('error', { message: 'Player not found.' });
      const listings = await store.getListings();
      const listing = listings.find((l) => l.id === (body || {}).listingId);
      if (!listing) return socket.emit('error', { message: 'Listing not found.' });
      if (listing.sellerMemberId === buyer.memberId) {
        return socket.emit('error', { message: 'You cannot buy your own listing.' });
      }
      if (buyer.cash < listing.price) return socket.emit('error', { message: 'Not enough cash for this listing.' });
      const seller = await store.getMemberById(listing.sellerMemberId);
      if (!seller || seller.removedAt) return socket.emit('error', { message: 'Seller is no longer available.' });
      const home = (seller.homes || []).find((h) => h.instanceId === listing.instanceId);
      if (!home) return socket.emit('error', { message: 'That home is no longer listed.' });
      seller.homes = seller.homes.filter((h) => h.instanceId !== listing.instanceId);
      seller.cash += listing.price;
      const firstSale = grantMilestone(seller, 'first-sale');
      buyer.cash -= listing.price;
      buyer.homes.push({ ...home, listedPrice: null, listingId: null });
      // v2: a marketplace purchase is also a first home owned (same rule).
      if (buyer.nextUtilityDay == null) {
        buyer.nextUtilityDay = (await getDay()) + UTILITY_INTERVAL_DAYS;
      }
      await store.deleteListing(listing.id);
      await store.saveMember(seller);
      await store.saveMember(buyer);
      if (firstSale) toastMilestones(seller.memberId, ['first-sale']);
      await postAction([seller, buyer]);
      const fresh = game.publicListings(await store.getListings());
      for (const s of authedSockets()) s.emit('game:marketplace', { listings: fresh });
    } catch { socket.emit('error', { message: 'Purchase failed. Please try again.' }); }
  });

  socket.on('player:logout', async () => {
    try {
      if (socket.data.auth && socket.data.auth.role === 'member') {
        const player = await loadPlayerForSocket(socket);
        if (player) { player.token = null; await store.saveMember(player); }
        untrack(socket, memberSockets, socket.data.auth.memberId);
      }
    } catch { /* logout must not throw */ }
    socket.data.auth = null;
    socket.data.play = null;
  });

  // --- v2: private member messaging (email-style inbox) --------------------
  // Privacy: only the sender and recipient ever see a message. Payloads
  // carry NAMES only — member IDs are stripped server-side. Admins have
  // NO mail access (there is deliberately no admin mail event).
  socket.on('player:sendMessage', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const data = body || {};
      const toName = String(data.toName || '').trim();
      const subject = String(data.subject || '').trim().slice(0, 100);
      const messageBody = String(data.body || '').trim();
      if (!toName) return socket.emit('error', { message: 'Choose a recipient.' });
      if (!messageBody) return socket.emit('error', { message: 'Message cannot be empty.' });
      if (messageBody.length > 2000) return socket.emit('error', { message: 'Message is too long (max 2000 characters).' });
      const all = await store.getAllMembers();
      const matches = all.filter((m) => !m.removedAt && m.name === toName);
      if (matches.length !== 1) {
        return socket.emit('error', { message: 'Recipient not found. Use the exact player name from the leaderboard.' });
      }
      const recipient = matches[0];
      if (recipient.memberId === player.memberId) {
        return socket.emit('error', { message: 'You cannot message yourself.' });
      }
      const msg = {
        id: crypto.randomBytes(12).toString('hex'),
        fromMemberId: player.memberId, fromName: player.name,
        toMemberId: recipient.memberId, toName: recipient.name,
        subject, body: messageBody,
        createdAt: new Date().toISOString(), read: false,
      };
      await store.saveMessage(msg);
      await store.saveMember(player); // persist accrued playtime
      const messages = await store.getMessages();
      socket.emit('mail:inbox', {
        messages: game.publicInbox(messages, player.memberId),
        unread: game.unreadCount(messages, player.memberId),
      });
      socket.emit('mail:sent', { ok: true });
      const rset = memberSockets.get(recipient.memberId);
      if (rset) {
        for (const s of rset) {
          s.emit('mail:new', {
            fromName: player.name, subject,
            unread: game.unreadCount(messages, recipient.memberId),
          });
          s.emit('mail:inbox', {
            messages: game.publicInbox(messages, recipient.memberId),
            unread: game.unreadCount(messages, recipient.memberId),
          });
        }
      }
    } catch { socket.emit('error', { message: 'Message failed. Please try again.' }); }
  });

  socket.on('player:listMail', async () => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const messages = await store.getMessages();
      socket.emit('mail:inbox', {
        messages: game.publicInbox(messages, player.memberId),
        unread: game.unreadCount(messages, player.memberId),
      });
    } catch { socket.emit('error', { message: 'Mail fetch failed. Please try again.' }); }
  });

  socket.on('player:readMail', async (body) => {
    if (!requireRole(socket, 'member')) return;
    try {
      const player = await loadPlayerForSocket(socket);
      if (!player) return socket.emit('error', { message: 'Player not found.' });
      const messages = await store.getMessages();
      const msg = messages.find((m) => m.id === (body || {}).id);
      if (!msg || msg.toMemberId !== player.memberId) {
        return socket.emit('error', { message: 'Message not found.' });
      }
      if (!msg.read) {
        msg.read = true;
        await store.saveMessage(msg);
      }
      const fresh = await store.getMessages();
      socket.emit('mail:inbox', {
        messages: game.publicInbox(fresh, player.memberId),
        unread: game.unreadCount(fresh, player.memberId),
      });
    } catch { socket.emit('error', { message: 'Marking mail read failed. Please try again.' }); }
  });

  // --- admin events -------------------------------------------------------
  socket.on('admin:ledger', async () => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const all = await store.getAllMembers();
      const players = all.filter(game.isActive).map((p) => ({
        name: p.name, memberId: p.memberId, tier: p.tier,
        points: p.points || 0, playSeconds: p.playSeconds || 0,
        netWorth: game.netWorthOf(p), cash: p.cash,
        homes: (p.homes || []).length, cars: (p.cars || []).length,
      }));
      socket.emit('admin:ledgerData', { players, removed: game.removedRows(all, Date.now()) });
    } catch { socket.emit('error', { message: 'Ledger failed. Please try again.' }); }
  });

  socket.on('admin:standings', async () => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const all = await store.getAllMembers();
      const sorted = all.filter(game.isActive).slice()
        .sort((a, b) => game.netWorthOf(b) - game.netWorthOf(a));
      socket.emit('admin:standingsData', {
        standings: sorted.map((p, i) => ({
          rank: i + 1, name: p.name, memberId: p.memberId, tier: p.tier,
          netWorth: game.netWorthOf(p), homes: (p.homes || []).length,
          cars: (p.cars || []).length, points: p.points || 0,
        })),
      });
    } catch { socket.emit('error', { message: 'Standings failed. Please try again.' }); }
  });

  socket.on('admin:export', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const kind = (body || {}).kind;
      const all = await store.getAllMembers();
      if (kind === 'points') socket.emit('admin:exportData', { kind, csv: game.pointsCsv(all) });
      else if (kind === 'standings') socket.emit('admin:exportData', { kind, csv: game.standingsCsv(all) });
      else socket.emit('error', { message: 'Unknown export kind.' });
    } catch { socket.emit('error', { message: 'Export failed. Please try again.' }); }
  });

  socket.on('admin:removePlayer', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const id = String((body || {}).memberId || '').trim().toUpperCase();
      const player = await store.getMemberById(id);
      if (!player) return socket.emit('admin:opResult', { ok: false, message: 'Player not found.' });
      if (player.removedAt) return socket.emit('admin:opResult', { ok: false, message: 'Player is already removed.' });
      player.removedAt = new Date().toISOString();
      player.token = null;
      // Delist active marketplace listings; homes stay owned but unlisted.
      const listings = await store.getListings();
      for (const l of listings.filter((x) => x.sellerMemberId === player.memberId)) {
        await store.deleteListing(l.id);
        const home = (player.homes || []).find((h) => h.instanceId === l.instanceId);
        if (home) { home.listedPrice = null; home.listingId = null; }
      }
      await store.saveMember(player);
      // Invalidate live sessions.
      const set = memberSockets.get(player.memberId);
      if (set) {
        for (const s of [...set]) {
          s.emit('error', { message: 'Your account has been removed. Contact an admin.' });
          s.data.auth = null; s.data.play = null;
          s.disconnect(true);
        }
      }
      await broadcastAll();
      socket.emit('admin:opResult', { ok: true, message: `${player.name} removed. Restore within 3 days to keep full state.` });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Remove failed. Please try again.' }); }
  });

  async function restorePlayerRecord(player, socket) {
    const removedMs = Date.parse(player.removedAt);
    const within = Date.now() - removedMs <= 3 * 24 * 60 * 60 * 1000;
    if (within) {
      player.removedAt = null;
      await store.saveMember(player);
      socket.emit('admin:opResult', { ok: true, message: `${player.name} restored with full state intact.` });
    } else {
      const fresh = game.resetPlayer(player);
      fresh.removedAt = null;
      await store.saveMember(fresh);
      socket.emit('admin:opResult', { ok: true, message: `${player.name} was removed over 3 days ago, so they restart fresh at $10,000.` });
    }
    await broadcastAll();
  }

  socket.on('admin:restorePlayer', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const id = String((body || {}).memberId || '').trim().toUpperCase();
      const player = await store.getMemberById(id);
      if (!player) return socket.emit('admin:opResult', { ok: false, message: 'Player not found.' });
      if (!player.removedAt) return socket.emit('admin:opResult', { ok: false, message: 'Player is not removed.' });
      await restorePlayerRecord(player, socket);
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Restore failed. Please try again.' }); }
  });

  socket.on('admin:addMember', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const data = body || {};
      const name = String(data.name || '').trim();
      const tier = data.tier;
      const memberId = String(data.memberId || '').trim().toUpperCase();
      if (!name || name.length > 40) return socket.emit('admin:opResult', { ok: false, message: 'Name must be 1–40 characters.' });
      if (!TIERS.includes(tier)) return socket.emit('admin:opResult', { ok: false, message: 'Tier must be Rookie, Rising Star, VIP, Elite, or Legend.' });
      if (!/^PVR\d{5}$/.test(memberId)) return socket.emit('admin:opResult', { ok: false, message: 'Member ID must match PVR followed by 5 digits (e.g. PVR12345).' });
      const existing = await store.getMemberById(memberId);
      if (existing && !existing.removedAt) {
        return socket.emit('admin:opResult', { ok: false, message: 'That member ID is already in use.' });
      }
      if (existing && existing.removedAt) {
        // Duplicate REMOVED memberId → treated as a restore (CONTRACT §8).
        existing.name = name;
        existing.tier = tier;
        await restorePlayerRecord(existing, socket);
        return;
      }
      await store.saveMember(game.newPlayer({ name, tier, memberId }));
      await broadcastAll();
      socket.emit('admin:opResult', { ok: true, message: `${name} added with $10,000 starting cash.` });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Add member failed. Please try again.' }); }
  });

  socket.on('admin:updateCatalog', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const data = body || {};
      const type = data.type;
      const id = data.id;
      const fields = data.fields || {};
      const base = type === 'home' ? getHome(id) : type === 'car' ? getCar(id) : null;
      if (!base) return socket.emit('admin:opResult', { ok: false, message: 'Unknown catalog item.' });
      const intIn = (v, min, max) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= min && n <= max;
      };
      const clean = {};
      if ('price' in fields) {
        if (!intIn(fields.price, 100, 10000000)) return socket.emit('admin:opResult', { ok: false, message: 'Price must be an integer from $100 to $10,000,000.' });
        clean.price = fields.price;
      }
      if (type === 'home') {
        if ('rent' in fields) {
          if (!intIn(fields.rent, 0, 100000)) return socket.emit('admin:opResult', { ok: false, message: 'Rent must be an integer from $0 to $100,000.' });
          clean.rent = fields.rent;
        }
        if ('appreciation' in fields) {
          const n = Number(fields.appreciation);
          if (!Number.isFinite(n) || n < 0 || n > 5) return socket.emit('admin:opResult', { ok: false, message: 'Appreciation must be from 0 to 5 (%/day).' });
          clean.appreciation = n;
        }
      }
      if ('stock' in fields) {
        if (fields.stock !== null && !intIn(fields.stock, 0, 1000)) {
          return socket.emit('admin:opResult', { ok: false, message: 'Stock must be null (unlimited) or an integer from 0 to 1,000.' });
        }
        clean.stock = fields.stock;
      }
      const overrides = (await store.getMeta('catalog')) || {};
      const bucket = type === 'home' ? 'homes' : 'cars';
      if (!overrides[bucket]) overrides[bucket] = {};
      overrides[bucket][id] = { ...(overrides[bucket][id] || {}), ...clean };
      await store.setMeta('catalog', overrides);
      for (const s of authedSockets()) s.emit('game:catalog', { catalog: await getCatalog() });
      socket.emit('admin:opResult', { ok: true, message: `Catalog updated for ${base.name}.` });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Catalog update failed. Please try again.' }); }
  });

  socket.on('admin:changeId', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const newId = String((body || {}).newId || '').trim();
      if (!/^ADM\d{6}$/.test(newId)) {
        return socket.emit('admin:opResult', { ok: false, message: 'Admin ID must match ADM followed by 6 digits (e.g. ADM123456).' });
      }
      const oldId = socket.data.auth.adminId;
      if (newId === oldId) return socket.emit('admin:opResult', { ok: false, message: 'That is already your admin ID.' });
      const clash = await store.getAdminById(newId);
      if (clash) return socket.emit('admin:opResult', { ok: false, message: 'That admin ID is already in use.' });
      const admin = await store.getAdminById(oldId);
      if (!admin) return socket.emit('admin:opResult', { ok: false, message: 'Admin not found.' });
      const updated = { ...admin, adminId: newId, token: null, prevId: oldId };
      await store.saveAdmin(updated);
      untrack(socket, adminSockets, oldId);
      socket.data.auth = { role: 'admin', adminId: newId };
      track(socket, adminSockets, newId);
      socket.emit('admin:opResult', { ok: true, message: 'Your admin ID has been changed. Sign in with the new ID next time.' });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Change ID failed. Please try again.' }); }
  });

  socket.on('admin:advanceDay', async () => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const day = await runDayCycle();
      socket.emit('admin:opResult', { ok: true, message: `Advanced to day ${day}.` });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Advance day failed. Please try again.' }); }
  });

  // --- v2: admin resets (SEPARATE from the 3-day remove/restore rule) -----
  // Destructive and permanent: no restorable snapshot, no 3-day grace.
  // Access: ONLY the CoolVibez admin, identified by admin NAME (not the
  // changeable admin ID). The server also requires confirm === true.
  socket.on('admin:resetPlayer', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const admin = await store.getAdminById(socket.data.auth.adminId);
      if (!admin || admin.name !== 'CoolVibez') {
        return socket.emit('admin:opResult', { ok: false, message: 'Only CoolVibez can reset players.' });
      }
      if (!(body || {}).confirm) {
        return socket.emit('admin:opResult', { ok: false, message: 'Reset requires confirmation.' });
      }
      const id = String((body || {}).memberId || '').trim().toUpperCase();
      const player = await store.getMemberById(id);
      if (!player) return socket.emit('admin:opResult', { ok: false, message: 'Player not found.' });
      if (player.removedAt) {
        return socket.emit('admin:opResult', { ok: false, message: 'Player is removed; restore them first.' });
      }
      // Delist their marketplace listings and delete their messages.
      const listings = await store.getListings();
      for (const l of listings.filter((x) => x.sellerMemberId === player.memberId)) {
        await store.deleteListing(l.id);
      }
      await store.deleteMessagesFor(player.memberId);
      await store.saveMember(game.resetPlayer(player));
      // Invalidate live sessions (same pattern as removePlayer).
      const set = memberSockets.get(player.memberId);
      if (set) {
        for (const s of [...set]) {
          s.emit('error', { message: 'Your game has been reset by an admin.' });
          s.data.auth = null; s.data.play = null;
          s.disconnect(true);
        }
      }
      await broadcastAll();
      socket.emit('admin:opResult', { ok: true, message: `${player.name} has been reset to a fresh start.` });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Reset failed. Please try again.' }); }
  });

  socket.on('admin:resetGame', async (body) => {
    if (!requireRole(socket, 'admin')) return;
    try {
      const admin = await store.getAdminById(socket.data.auth.adminId);
      if (!admin || admin.name !== 'CoolVibez') {
        return socket.emit('admin:opResult', { ok: false, message: 'Only CoolVibez can reset the game.' });
      }
      if (!(body || {}).confirm) {
        return socket.emit('admin:opResult', { ok: false, message: 'Reset requires confirmation.' });
      }
      const all = await store.getAllMembers();
      for (const p of all) await store.saveMember(game.resetPlayer(p));
      const listings = await store.getListings();
      for (const l of listings) await store.deleteListing(l.id);
      await store.clearMessages();
      await store.setMeta('day', 1);
      for (const [, set] of [...memberSockets.entries()]) {
        for (const s of [...set]) {
          s.emit('error', { message: 'The game has been reset by an admin.' });
          s.data.auth = null; s.data.play = null;
          s.disconnect(true);
        }
      }
      await broadcastAll();
      for (const s of authedSockets()) s.emit('game:day', { day: 1 });
      socket.emit('admin:opResult', { ok: true, message: 'The entire game has been reset. All players start fresh at $10,000.' });
    } catch { socket.emit('admin:opResult', { ok: false, message: 'Game reset failed. Please try again.' }); }
  });

  socket.on('admin:logout', async () => {
    try {
      if (socket.data.auth && socket.data.auth.role === 'admin') {
        const admin = await store.getAdminById(socket.data.auth.adminId);
        if (admin) { admin.token = null; await store.saveAdmin(admin); }
        untrack(socket, adminSockets, socket.data.auth.adminId);
      }
    } catch { /* logout must not throw */ }
    socket.data.auth = null;
  });

  socket.on('disconnect', async () => {
    try {
      // Disconnect flush: bank any accrued playtime before the socket goes.
      if (socket.data.auth && socket.data.auth.role === 'member') {
        const player = await store.getMemberById(socket.data.auth.memberId);
        if (player && socket.data.play) {
          accruePlayExact(socket, player);
          await store.saveMember(player);
        }
        untrack(socket, memberSockets, socket.data.auth.memberId);
      } else if (socket.data.auth && socket.data.auth.role === 'admin') {
        untrack(socket, adminSockets, socket.data.auth.adminId);
      }
    } catch { /* disconnect cleanup must not throw */ }
  });
});

// --- playtime flush (60s) + day timer ---------------------------------------
setInterval(async () => {
  try {
    for (const [memberId, set] of [...memberSockets.entries()]) {
      for (const s of [...set]) {
        const player = await store.getMemberById(memberId);
        if (!player || !s.data.play) continue;
        const beforePoints = player.points;
        const beforeSeconds = player.playSeconds;
        accruePlayExact(s, player);
        if (player.points !== beforePoints || player.playSeconds !== beforeSeconds) {
          await store.saveMember(player);
          const catalog = await getCatalog();
          s.emit('player:state', { player: game.publicPlayer(player, catalog, await getDay()) });
        }
      }
    }
  } catch { /* flush failures retry next minute; no client impact */ }
}, PLAY_FLUSH_MS);

setInterval(() => { runDayCycle().catch(() => {}); }, DAY_MS);

// --- v2: boot migration for pre-v2 (live) rows ------------------------------
// The game is already live: existing rows must NEVER be re-seeded or reset
// (seedIfEmpty already only seeds empty tables). This migration fills in
// the v2 fields exactly once, keyed on `active === undefined`:
//  - any activity (playtime, shifts, homes, cars, milestones) → active,
//    progress fully preserved; homeowners get a utility schedule starting
//    one full interval after this boot (no retroactive charges).
//  - zero activity → inactive AND cash reset to exactly $10,000 (v1 day
//    cycles could drift an untouched balance via life events). They stay
//    at $10,000, skipped by day cycles, until their first login activates.
//  - shift history / claimed tiles default to empty (the 24h shift cap
//    starts fresh for migrated players).
// Idempotent: every row leaves with all v2 fields defined, so later boots
// change nothing.
async function migrateActivity() {
  const all = await store.getAllMembers();
  const day = await getDay();
  let changed = 0;
  for (const p of all) {
    let dirty = false;
    if (p.active === undefined) {
      const active = game.hasActivity(p);
      p.active = active;
      if (!active) {
        p.cash = game.START_CASH;
      } else if ((p.homes || []).length > 0 && p.nextUtilityDay == null) {
        p.nextUtilityDay = day + UTILITY_INTERVAL_DAYS;
      }
      dirty = true;
    }
    if (!Array.isArray(p.shiftHistory)) { p.shiftHistory = []; dirty = true; }
    if (!Array.isArray(p.claimedTiles)) { p.claimedTiles = []; dirty = true; }
    if (p.nextUtilityDay === undefined) { p.nextUtilityDay = null; dirty = true; }
    if (dirty) { await store.saveMember(p); changed += 1; }
  }
  if (changed) console.log(`Migrated ${changed} player records (v2 activity flags).`);
}

// ============================================================================
// Boot
// ============================================================================
async function main() {
  await store.init();
  const seeded = await seedIfEmpty(store);
  await migrateActivity();
  server.listen(PORT, () => {
    console.log(`PulseVR Life server listening on ${PORT} (store: ${storeKind}, day timer: ${DAY_MS}ms)`);
    if (seeded.members || seeded.admins) {
      console.log(`Seeded ${seeded.members} members, ${seeded.admins} admins (first boot only).`);
    }
  });
}

main().catch((err) => {
  console.error('Failed to start PulseVR Life server:', err);
  process.exit(1);
});
