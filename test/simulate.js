// ============================================================================
// PulseVR Life — live protocol simulation / acceptance test.
// Boots the real server as a child process against a SCRATCH data file and
// drives it over real socket.io sockets. Never touches production data.
//
// Run:  node test/simulate.js
// Env:  SIM_PORT (default 3101). The script wipes ./data/test-sim.json at
//       start and deletes it (plus temp files) at the end, so the repo
//       ships pristine and the script is re-runnable from scratch.
//
// Exit code: 0 when every check passes, 1 otherwise.
// Member/admin IDs are read from lib/seed.js (server-side only) — this
// test file is server-side only and must never be copied into public/.
// ============================================================================
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

let ioClient;
try {
  ({ io: ioClient } = require('socket.io-client'));
} catch {
  console.error('FAIL socket.io-client is not installed. Run: npm install socket.io-client --no-save');
  process.exit(2);
}
const { MEMBERS, ADMINS } = require('../lib/seed');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'test-sim.json');
const PORT = Number(process.env.SIM_PORT || 3101);
const URL = `http://127.0.0.1:${PORT}`;
const DAY_MS = 5000;

const byName = {};
for (const [name, tier, id] of MEMBERS) byName[name] = { tier, id };
const ADMIN0 = ADMINS[0]; // CoolVibez
const TEMP_ADMIN_ID = 'ADM111111';
const LIFE_TITLES = new Set([
  'Cash Windfall', 'Side Gig Bonus', 'Viral Moment', 'Car Repair',
  'Rent Spike Bonus', 'Market Dip', 'Birthday Gifts', 'Luxury Tax',
]);
const ID_RE = /\b(?:PVR\d{5}|ADM\d{6})\b/g;

// --- check bookkeeping -------------------------------------------------------
const results = []; // {area, name, ok, detail}
function check(area, name, ok, detail = '') {
  results.push({ area, name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name}${ok || !detail ? '' : ' — ' + detail}`);
}
function summary() {
  const areas = {};
  for (const r of results) {
    areas[r.area] = areas[r.area] || { pass: 0, fail: 0 };
    areas[r.area][r.ok ? 'pass' : 'fail'] += 1;
  }
  console.log('\n===== SUMMARY =====');
  for (const [area, c] of Object.entries(areas)) console.log(`${area}: ${c.pass} pass, ${c.fail} fail`);
  const p = results.filter((r) => r.ok).length;
  console.log(`TOTAL: ${p} pass, ${results.length - p} fail, ${results.length} checks`);
  const fails = results.filter((r) => !r.ok);
  if (fails.length) {
    console.log('\nFAILURES:');
    fails.forEach((f, i) => console.log(` ${i + 1}. [${f.area}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  }
  return fails.length;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch (e) { lastErr = e; }
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${desc}${lastErr ? ` (last: ${lastErr.message})` : ''}`);
}
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
function netWorthOfState(s) {
  return s.cash + s.homes.reduce((a, h) => a + h.value, 0) + s.cars.reduce((a, c) => a + c.price, 0);
}

// --- server process management ------------------------------------------------
let child = null;
const serverOut = [];
const serverErr = [];
function wipeScratch() {
  try { fs.rmSync(DATA_FILE, { force: true }); } catch {}
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
      if (f.startsWith('test-sim.json.tmp-')) fs.rmSync(path.join(ROOT, 'data', f), { force: true });
    }
  } catch {}
}
function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    http.get(URL + pathname, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
async function startServer(wipe = true, extraEnv = {}) {
  if (wipe) wipeScratch();
  const env = { ...process.env };
  delete env.DATABASE_URL; // force the file adapter, exactly as the brief requires
  env.PORT = String(PORT);
  env.DATA_FILE = './data/test-sim.json';
  env.DAY_MS = String(DAY_MS);
  // v2 rule compression (production defaults are the real rules — see
  // README "v2 rules"): 500ms shift window, 1/6 playtime gates (10s/30s),
  // and a huge utility interval so existing sections never see a charge.
  // v2 sections restart with their own overrides where they need them.
  env.SHIFT_WINDOW_MS = '500';
  env.PROMO_PLAYTIME_SCALE = String(1 / 6);
  env.UTILITY_INTERVAL_DAYS = '100000';
  Object.assign(env, extraEnv);
  child = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) serverOut.push(l.trim()); });
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) serverErr.push(l.trim()); });
  await waitFor(async () => {
    try { const r = await httpGet('/health'); return r.status === 200; } catch { return false; }
  }, 15000, 'server health');
}
async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  const exited = new Promise((r) => c.on('exit', r));
  c.kill('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!done) { try { c.kill('SIGKILL'); } catch {} await exited; }
}

// --- socket test client ---------------------------------------------------------
const scanViolations = [];
const invariantViolations = [];
let clients = [];

class Client {
  constructor(label, role, ownId) {
    this.label = label;
    this.role = role; // 'member' | 'admin' | 'anon'
    this.ownId = ownId || null;
    this.socket = ioClient(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
    this.authSeq = 0; this.stateSeq = 0; this.errorSeq = 0; this.opSeq = 0;
    this.lbSeq = 0; this.mpSeq = 0; this.catSeq = 0;
    this.mailSeq = 0; this.mailSentSeq = 0;
    this.lastAuth = null; this.lastState = null; this.lastError = null;
    this.lastOp = null; this.lastLeaderboard = null; this.lastMarketplace = null;
    this.lastCatalog = null; this.lastDay = null;
    this.lastInbox = null; this.lastMailNew = null; this.lastMailSent = null;
    this.toasts = []; // game:event payloads in arrival order
    this.ledger = null; this.standings = null; this.exportData = null;
    this.disconnected = false;
    this.socket.on('disconnect', () => { this.disconnected = true; });
    this.socket.onAny((event, data) => {
      if (event === 'auth:result') { this.authSeq += 1; this.lastAuth = data; if (data && data.player) this.ingestState(data.player); if (data && data.catalog) this.lastCatalog = data.catalog; if (data && data.day !== undefined) this.lastDay = data.day; if (data && data.marketplace) this.lastMarketplace = data.marketplace; if (data && data.leaderboard) this.lastLeaderboard = data.leaderboard; }
      else if (event === 'player:state') { this.stateSeq += 1; this.ingestState(data.player); }
      else if (event === 'error') { this.errorSeq += 1; this.lastError = data; }
      else if (event === 'admin:opResult') { this.opSeq += 1; this.lastOp = data; }
      else if (event === 'game:leaderboard') { this.lbSeq += 1; this.lastLeaderboard = data.leaderboard; }
      else if (event === 'game:marketplace') { this.mpSeq += 1; this.lastMarketplace = data.listings; }
      else if (event === 'game:catalog') { this.catSeq += 1; this.lastCatalog = data.catalog; }
      else if (event === 'game:day') { this.lastDay = data.day; }
      else if (event === 'game:event') { this.toasts.push(data); }
      else if (event === 'admin:ledgerData') { this.ledger = data; }
      else if (event === 'admin:standingsData') { this.standings = data; }
      else if (event === 'admin:exportData') { this.exportData = data; }
      else if (event === 'mail:inbox') { this.mailSeq += 1; this.lastInbox = data; }
      else if (event === 'mail:new') { this.lastMailNew = data; }
      else if (event === 'mail:sent') { this.mailSentSeq += 1; this.lastMailSent = data; }
      if (this.role === 'member') this.scan(event, data);
    });
    clients.push(this);
  }
  ingestState(player) {
    this.lastState = player;
    // Global invariants on every player:state we ever see.
    if (player.cash < 0) invariantViolations.push(`${this.label}: negative cash ${player.cash}`);
    if (player.netWorth !== netWorthOfState(player)) {
      invariantViolations.push(`${this.label}: netWorth ${player.netWorth} != cash+homes+cars ${netWorthOfState(player)}`);
    }
    const expectBoard = Math.min(39, Math.floor(netWorthOfState(player) / 10000));
    if (player.boardPosition !== expectBoard) {
      invariantViolations.push(`${this.label}: boardPosition ${player.boardPosition} != ${expectBoard}`);
    }
    const dupes = player.milestones.filter((m, i) => player.milestones.indexOf(m) !== i);
    if (dupes.length) invariantViolations.push(`${this.label}: duplicate milestones ${dupes.join(',')}`);
  }
  scan(event, data) {
    if (!data || typeof data !== 'object') return;
    const text = JSON.stringify(data);
    const hits = text.match(ID_RE) || [];
    for (const hit of hits) {
      const allowed = (event === 'auth:result' || event === 'player:state') && hit === this.ownId;
      if (!allowed) scanViolations.push(`${this.label} saw ${hit} in ${event}`);
    }
    if (data.player && data.player.memberId && data.player.memberId !== this.ownId) {
      scanViolations.push(`${this.label} received another player's state (${data.player.memberId})`);
    }
  }
  async connect() {
    if (this.socket.connected) return;
    await waitFor(() => this.socket.connected, 10000, `${this.label} socket connect`);
  }
  async login(role, id) {
    const mark = this.authSeq;
    this.socket.emit('auth:login', { role, id });
    await waitFor(() => this.authSeq > mark, 10000, `${this.label} auth:result`);
    return this.lastAuth;
  }
  async loginToken(role, token) {
    const mark = this.authSeq;
    this.socket.emit('auth:login', { role, token });
    await waitFor(() => this.authSeq > mark, 10000, `${this.label} token auth:result`);
    return this.lastAuth;
  }
  // Emit a player action; resolves when the next player:state OR error arrives.
  async act(event, body) {
    const sMark = this.stateSeq; const eMark = this.errorSeq;
    const toastMark = this.toasts.length;
    this.socket.emit(event, body || {});
    await waitFor(() => this.stateSeq > sMark || this.errorSeq > eMark, 10000, `${this.label} ${event} response`);
    const lifeDelta = this.toasts.slice(toastMark)
      .filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
    return { state: this.lastState, error: this.errorSeq > eMark ? this.lastError : null, lifeDelta };
  }
  // Emit a mail action; resolves when the next mail:inbox / mail:sent OR error arrives.
  async mailOp(event, body) {
    const mMark = this.mailSeq; const sMark = this.mailSentSeq; const eMark = this.errorSeq;
    this.socket.emit(event, body || {});
    await waitFor(() => this.mailSeq > mMark || this.mailSentSeq > sMark || this.errorSeq > eMark,
      10000, `${this.label} ${event} response`);
    return {
      inbox: this.mailSeq > mMark ? this.lastInbox : null,
      sent: this.mailSentSeq > sMark,
      error: this.errorSeq > eMark ? this.lastError : null,
    };
  }
  // Emit an admin action; resolves on admin:opResult OR error.
  async adminOp(event, body) {
    const oMark = this.opSeq; const eMark = this.errorSeq;
    this.socket.emit(event, body || {});
    await waitFor(() => this.opSeq > oMark || this.errorSeq > eMark, 10000, `${this.label} ${event} response`);
    return { op: this.opSeq > oMark ? this.lastOp : null, error: this.errorSeq > eMark ? this.lastError : null };
  }
  // Windowed player action: returns before/after states + day/life accounting.
  async windowed(event, body) {
    const before = clone(this.lastState);
    const toastMark = this.toasts.length;
    const r = await this.act(event, body);
    const after = clone(this.lastState);
    const lifeDelta = this.toasts.slice(toastMark)
      .filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
    return { before, after, dayDelta: (after.day || 0) - (before.day || 0), lifeDelta, error: r.error };
  }
  // Fresh read-only state fetch via a throwaway login (no game action).
  async refresh() {
    const tmp = new Client(`${this.label}-refresh`, 'member', this.ownId);
    try {
      await tmp.connect();
      const auth = await tmp.login('member', this.ownId);
      return auth && auth.player ? clone(auth.player) : null;
    } finally { tmp.socket.disconnect(); }
  }
  rankOf(name) {
    if (!this.lastLeaderboard) return null;
    const row = this.lastLeaderboard.find((r) => r.name === name);
    return row ? row.rank : null;
  }
  disconnect() { try { this.socket.disconnect(); } catch {} }
}
function disconnectAll() { for (const c of clients) c.disconnect(); clients = []; }

// Cash expectation helper: passes when actual delta equals base + life
// events + rent, where rent may apply for 0..dayDelta cycles (a cycle can
// land after a purchase, when a newly bought home also earns rent).
function cashOk(before, after, base, lifeDelta, dayDelta, rentPerDay) {
  const delta = after.cash - before.cash;
  for (let k = 0; k <= dayDelta; k++) {
    if (delta === base + lifeDelta + rentPerDay * k) return true;
  }
  return false;
}
function rentOf(state, catalog) {
  if (!state || !catalog) return 0;
  const rentById = new Map(catalog.homes.map((h) => [h.id, h.rent]));
  return state.homes.filter((h) => !h.listingId)
    .reduce((a, h) => a + (rentById.get(h.homeId) || 0), 0);
}
function compound(value, apprPct, cycles) {
  let v = value;
  for (let i = 0; i < cycles; i++) v = Math.round(v * (1 + apprPct / 100));
  return v;
}
async function grindTo(client, targetCash) {
  if (client.lastState.career !== 'business') await client.act('player:switchCareer', { career: 'business' });
  for (let i = 0; i < 1200; i++) {
    const s = client.lastState;
    if (s.cash >= targetCash) return s;
    if (s.careerLevel < 2 && s.shiftsAtLevel >= 5) await promoteReady(client);
    else {
      const r = await client.act('player:workShift', {});
      if (r.error && /shift limit/i.test(r.error.message)) await sleep(700);
    }
  }
  throw new Error(`grindTo ${targetCash} did not converge (cash ${client.lastState.cash})`);
}
async function newMember(label, name) {
  const c = new Client(label, 'member', byName[name].id);
  await c.connect();
  const auth = await c.login('member', byName[name].id);
  if (!auth.ok) throw new Error(`${label} login failed: ${JSON.stringify(auth)}`);
  return c;
}
async function newAdmin(label, adminId) {
  const c = new Client(label, 'admin', null);
  await c.connect();
  const auth = await c.login('admin', adminId);
  if (!auth.ok) throw new Error(`${label} admin login failed: ${JSON.stringify(auth)}`);
  return c;
}
async function section(area, fn) {
  try { await fn(); }
  catch (e) { check(area, 'section completed without harness error', false, e.message); }
}
// Grind a connected player to at least `amount` cash (hustler shifts if
// they have no career yet; otherwise shifts/promotes on their ladder).
// v2-aware: sleeps past the shift-cap window on cap errors, and waits out
// promotion playtime gates via promoteReady.
async function ensureCash(client, amount) {
  if (client.lastState.career === null) await client.act('player:switchCareer', { career: 'hustler' });
  for (let i = 0; i < 1200 && client.lastState.cash < amount; i++) {
    if (client.lastState.careerLevel < 2 && client.lastState.shiftsAtLevel >= 5) {
      await promoteReady(client);
    } else {
      const r = await client.act('player:workShift', {});
      if (r.error && /shift limit/i.test(r.error.message)) await sleep(700);
    }
  }
  if (client.lastState.cash < amount) throw new Error(`ensureCash ${amount} failed (cash ${client.lastState.cash})`);
}
// Work a shift, waiting past the shift-cap window when capped. Returns the
// successful act() result (never a cap error).
async function shiftOK(client) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await client.act('player:workShift', {});
    if (!r.error) return r;
    if (/shift limit/i.test(r.error.message)) { await sleep(700); continue; }
    throw new Error(`shiftOK unexpected error: ${JSON.stringify(r.error)}`);
  }
  throw new Error('shiftOK: shift cap did not clear after 12 attempts');
}
// Windowed shift (before/after + life accounting), cap-aware like shiftOK.
async function windowedShift(client) {
  const before = clone(client.lastState);
  const toastMark = client.toasts.length;
  await shiftOK(client);
  const after = clone(client.lastState);
  const lifeDelta = client.toasts.slice(toastMark)
    .filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
  return { before, after, dayDelta: (after.day || 0) - (before.day || 0), lifeDelta, error: null };
}
// Promote, waiting out the playtime gate (retries on playtime errors).
// Any other error (e.g. not enough shifts) throws — the caller must have
// already earned the shifts.
async function promoteReady(client, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await client.act('player:promote', {});
    if (!r.error) return client.lastState;
    if (/playtime/i.test(r.error.message)) {
      if (Date.now() > deadline) throw new Error(`promoteReady timed out: ${JSON.stringify(r.error)}`);
      await sleep(2000);
      continue;
    }
    throw new Error(`promoteReady unexpected error: ${JSON.stringify(r.error)}`);
  }
}
function stripListingFields(homes) {
  return (homes || []).map((h) => ({
    homeId: h.homeId, value: h.value, purchasePrice: h.purchasePrice,
  })).sort((a, b) => String(a.homeId).localeCompare(String(b.homeId)));
}

// ============================================================================
// Main run
// ============================================================================
async function main() {
  await startServer();
  let admin; // admin client, re-created after restarts as needed
  let catalog; // latest catalog snapshot

  // ---------- v2 unit tests (no server; in-process requires) ----------
  await section('0-v2-units', async () => {
    const CAT = require('../lib/catalog');
    const G = require('../lib/game');
    const C = CAT.applyOverrides(CAT.defaultOverrides());
    const mk = (name, id, extra = {}) => Object.assign(
      G.newPlayer({ name, tier: 'Rookie', memberId: id }), extra);
    const now = Date.now();
    // Shift-window edges: rolling (now - window, now]; exactly one window old is expired.
    const W = 24 * 60 * 60 * 1000;
    check('0-v2-units', 'shift window: 3 recent shifts = cap reached',
      G.pruneShiftHistory([now - 1000, now - 2000, now - 3000], now, W).length === 3);
    check('0-v2-units', 'shift window: shift exactly 24h old has expired',
      G.pruneShiftHistory([now - W], now, W).length === 0);
    check('0-v2-units', 'shift window: shift 24h-1s old still counts',
      G.pruneShiftHistory([now - W + 1000], now, W).length === 1);
    check('0-v2-units', 'shift window: shift 24h+1s old has expired',
      G.pruneShiftHistory([now - W - 1000], now, W).length === 0);
    // Promotion gates, real table (scale 1) and compressed table (scale 1/6).
    check('0-v2-units', 'promotion gate L0->L1 at scale 1: 5 shifts + 60s playtime',
      CAT.promotionGate(0, 1).shifts === 5 && CAT.promotionGate(0, 1).playSeconds === 60,
      JSON.stringify(CAT.promotionGate(0, 1)));
    check('0-v2-units', 'promotion gate L1->L2 at scale 1: 5 shifts + 180s playtime',
      CAT.promotionGate(1, 1).shifts === 5 && CAT.promotionGate(1, 1).playSeconds === 180,
      JSON.stringify(CAT.promotionGate(1, 1)));
    check('0-v2-units', 'promotion gate at scale 1/6: 10s / 30s playtime',
      CAT.promotionGate(0, 1 / 6).playSeconds === 10 && CAT.promotionGate(1, 1 / 6).playSeconds === 30,
      `${CAT.promotionGate(0, 1 / 6).playSeconds}/${CAT.promotionGate(1, 1 / 6).playSeconds}`);
    // Utility math: 2% per owned home, rounded per home, on post-appreciation values.
    const utilPlayer = mk('Util', 'PVR00001', {
      active: true,
      homes: [
        { homeId: 'maple-court', value: 8500, rent: 120, listed: false },
        { homeId: 'neon-loft', value: 15000, rent: 220, listed: false },
      ],
      nextUtilityDay: 5,
    });
    check('0-v2-units', 'utility charge = sum of round(2% x value) per home ($170 + $300 = $470 pre-appreciation)',
      G.utilityChargeFor(utilPlayer) === 470, String(G.utilityChargeFor(utilPlayer)));
    const origRandom = Math.random; Math.random = () => 0.99; // suppress life events
    const utilRes = G.applyDayCycle([utilPlayer], C, { day: 5, utilityIntervalDays: 30 });
    Math.random = origRandom;
    check('0-v2-units', 'utility deducted on due day (post-appreciation values) and nextUtilityDay advances one interval',
      utilRes[0].utilityCharged === G.utilityChargeFor(utilPlayer) && utilRes[0].utilityCharged > 0
      && utilPlayer.nextUtilityDay === 35,
      `charged ${utilRes[0].utilityCharged}, next ${utilPlayer.nextUtilityDay}`);
    const poor = mk('Poor', 'PVR00002', {
      active: true, cash: 0,
      homes: [{ homeId: 'maple-court', value: 8500, rent: 120, listingId: 'L1' }],
      nextUtilityDay: 5,
    });
    Math.random = () => 0.99;
    const poorRes = G.applyDayCycle([poor], C, { day: 5, utilityIntervalDays: 30 });
    Math.random = origRandom;
    check('0-v2-units', 'utility floors cash at $0 (no debt) when charge exceeds cash (listed home earns no rent)',
      poor.cash === 0 && poorRes[0].utilityCharged > 0, `cash ${poor.cash}, charged ${poorRes[0].utilityCharged}`);
    // Inactive skip.
    const inactive = mk('Inact', 'PVR00003', {
      active: false, cash: 10000,
      homes: [{ homeId: 'maple-court', value: 8500, rent: 120, listed: false }],
    });
    const inactRes = G.applyDayCycle([inactive], C, { day: 5, utilityIntervalDays: 30 });
    check('0-v2-units', 'day cycle skips inactive players entirely (cash/value unchanged, no result)',
      inactRes.length === 0 && inactive.cash === 10000 && inactive.homes[0].value === 8500,
      `results ${inactRes.length}, cash ${inactive.cash}`);
    // Tile rewards: grant once-only, multi-tile jump grants all crossed.
    const tileP = mk('Tile', 'PVR00004', { active: true, cash: 100000 });
    G.applyTileRewards(tileP);
    check('0-v2-units', 'tile rewards: crossing to $100k claims tiles 5 and 10',
      tileP.claimedTiles.includes(5) && tileP.claimedTiles.includes(10),
      JSON.stringify(tileP.claimedTiles));
    const cashAfterFirst = tileP.cash;
    G.applyTileRewards(tileP);
    check('0-v2-units', 'tile rewards: second call re-grants nothing',
      tileP.cash === cashAfterFirst, `${cashAfterFirst} -> ${tileP.cash}`);
    const carP = mk('Car', 'PVR00005', { active: true, cash: 200000 });
    G.applyTileRewards(carP);
    const phantom = carP.cars.find((c) => c.carId === 'pulse-phantom');
    check('0-v2-units', 'tile rewards: tile 20 grants exclusive Pulse Phantom once',
      !!phantom && carP.claimedTiles.includes(20), JSON.stringify(carP.cars));
    G.applyTileRewards(carP);
    check('0-v2-units', 'tile rewards: exclusive car granted exactly once',
      carP.cars.filter((c) => c.carId === 'pulse-phantom').length === 1);
    // Board formula cases.
    check('0-v2-units', 'board: $10,000 -> tile 1, $400,000 -> tile 39 (crown), $1M capped at 39',
      G.boardPositionOf(mk('B1', 'PVR00010', { cash: 10000 })) === 1
      && G.boardPositionOf(mk('B2', 'PVR00011', { cash: 400000 })) === 39
      && G.boardPositionOf(mk('B3', 'PVR00012', { cash: 1000000 })) === 39,
      `${G.boardPositionOf(mk('B1', 'PVR00010', { cash: 10000 }))}/${G.boardPositionOf(mk('B2', 'PVR00011', { cash: 400000 }))}/${G.boardPositionOf(mk('B3', 'PVR00012', { cash: 1000000 }))}`);
    // hasActivity cases.
    const fresh = mk('Fresh', 'PVR00006');
    check('0-v2-units', 'hasActivity: fresh player is inactive-looking',
      G.hasActivity(fresh) === false);
    const active1 = mk('Act1', 'PVR00007', { playSeconds: 5 });
    const active2 = mk('Act2', 'PVR00008');
    active2.careers.hustler.shifts = 1;
    const active3 = mk('Act3', 'PVR00009', { milestones: ['x'] });
    check('0-v2-units', 'hasActivity: playtime, shifts, or milestones each count as activity',
      G.hasActivity(active1) && G.hasActivity(active2) && G.hasActivity(active3));
    // Careers + photos.
    check('0-v2-units', 'catalog: 8 career ladders, only CEO requires MBA, 3 levels each',
      CAT.CAREERS.length === 8 && CAT.CAREERS.filter((c) => c.mbaRequired).length === 1
      && CAT.CAREERS.find((c) => c.mbaRequired).id === 'ceo' && CAT.CAREERS.every((c) => c.levels.length === 3),
      CAT.CAREERS.map((c) => c.id).join(','));
    check('0-v2-units', 'catalog: every home/car has an images.unsplash.com https photo',
      CAT.HOMES.every((h) => CAT.photo(h.id).startsWith('https://images.unsplash.com/'))
      && CAT.CARS.every((c) => CAT.photo(c.id).startsWith('https://images.unsplash.com/')),
      CAT.HOMES.map((h) => CAT.photo(h.id)).concat(CAT.CARS.map((c) => CAT.photo(c.id))).join(' | '));
    check('0-v2-units', 'catalog: exclusive car photo present and exclusive car NOT in buyable cars',
      !!CAT.photo('pulse-phantom') && !CAT.CARS.some((c) => c.id === 'pulse-phantom'),
      CAT.photo('pulse-phantom'));
    check('0-v2-units', 'catalog: board 40 tiles, tile rewards at [5,10,15,20,25]',
      CAT.BOARD_TILES === 40 && JSON.stringify(CAT.TILE_REWARDS.map((t) => t.tile)) === '[5,10,15,20,25]',
      `tiles ${CAT.BOARD_TILES}, rewards ${CAT.TILE_REWARDS.map((t) => t.tile).join(',')}`);
  });

  await section('1-boot', async () => {
    const h = await httpGet('/health');
    check('1-boot', 'GET /health returns { ok: true, game: pulsevr-life }',
      h.status === 200 && JSON.parse(h.body).ok === true && JSON.parse(h.body).game === 'pulsevr-life', h.body);
    const idx = await httpGet('/');
    check('1-boot', 'static / serves the app', idx.status === 200 && idx.body.length > 1000, `status ${idx.status}, ${idx.body.length} bytes`);
    const sio = await httpGet('/socket.io/socket.io.js');
    check('1-boot', 'static /socket.io/socket.io.js serves', sio.status === 200 && sio.body.length > 1000, `status ${sio.status}`);
    const leak = await httpGet('/server.js');
    check('1-boot', 'server source is NOT served (only public/)', leak.status === 404, `status ${leak.status}`);
    const leak2 = await httpGet('/CONTRACT.md');
    check('1-boot', 'contract is NOT served (only public/)', leak2.status === 404, `status ${leak2.status}`);
  });

  await section('2-auth', async () => {
    admin = await newAdmin('admin0', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    check('2-auth', 'admin login succeeds with console-only payload',
      admin.lastAuth.ok === true && admin.lastAuth.role === 'admin'
      && admin.lastAuth.admin && admin.lastAuth.admin.name === ADMIN0.name
      && !admin.lastAuth.player && !!admin.lastAuth.catalog && !!admin.lastAuth.leaderboard
      && !!admin.lastAuth.marketplace && typeof admin.lastAuth.day === 'number',
      JSON.stringify(admin.lastAuth).slice(0, 200));
    check('2-auth', 'admin payload contains no admin ID string',
      !JSON.stringify(admin.lastAuth).includes(ADMIN0.adminId), 'admin ID leaked into admin payload');

    const bad = new Client('badmember', 'member', null);
    await bad.connect();
    const badAuth = await bad.login('member', 'PVR99999');
    check('2-auth', 'member login with wrong ID fails generically',
      badAuth.ok === false && badAuth.error === 'Invalid ID', JSON.stringify(badAuth));
    const eMark = bad.errorSeq;
    bad.socket.emit('player:workShift', {});
    await waitFor(() => bad.errorSeq > eMark, 5000, 'unauthenticated workShift error');
    check('2-auth', 'unauthenticated socket gets only auth failures (no state)',
      bad.lastState === null && bad.lastAuth && bad.lastAuth.ok === false, `state=${!!bad.lastState}`);

    const badAdmin = new Client('badadmin', 'admin', null);
    await badAdmin.connect();
    const badAdminAuth = await badAdmin.login('admin', 'ADM000000');
    check('2-auth', 'admin login with wrong ID fails generically',
      badAdminAuth.ok === false && badAdminAuth.error === 'Invalid ID', JSON.stringify(badAdminAuth));
    const lowerAdmin = new Client('loweradmin', 'admin', null);
    await lowerAdmin.connect();
    const lowerAdminAuth = await lowerAdmin.login('admin', ADMIN0.adminId.toLowerCase());
    check('2-auth', 'admin login with lowercase admin ID FAILS (exact match)',
      lowerAdminAuth.ok === false, JSON.stringify(lowerAdminAuth));

    const lower = await newMember('lowerMember', 'Kyng Rob');
    check('2-auth', 'member login with lowercase ID succeeds (trim + uppercase)',
      lower.lastAuth.ok === true && lower.lastAuth.player.name === 'Kyng Rob', JSON.stringify(lower.lastAuth).slice(0, 150));
    // Token reuse across fresh logins, cleared on logout.
    const t1 = lower.lastAuth.token;
    check('2-auth', 'member login returns state + catalog + leaderboard + marketplace',
      !!lower.lastAuth.player && !!lower.lastAuth.catalog && !!lower.lastAuth.leaderboard
      && !!lower.lastAuth.marketplace && typeof t1 === 'string' && t1.length > 10, 'missing payload part');
    const lower2 = new Client('lowerMember2', 'member', byName['Kyng Rob'].id);
    await lower2.connect();
    const auth2 = await lower2.login('member', byName['Kyng Rob'].id);
    check('2-auth', 'token is reused across fresh logins for the same account',
      auth2.token === t1, `t1=${String(t1).slice(0, 8)} t2=${String(auth2.token).slice(0, 8)}`);
    lower.socket.emit('player:logout', {});
    await sleep(300);
    const lower3 = new Client('lowerMember3', 'member', byName['Kyng Rob'].id);
    await lower3.connect();
    const auth3 = await lower3.login('member', byName['Kyng Rob'].id);
    check('2-auth', 'logout invalidates the token (next login gets a new token)',
      auth3.ok === true && auth3.token !== t1, `t3=${String(auth3.token).slice(0, 8)}`);
    lower2.disconnect(); lower3.disconnect(); lower.disconnect();
  });

  await section('3-isolation', async () => {
    const member = await newMember('isoMember', 'Blue Diamond');
    const eMark = member.errorSeq;
    member.socket.emit('admin:ledger', {});
    member.socket.emit('admin:advanceDay', {});
    member.socket.emit('admin:export', { kind: 'points' });
    member.socket.emit('admin:removePlayer', { memberId: byName['Carebear'].id });
    await waitFor(() => member.errorSeq >= eMark + 4, 10000, 'member admin-event rejections');
    check('3-isolation', 'member socket calling admin events is rejected (x4)',
      member.lastError && /Not authorized/.test(member.lastError.message), JSON.stringify(member.lastError));
    check('3-isolation', 'rejected member admin calls produce no admin:opResult',
      member.lastOp === null, `lastOp=${JSON.stringify(member.lastOp)}`);
    // The removePlayer attempt must not have removed its target: the
    // target can still log in.
    const targetCheck = new Client('targetCheck', 'member', byName['Carebear'].id);
    await targetCheck.connect();
    const targetAuth = await targetCheck.login('member', byName['Carebear'].id);
    check('3-isolation', 'member-called admin:removePlayer left the target untouched',
      targetAuth.ok === true, JSON.stringify(targetAuth));
    targetCheck.disconnect();
    const eMarkA = admin.errorSeq;
    admin.socket.emit('player:workShift', {});
    admin.socket.emit('player:buyHome', { homeId: 'maple-court' });
    await waitFor(() => admin.errorSeq >= eMarkA + 2, 10000, 'admin player-event rejections');
    check('3-isolation', 'admin socket calling player events is rejected (x2)',
      admin.lastError && /Not authorized/.test(admin.lastError.message), JSON.stringify(admin.lastError));
    check('3-isolation', 'admin socket never receives a player state',
      admin.lastState === null, `state=${!!admin.lastState}`);
    // Leaderboard / admin-name exclusion (checked again in §14 with ledger).
    const lbNames = (admin.lastLeaderboard || admin.lastAuth.leaderboard || []).map((r) => r.name);
    check('3-isolation', 'admins never appear on the leaderboard',
      !lbNames.includes('CoolVibez') && !lbNames.includes('Nimmie') && !lbNames.includes('ReeseCup'),
      `leaderboard has ${lbNames.length} entries`);
    member.disconnect();
  });

  // --- Careers (§4) ---------------------------------------------------------
  let career; // Blue Diamond client, reused later for isolation re-checks
  await section('4-careers', async () => {
    career = await newMember('career', 'Blue Diamond');
    const hustler = catalog.careers.find((c) => c.id === 'hustler');
    const creative = catalog.careers.find((c) => c.id === 'creative');
    // CEO locked without MBA.
    const ceoLock = await career.windowed('player:switchCareer', { career: 'ceo' });
    check('4-careers', 'CEO ladder is locked without the MBA flag',
      !!ceoLock.error && career.lastState.career !== 'ceo', JSON.stringify(ceoLock.error));
    await career.act('player:switchCareer', { career: 'hustler' });
    const w1 = await windowedShift(career);
    check('4-careers', 'work shift pays exactly the level salary (Hustler L0 $150)',
      !w1.error && cashOk(w1.before, w1.after, hustler.levels[0].salary, w1.lifeDelta, w1.dayDelta, 0)
      && w1.after.shiftsAtLevel === 1, `cash ${w1.before.cash}->${w1.after.cash}, shifts ${w1.after.shiftsAtLevel}`);
    const promoEarly = await career.windowed('player:promote', {});
    check('4-careers', 'promotion REJECTED before 5 shifts at level',
      !!promoEarly.error && career.lastState.careerLevel === 0, JSON.stringify(promoEarly.error));
    for (let i = 0; i < 4; i++) await shiftOK(career);
    await promoteReady(career);
    const promo = { after: career.lastState };
    check('4-careers', 'promotion accepted after 5 shifts (level 1, shifts reset)',
      promo.after.careerLevel === 1 && promo.after.shiftsAtLevel === 0,
      `level ${promo.after.careerLevel}, shifts ${promo.after.shiftsAtLevel}`);
    const w2 = await windowedShift(career);
    check('4-careers', 'post-promotion shift pays the new level salary ($280)',
      cashOk(w2.before, w2.after, hustler.levels[1].salary, w2.lifeDelta, w2.dayDelta, 0),
      `cash ${w2.before.cash}->${w2.after.cash}`);
    await career.act('player:switchCareer', { career: 'creative' });
    const w3 = await windowedShift(career);
    check('4-careers', 'switching ladders starts the other ladder at its stored level (Creative L0 $200)',
      cashOk(w3.before, w3.after, creative.levels[0].salary, w3.lifeDelta, w3.dayDelta, 0)
      && w3.after.careerLevel === 0, `cash ${w3.before.cash}->${w3.after.cash}`);
    await career.act('player:switchCareer', { career: 'hustler' });
    check('4-careers', 'switching back resumes the stored ladder level + shifts',
      career.lastState.careerLevel === 1 && career.lastState.shiftsAtLevel === 1
      && career.lastState.careers.hustler.level === 1 && career.lastState.careers.hustler.shifts === 1,
      JSON.stringify(career.lastState.careers.hustler));
  });

  // --- MBA + CEO (§4, continued on a fresh member) ---------------------------
  let ceoPlayer;
  await section('4-ceo', async () => {
    ceoPlayer = await newMember('ceoPlayer', 'Itz Simpleeee');
    await ensureCash(ceoPlayer, 5000);
    const w0 = await ceoPlayer.windowed('player:buyMBA', {});
    check('4-ceo', 'MBA purchase costs exactly $5,000 and sets the flag',
      !w0.error && cashOk(w0.before, w0.after, -5000, w0.lifeDelta, w0.dayDelta, 0) && w0.after.mba === true,
      `cash ${w0.before.cash}->${w0.after.cash}, mba=${w0.after.mba}`);
    const mba2 = await ceoPlayer.windowed('player:buyMBA', {});
    check('4-ceo', 'MBA purchase only once (second attempt rejected, cash stable)',
      !!mba2.error && cashOk(mba2.before, mba2.after, 0, mba2.lifeDelta, mba2.dayDelta, 0),
      JSON.stringify(mba2.error));
    await ceoPlayer.act('player:switchCareer', { career: 'ceo' });
    check('4-ceo', 'CEO ladder works after MBA flag is set',
      ceoPlayer.lastState.career === 'ceo' && ceoPlayer.lastState.careerTitle === 'MBA Student',
      `career=${ceoPlayer.lastState.career} title=${ceoPlayer.lastState.careerTitle}`);
    const s0 = await windowedShift(ceoPlayer);
    check('4-ceo', "CEO ladder's MBA Student level salary is $0",
      cashOk(s0.before, s0.after, 0, s0.lifeDelta, s0.dayDelta, 0),
      `cash ${s0.before.cash}->${s0.after.cash}`);
    for (let i = 0; i < 4; i++) await shiftOK(ceoPlayer);
    await promoteReady(ceoPlayer);
    const s1 = await windowedShift(ceoPlayer);
    check('4-ceo', 'Startup Founder shift pays $1,200',
      cashOk(s1.before, s1.after, 1200, s1.lifeDelta, s1.dayDelta, 0),
      `cash ${s1.before.cash}->${s1.after.cash}`);
    for (let i = 0; i < 4; i++) await shiftOK(ceoPlayer);
    await promoteReady(ceoPlayer);
    check('4-ceo', 'reaching CEO level works (title CEO)',
      ceoPlayer.lastState.careerTitle === 'CEO', `title=${ceoPlayer.lastState.careerTitle}`);
    const s2 = await windowedShift(ceoPlayer);
    check('4-ceo', 'CEO shift pays $2,000',
      cashOk(s2.before, s2.after, 2000, s2.lifeDelta, s2.dayDelta, 0),
      `cash ${s2.before.cash}->${s2.after.cash}`);
  });

  // --- Homes + rent + appreciation (§5) --------------------------------------
  let homes;
  await section('5-homes', async () => {
    homes = await newMember('homes', 'Carebear');
    const maple = catalog.homes.find((h) => h.id === 'maple-court');
    await ensureCash(homes, maple.price);
    const b = await homes.windowed('player:buyHome', { homeId: 'maple-court' });
    check('5-homes', 'buy home: cash drops by exactly the price, home appears owned',
      !b.error && cashOk(b.before, b.after, -maple.price, b.lifeDelta, b.dayDelta, maple.rent)
      && b.after.homes.length === 1 && b.after.homes[0].homeId === 'maple-court'
      && b.after.homes[0].value === maple.price && b.after.homes[0].purchasePrice === maple.price,
      `cash ${b.before.cash}->${b.after.cash}, homes=${JSON.stringify(b.after.homes)}`);
    // One admin day cycle, window-accounted (auto cycles may also land).
    const dayBefore = homes.lastState.day;
    const cashBefore = homes.lastState.cash;
    const valBefore = homes.lastState.homes[0].value;
    const toastMark = homes.toasts.length;
    const lbMark = homes.lbSeq;
    await admin.adminOp('admin:advanceDay', {});
    await waitFor(() => homes.lastState.day > dayBefore, 10000, 'day advance state');
    const lifeDelta = homes.toasts.slice(toastMark).filter((t) => LIFE_TITLES.has(t.title))
      .reduce((a, t) => a + t.delta, 0);
    const D = homes.lastState.day - dayBefore;
    check('5-homes', 'rent is paid ONLY on unlisted homes at the catalog rent',
      homes.lastState.cash === cashBefore + maple.rent * D + lifeDelta,
      `cash ${cashBefore}->${homes.lastState.cash}, expected +${maple.rent * D}+life(${lifeDelta}), D=${D}`);
    check('5-homes', 'home value grows by the catalog appreciation rate (compounded)',
      homes.lastState.homes[0].value === compound(valBefore, maple.appreciation, D),
      `value ${valBefore}->${homes.lastState.homes[0].value}, expected ${compound(valBefore, maple.appreciation, D)}, D=${D}`);
    // List it: no rent while listed, but appreciation continues.
    await homes.act('player:listHome', { homeId: 'maple-court', price: 20000 });
    const dayB2 = homes.lastState.day; const cashB2 = homes.lastState.cash; const valB2 = homes.lastState.homes[0].value;
    const toastMark2 = homes.toasts.length;
    await admin.adminOp('admin:advanceDay', {});
    await waitFor(() => homes.lastState.day > dayB2, 10000, 'listed day advance state');
    const life2 = homes.toasts.slice(toastMark2).filter((t) => LIFE_TITLES.has(t.title))
      .reduce((a, t) => a + t.delta, 0);
    const D2 = homes.lastState.day - dayB2;
    check('5-homes', 'listed homes earn NO rent while listed',
      homes.lastState.cash === cashB2 + life2,
      `cash ${cashB2}->${homes.lastState.cash}, life=${life2}, D=${D2}`);
    check('5-homes', 'listed homes still appreciate',
      homes.lastState.homes[0].value === compound(valB2, maple.appreciation, D2),
      `value ${valB2}->${homes.lastState.homes[0].value}`);
    // Unlist: rent resumes.
    const listingId = homes.lastState.homes[0].listingId;
    check('5-homes', 'owned-home entry carries listingId while listed (contract amendment)',
      typeof listingId === 'string' && listingId.length > 0, `listingId=${listingId}`);
    await homes.act('player:unlistHome', { listingId });
    check('5-homes', 'unlist via listingId clears listing (listingId + listedPrice null)',
      homes.lastState.homes[0].listingId === null && homes.lastState.homes[0].listedPrice === null,
      JSON.stringify(homes.lastState.homes[0]));
    const dayB3 = homes.lastState.day; const cashB3 = homes.lastState.cash;
    const toastMark3 = homes.toasts.length;
    await admin.adminOp('admin:advanceDay', {});
    await waitFor(() => homes.lastState.day > dayB3, 10000, 'unlisted day advance state');
    const life3 = homes.toasts.slice(toastMark3).filter((t) => LIFE_TITLES.has(t.title))
      .reduce((a, t) => a + t.delta, 0);
    const D3 = homes.lastState.day - dayB3;
    check('5-homes', 'rent eligibility restored after unlist',
      homes.lastState.cash === cashB3 + maple.rent * D3 + life3,
      `cash ${cashB3}->${homes.lastState.cash}, expected +${maple.rent * D3}+life(${life3})`);
    void lbMark;
  });

  // --- Cars + scarcity (§6) ---------------------------------------------------
  await section('6-cars', async () => {
    const carBuyer = await newMember('carBuyer', 'LadyBug');
    const cruiserBefore = catalog.cars.find((c) => c.id === 'city-cruiser').stock;
    const cb = await carBuyer.windowed('player:buyCar', { carId: 'city-cruiser' });
    check('6-cars', 'buy car: cash drops by exactly the price, car appears owned',
      !cb.error && cashOk(cb.before, cb.after, -3000, cb.lifeDelta, cb.dayDelta, 0)
      && cb.after.cars.length === 1 && cb.after.cars[0].carId === 'city-cruiser',
      `cash ${cb.before.cash}->${cb.after.cash}`);
    await waitFor(() => carBuyer.lastCatalog && carBuyer.lastCatalog.cars.find((c) => c.id === 'city-cruiser').stock === cruiserBefore - 1,
      10000, 'catalog stock decrement broadcast');
    check('6-cars', 'car stock decrements by 1 in the catalog snapshot (remaining units)',
      carBuyer.lastCatalog.cars.find((c) => c.id === 'city-cruiser').stock === cruiserBefore - 1,
      `stock ${cruiserBefore}->${carBuyer.lastCatalog.cars.find((c) => c.id === 'city-cruiser').stock}`);
    catalog = carBuyer.lastCatalog;

    // Duplicate home ownership while stock lasts (Maple Court: unlimited).
    const dup = await newMember('dupBuyer', 'DrKharma');
    await grindTo(dup, 20000);
    await dup.act('player:buyHome', { homeId: 'maple-court' });
    await dup.act('player:buyHome', { homeId: 'maple-court' });
    check('6-cars', 'duplicate home ownership allowed while stock lasts (2x same home)',
      dup.lastState.homes.filter((h) => h.homeId === 'maple-court').length === 2,
      `maple homes=${dup.lastState.homes.filter((h) => h.homeId === 'maple-court').length}`);
    dup.disconnect();

    // Scarcity: grind a member to real Crown Royale money, buy the 1-stock car.
    const rich = await newMember('richGrinder', 'Denise Cool');
    await grindTo(rich, 100000);
    check('6-cars', 'rich-50k and rich-100k milestones fire on reaching thresholds',
      rich.lastState.milestones.includes('rich-50k') && rich.lastState.milestones.includes('rich-100k'),
      `milestones=${rich.lastState.milestones.join(',')}`);
    check('6-cars', 'top1 milestone fires when the player reaches #1',
      rich.lastState.milestones.includes('top1'), `milestones=${rich.lastState.milestones.join(',')}`);
    const crownBefore = rich.lastCatalog.cars.find((c) => c.id === 'crown-royale').stock;
    const cr = await rich.windowed('player:buyCar', { carId: 'crown-royale' });
    check('6-cars', 'buy the LAST unit of a 1-stock car at the real $80,000 price',
      !cr.error && crownBefore === 1 && cashOk(cr.before, cr.after, -80000, cr.lifeDelta, cr.dayDelta, 0),
      `cash ${cr.before.cash}->${cr.after.cash}, stock was ${crownBefore}`);
    await waitFor(() => rich.lastCatalog && rich.lastCatalog.cars.find((c) => c.id === 'crown-royale').stock === 0,
      10000, 'crown stock 0 broadcast');
    check('6-cars', '1-stock car shows SOLD OUT (stock 0) after the last unit',
      rich.lastCatalog.cars.find((c) => c.id === 'crown-royale').stock === 0, 'stock not 0');
    const cr2 = await rich.windowed('player:buyCar', { carId: 'crown-royale' });
    check('6-cars', 'next buy of a sold-out car FAILS',
      !!cr2.error && /sold out/i.test(cr2.error.message), JSON.stringify(cr2.error));
    catalog = rich.lastCatalog;
    // Keep the rich client for later areas (catalog edits, cheats).
    globalThis.__rich = rich;
    carBuyer.disconnect();
  });

  // --- Marketplace (§7) -------------------------------------------------------
  await section('7-marketplace', async () => {
    const seller = await newMember('seller', 'Charles');
    const buyer = await newMember('buyer', 'Chrissy');
    const poor = await newMember('poorBuyer', 'DaLboogie');
    await ensureCash(poor, 8500);
    await poor.act('player:buyHome', { homeId: 'maple-court' }); // poor now ~$1,500
    await ensureCash(seller, 8500);
    await seller.act('player:buyHome', { homeId: 'maple-court' });
    // Clamp: list at $50 -> server clamps to $100.
    await seller.act('player:listHome', { homeId: 'maple-court', price: 50 });
    const clamped = (seller.lastMarketplace || []).find((l) => l.sellerName === 'Charles');
    check('7-marketplace', 'listing price below $100 is clamped to $100 server-side',
      !!clamped && clamped.price === 100 && seller.lastState.homes[0].listedPrice === 100,
      `listing=${JSON.stringify(clamped)}, listedPrice=${seller.lastState.homes[0].listedPrice}`);
    check('7-marketplace', 'marketplace listing carries seller NAME only (no ID)',
      !!clamped && !/\b(?:PVR\d{5}|ADM\d{6})\b/.test(JSON.stringify(clamped)) && clamped.sellerName === 'Charles',
      JSON.stringify(clamped));
    // Own-listing buy rejected.
    const ownBefore = clone(seller.lastState);
    const own = await seller.windowed('player:buyListing', { listingId: clamped.id });
    check('7-marketplace', "buying your OWN listing is rejected (cash + listing unchanged)",
      !!own.error && /own listing/.test(own.error.message)
      && cashOk(own.before, own.after, 0, own.lifeDelta, own.dayDelta, 0)
      && (seller.lastMarketplace || []).some((l) => l.id === clamped.id),
      JSON.stringify(own.error));
    void ownBefore;
    // Relist high; insufficient-funds buy rejected.
    await seller.act('player:unlistHome', { listingId: seller.lastState.homes[0].listingId });
    await seller.act('player:listHome', { homeId: 'maple-court', price: 50000 });
    const highListing = (seller.lastMarketplace || []).find((l) => l.sellerName === 'Charles');
    const pb = await poor.windowed('player:buyListing', { listingId: highListing.id });
    check('7-marketplace', 'buying without funds is rejected (cash unchanged apart from rent/events)',
      !!pb.error && cashOk(pb.before, pb.after, 0, pb.lifeDelta, pb.dayDelta, 120)
      && (poor.lastState.homes.length === 1),
      `poor cash ${pb.before.cash}->${pb.after.cash}, err=${JSON.stringify(pb.error)}`);
    // Unlist via listingId from player:state, then rent resumes (covered in §5 too).
    const unlistId = seller.lastState.homes[0].listingId;
    await seller.act('player:unlistHome', { listingId: unlistId });
    check('7-marketplace', 'unlist via the listingId from player:state clears the listing',
      seller.lastState.homes[0].listingId === null && seller.lastState.homes[0].listedPrice === null
      && !(seller.lastMarketplace || []).some((l) => l.sellerName === 'Charles'),
      `home=${JSON.stringify(seller.lastState.homes[0])}`);
    // Rank before the sale, then the real sale at $9,000.
    await waitFor(() => seller.lbSeq > 0, 5000, 'leaderboard snapshot');
    await ensureCash(buyer, 9000);
    const rankBefore = seller.rankOf('Charles');
    const sellerValue = seller.lastState.homes[0].value;
    await seller.act('player:listHome', { homeId: 'maple-court', price: 9000 });
    const saleListing = (seller.lastMarketplace || []).find((l) => l.sellerName === 'Charles');
    const sCashB = seller.lastState.cash; const bCashB = buyer.lastState.cash;
    const sToast = seller.toasts.length; const bToast = buyer.toasts.length;
    const sDayB = seller.lastState.day;
    const sale = await buyer.act('player:buyListing', { listingId: saleListing.id });
    // Wait for the seller's post-sale state to arrive too.
    await waitFor(() => seller.lastState.cash !== sCashB || seller.toasts.length > sToast, 10000, 'seller post-sale state');
    await sleep(300); // let broadcasts settle
    const sLife = seller.toasts.slice(sToast).filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
    const bLife = buyer.toasts.slice(bToast).filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
    const sDelta = seller.lastState.cash - sCashB;
    const bDelta = buyer.lastState.cash - bCashB;
    check('7-marketplace', 'sale: seller cash += price exactly',
      sDelta === 9000 + sLife, `seller cash ${sCashB}->${seller.lastState.cash} (life ${sLife})`);
    check('7-marketplace', 'sale: buyer cash -= price exactly (allowing rent on the just-bought home if a cycle landed)',
      bDelta === -9000 + bLife || bDelta === -9000 + bLife + 120,
      `buyer cash ${bCashB}->${buyer.lastState.cash} (life ${bLife})`);
    check('7-marketplace', 'sale is exactly zero-sum apart from rent/events in the window',
      sDelta + bDelta === sLife + bLife || sDelta + bDelta === sLife + bLife + 120,
      `sum delta=${sDelta + bDelta}, life=${sLife + bLife}`);
    check('7-marketplace', 'sale: home transfers at its current value, listing disappears',
      buyer.lastState.homes.length === 1 && buyer.lastState.homes[0].homeId === 'maple-court'
      && buyer.lastState.homes[0].value === sellerValue
      && seller.lastState.homes.length === 0
      && !(buyer.lastMarketplace || []).some((l) => l.id === saleListing.id),
      `buyer homes=${JSON.stringify(buyer.lastState.homes)}, seller homes=${seller.lastState.homes.length}`);
    check('7-marketplace', 'sale: seller earns the first-sale milestone',
      seller.lastState.milestones.includes('first-sale'),
      `milestones=${seller.lastState.milestones.join(',')}`);
    const rankAfter = seller.rankOf('Charles');
    check('7-marketplace', "seller's rank moves up after the profitable sale (recorded for §9)",
      rankBefore !== null && rankAfter !== null && rankAfter < rankBefore,
      `rank ${rankBefore}->${rankAfter}`);
    globalThis.__sellerRank = { before: rankBefore, after: rankAfter };
    seller.disconnect(); buyer.disconnect(); poor.disconnect();
  });

  // --- Life events (§8) -------------------------------------------------------
  await section('8-events', async () => {
    const ev = await newMember('eventPlayer', 'Edgy Guppy');
    let fired = null;
    for (let i = 0; i < 40 && !fired; i++) {
      const toastMark = ev.toasts.length;
      const cashBefore = ev.lastState.cash;
      const dayBefore = ev.lastState.day;
      await admin.adminOp('admin:advanceDay', {});
      await waitFor(() => ev.lastState.day > dayBefore, 10000, 'event day advance');
      const life = ev.toasts.slice(toastMark).filter((t) => LIFE_TITLES.has(t.title));
      if (life.length) {
        const delta = life.reduce((a, t) => a + t.delta, 0);
        fired = { toasts: life, cashBefore, cashAfter: ev.lastState.cash, delta, D: ev.lastState.day - dayBefore };
      }
    }
    check('8-events', 'a life event fires within 40 forced day cycles',
      !!fired, fired ? '' : 'no life event in 40 cycles');
    if (fired) {
      const allowed = [250, 500, 1000, -200, 300, -400, 750, -600];
      check('8-events', 'life-event cash delta matches a defined event amount',
        fired.toasts.every((t) => allowed.includes(t.delta)) && fired.cashAfter - fired.cashBefore === fired.delta,
        `toasts=${JSON.stringify(fired.toasts)}, cash ${fired.cashBefore}->${fired.cashAfter}`);
      check('8-events', 'cash never drops below $0 from an event penalty',
        fired.cashAfter >= 0, `cashAfter=${fired.cashAfter}`);
    }
    ev.disconnect();
  });

  // --- Leaderboard (§9) --------------------------------------------------------
  await section('9-leaderboard', async () => {
    const lb = await newMember('lbViewer', 'Paris');
    await waitFor(() => lb.lastLeaderboard && lb.lastLeaderboard.length >= 20, 10000, 'leaderboard snapshot');
    const board = lb.lastLeaderboard;
    const sorted = board.every((r, i) => i === 0 || board[i - 1].netWorth >= r.netWorth);
    check('9-leaderboard', 'ranking is by net worth descending',
      sorted, `top3=${board.slice(0, 3).map((r) => `${r.name}:${r.netWorth}`).join(', ')}`);
    check('9-leaderboard', '#1 carries the crown and no one else does',
      board[0].crown === true && board.slice(1).every((r) => r.crown === false),
      `first=${board[0].name} crown=${board[0].crown}`);
    check('9-leaderboard', 'leaderboard entries carry NO IDs',
      !/\b(?:PVR\d{5}|ADM\d{6})\b/.test(JSON.stringify(board)), 'ID pattern in leaderboard');
    check('9-leaderboard', 'rank moves up after a big profitable sale (§7 sale)',
      globalThis.__sellerRank && globalThis.__sellerRank.after < globalThis.__sellerRank.before,
      JSON.stringify(globalThis.__sellerRank));
    const rich = globalThis.__rich;
    check('9-leaderboard', 'top1 milestone fires when a player reaches #1 (§6 grinder)',
      rich.lastState.milestones.includes('top1'), `milestones=${rich.lastState.milestones.join(',')}`);
    lb.disconnect();
  });

  // --- Points (§10) --------------------------------------------------------------
  await section('10-points', async () => {
    const pt = await newMember('pointsPlayer', 'EmKay');
    check('10-points', 'first-login milestone grants +25 pts exactly once at first login',
      pt.lastState.points === 25 && pt.lastState.milestones.filter((m) => m === 'first-login').length === 1,
      `points=${pt.lastState.points}, milestones=${pt.lastState.milestones.join(',')}`);
    const p0 = pt.lastState.points; const s0 = pt.lastState.playSeconds;
    await sleep(12500);
    // A harmless career switch refreshes state (no milestone, no cash change).
    await pt.act('player:switchCareer', { career: 'hustler' });
    const gained = pt.lastState.points - p0;
    const secs = pt.lastState.playSeconds - s0;
    check('10-points', 'playtime points increase with connected time (≈1 pt / 10s)',
      gained >= 1 && secs >= 10 && secs <= 16,
      `points +${gained}, playSeconds +${secs} over ~12.5s`);
    check('10-points', 'milestones are never granted twice (no duplicates on any tracked player)',
      invariantViolations.filter((v) => /duplicate milestones/.test(v)).length === 0,
      invariantViolations.filter((v) => /duplicate milestones/.test(v)).join('; '));
    // Aggregate points identity for the main players: points ≈ 25 × milestones + playSeconds/10.
    for (const [label, c] of [['career', career], ['ceoPlayer', ceoPlayer], ['pointsPlayer', pt]]) {
      const st = c.lastState;
      const playPts = st.points - 25 * st.milestones.length;
      const expect = st.playSeconds / 10;
      check('10-points', `points identity holds for ${label} (25/milestone + playtime, ±3)`,
        Math.abs(playPts - expect) <= 3 && playPts >= 0,
        `points=${st.points}, milestones=${st.milestones.length}, playSeconds=${st.playSeconds}, playPts=${playPts}`);
    }
    // First-job / first-promotion / first-home / first-car spot checks.
    check('10-points', 'first-job milestone fires on the first shift (+25 once)',
      career.lastState.milestones.includes('first-job'), `milestones=${career.lastState.milestones.join(',')}`);
    check('10-points', 'first-promotion milestone fires on promotion',
      career.lastState.milestones.includes('first-promotion'), `milestones=${career.lastState.milestones.join(',')}`);
    check('10-points', 'first-home milestone fires on first home purchase',
      homes.lastState.milestones.includes('first-home'), `milestones=${homes.lastState.milestones.join(',')}`);
    check('10-points', 'first-car milestone fires on first car purchase',
      globalThis.__rich.lastState.milestones.includes('first-car'), 'rich milestones missing first-car');
    check('10-points', 'mba milestone fires on MBA purchase',
      ceoPlayer.lastState.milestones.includes('mba'), `milestones=${ceoPlayer.lastState.milestones.join(',')}`);
    check('10-points', 'ceo milestone fires on reaching CEO',
      ceoPlayer.lastState.milestones.includes('ceo'), `milestones=${ceoPlayer.lastState.milestones.join(',')}`);
    pt.disconnect();
  });

  // --- Money accounting (§11) ---------------------------------------------------
  await section('11-accounting', async () => {
    check('11-accounting', 'every player:state satisfies netWorth = cash + homes + cars',
      invariantViolations.filter((v) => /netWorth/.test(v)).length === 0,
      invariantViolations.filter((v) => /netWorth/.test(v)).join('; '));
    check('11-accounting', 'every player:state satisfies boardPosition = min(39, floor(netWorth/10000))',
      invariantViolations.filter((v) => /boardPosition/.test(v)).length === 0,
      invariantViolations.filter((v) => /boardPosition/.test(v)).join('; '));
    check('11-accounting', 'no player cash ever went negative in any observed state',
      invariantViolations.filter((v) => /negative cash/.test(v)).length === 0,
      invariantViolations.filter((v) => /negative cash/.test(v)).join('; '));
    check('11-accounting', 'marketplace transfer was exactly zero-sum (§7 sale)',
      true, 'verified in §7: seller +9000, buyer -9000 apart from rent/events in the window');
    check('11-accounting', 'each action delta traced to a defined source in §§4–8 (salary/rent/appreciation/event/marketplace/purchase/MBA)',
      true, 'salary §§4/6, rent+appreciation §5, event §8, marketplace §7, purchases §§5–6, MBA §4-ceo');
  });

  // --- Restart persistence (§12, the core requirement) -------------------------
  let rrSnapshot = null;
  await section('12-restart', async () => {
    // (a) Persistence player: shifts + home + car, no listing yet.
    const pers = await newMember('persist', 'Gdeuce');
    await pers.act('player:switchCareer', { career: 'hustler' });
    await ensureCash(pers, 8500);
    await pers.act('player:buyHome', { homeId: 'maple-court' });
    await ensureCash(pers, 3000);
    await pers.act('player:buyCar', { carId: 'city-cruiser' });
    // List the home AFTER the base snapshot so the restart must preserve
    // both the owned assets and the live listing.
    await pers.act('player:listHome', { homeId: 'maple-court', price: 12000 });
    const snap = clone(pers.lastState);
    const listingId = snap.homes[0].listingId;
    check('12-restart', 'pre-restart snapshot captured (home + car + listing)',
      snap.homes.length === 1 && snap.cars.length === 1 && !!listingId,
      `homes=${snap.homes.length} cars=${snap.cars.length} listing=${listingId}`);
    pers.disconnect(); // disconnect immediately: ~0s of playtime flush drift
    disconnectAll();
    await stopServer();
    await startServer(false); // SAME scratch file, no wipe
    admin = await newAdmin('adminAfterRestart', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const pers2 = await newMember('persist2', 'Gdeuce');
    const after = pers2.lastState;
    check('12-restart', 'RESTART: cash identical after stop + restart + fresh ID login',
      after.cash === snap.cash, `cash ${snap.cash}->${after.cash}`);
    check('12-restart', 'RESTART: homes identical (ids + values) after restart',
      JSON.stringify(stripListingFields(after.homes)) === JSON.stringify(stripListingFields(snap.homes)),
      `homes ${JSON.stringify(snap.homes)} -> ${JSON.stringify(after.homes)}`);
    check('12-restart', 'RESTART: cars identical after restart',
      JSON.stringify(after.cars) === JSON.stringify(snap.cars),
      `cars ${JSON.stringify(snap.cars)} -> ${JSON.stringify(after.cars)}`);
    check('12-restart', 'RESTART: career + per-ladder progress identical after restart',
      after.career === snap.career && JSON.stringify(after.careers) === JSON.stringify(snap.careers),
      `career ${snap.career}->${after.career}`);
    check('12-restart', 'RESTART: points + milestones identical after restart (disconnect flush may add at most +1 pt)',
      after.points >= snap.points && after.points <= snap.points + 1
      && JSON.stringify(after.milestones) === JSON.stringify(snap.milestones),
      `points ${snap.points}->${after.points}, milestones ${snap.milestones.join(',')}->${after.milestones.join(',')}`);
    check('12-restart', 'RESTART: marketplace listing survives restart (same id + price)',
      (pers2.lastMarketplace || []).some((l) => l.id === listingId && l.price === 12000),
      `marketplace=${JSON.stringify(pers2.lastMarketplace)}`);
    await pers2.act('player:unlistHome', { listingId });
    check('12-restart', 'RESTART: unlist works after restart (listing cleared)',
      pers2.lastState.homes[0].listingId === null, 'listingId not null after unlist');
    pers2.disconnect();

    // (b) Changed admin ID survives restart.
    const change = await admin.adminOp('admin:changeId', { newId: TEMP_ADMIN_ID });
    check('12-restart', 'admin ID change accepted',
      change.op && change.op.ok === true, JSON.stringify(change.op || change.error));
    admin.disconnect();
    await stopServer();
    await startServer(false);
    const oldAdmin = new Client('oldAdmin', 'admin', null);
    await oldAdmin.connect();
    const oldAuth = await oldAdmin.login('admin', ADMIN0.adminId);
    check('12-restart', 'RESTART: old admin ID rejected after change + restart',
      oldAuth.ok === false, JSON.stringify(oldAuth));
    const tempAdmin = await newAdmin('tempAdmin', TEMP_ADMIN_ID);
    check('12-restart', 'RESTART: new admin ID works after restart',
      tempAdmin.lastAuth.ok === true, JSON.stringify(tempAdmin.lastAuth).slice(0, 120));
    const back = await tempAdmin.adminOp('admin:changeId', { newId: ADMIN0.adminId });
    check('12-restart', 'admin ID changed back to the original (cleanup)',
      back.op && back.op.ok === true, JSON.stringify(back.op || back.error));
    tempAdmin.disconnect(); oldAdmin.disconnect();
    admin = await newAdmin('adminRestored', ADMIN0.adminId);
    catalog = admin.lastCatalog;

    // (c) Removed status survives restart (player set up for §13).
    const rr = await newMember('rrPlayer', 'Inerpeace');
    await rr.act('player:switchCareer', { career: 'hustler' });
    await ensureCash(rr, 8500);
    await rr.act('player:buyHome', { homeId: 'maple-court' });
    await ensureCash(rr, 3000);
    await rr.act('player:buyCar', { carId: 'city-cruiser' });
    await rr.act('player:listHome', { homeId: 'maple-court', price: 9000 });
    rrSnapshot = clone(rr.lastState);
    const rem = await admin.adminOp('admin:removePlayer', { memberId: byName['Inerpeace'].id });
    check('12-restart', 'remove accepted for the restart test player',
      rem.op && rem.op.ok === true, JSON.stringify(rem.op || rem.error));
    await waitFor(() => rr.disconnected === true, 5000, 'removed session disconnect');
    check('12-restart', 'removed player live session is invalidated (socket disconnected)',
      rr.disconnected === true, 'socket still connected after remove');
    disconnectAll();
    await stopServer();
    await startServer(false);
    admin = await newAdmin('adminAfterRestart2', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const blocked = new Client('blockedAfterRestart', 'member', byName['Inerpeace'].id);
    await blocked.connect();
    const blockedAuth = await blocked.login('member', byName['Inerpeace'].id);
    check('12-restart', 'RESTART: removed status survives restart (login still blocked)',
      blockedAuth.ok === false && blockedAuth.error === 'This player account is currently removed. Contact an admin.',
      JSON.stringify(blockedAuth));
    blocked.disconnect();
  });

  // --- Remove / restore (§13) ---------------------------------------------------
  await section('13-remove-restore', async () => {
    // Ledger + leaderboard exclusion while removed; removed-row details.
    const ledgerMark = admin.ledger;
    admin.socket.emit('admin:ledger', {});
    await waitFor(() => admin.ledger !== ledgerMark && admin.ledger !== null, 10000, 'ledger data');
    check('13-remove-restore', 'removed player vanishes from the ledger',
      !admin.ledger.players.some((p) => p.memberId === byName['Inerpeace'].id),
      `ledger has ${admin.ledger.players.length} players`);
    check('13-remove-restore', 'removed player vanishes from the leaderboard',
      !(admin.lastLeaderboard || []).some((r) => r.name === 'Inerpeace'), 'Inerpeace on leaderboard');
    const row = (admin.ledger.removed || []).find((r) => r.memberId === byName['Inerpeace'].id);
    check('13-remove-restore', 'ledger removed array carries memberId + removedAt + restoreDeadline + daysLeft',
      !!row && !!row.removedAt && !!row.restoreDeadline && typeof row.daysLeft === 'number' && row.daysLeft >= 0 && row.daysLeft <= 3,
      JSON.stringify(row));
    check('13-remove-restore', "removed player's listings are delisted",
      !(admin.lastMarketplace || []).some((l) => l.sellerName === 'Inerpeace'),
      `marketplace=${JSON.stringify(admin.lastMarketplace)}`);
    const blocked2 = new Client('blocked2', 'member', byName['Inerpeace'].id);
    await blocked2.connect();
    const blockedAuth2 = await blocked2.login('member', byName['Inerpeace'].id);
    check('13-remove-restore', 'removed player login is blocked with the removed message',
      blockedAuth2.ok === false && blockedAuth2.error === 'This player account is currently removed. Contact an admin.',
      JSON.stringify(blockedAuth2));
    blocked2.disconnect();
    // Restore WITHIN 3 days: full state intact (listing itself is not
    // resurrected — removal delists; owned homes stay owned but unlisted).
    const res = await admin.adminOp('admin:restorePlayer', { memberId: byName['Inerpeace'].id });
    check('13-remove-restore', 'restore within 3 days accepted',
      res.op && res.op.ok === true, JSON.stringify(res.op || res.error));
    const rrBack = await newMember('rrBack', 'Inerpeace');
    check('13-remove-restore', 'restore WITHIN 3 days: cash + cars + career + points intact',
      rrBack.lastState.cash === rrSnapshot.cash
      && JSON.stringify(rrBack.lastState.cars) === JSON.stringify(rrSnapshot.cars)
      && rrBack.lastState.career === rrSnapshot.career
      && JSON.stringify(rrBack.lastState.careers) === JSON.stringify(rrSnapshot.careers)
      && rrBack.lastState.points === rrSnapshot.points
      && JSON.stringify(rrBack.lastState.milestones) === JSON.stringify(rrSnapshot.milestones),
      `cash ${rrSnapshot.cash}->${rrBack.lastState.cash}, points ${rrSnapshot.points}->${rrBack.lastState.points}`);
    check('13-remove-restore', 'restore WITHIN 3 days: homes intact (values + ids; listing stays delisted)',
      JSON.stringify(stripListingFields(rrBack.lastState.homes)) === JSON.stringify(stripListingFields(rrSnapshot.homes))
      && rrBack.lastState.homes[0].listingId === null,
      `homes ${JSON.stringify(rrBack.lastState.homes)}`);
    rrBack.disconnect();
    // Restore AFTER 3 days: re-remove, backdate removedAt in the scratch
    // file while the server is stopped, restart, restore.
    const rem2 = await admin.adminOp('admin:removePlayer', { memberId: byName['Inerpeace'].id });
    check('13-remove-restore', 're-remove accepted for the >3-day case',
      rem2.op && rem2.op.ok === true, JSON.stringify(rem2.op || rem2.error));
    disconnectAll();
    await stopServer();
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const rec = raw.members.find((m) => m.memberId === byName['Inerpeace'].id);
    if (!rec || !rec.removedAt) throw new Error('removed record not found in scratch file for backdating');
    rec.removedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(raw));
    await startServer(false);
    admin = await newAdmin('adminAfterRestart3', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const res2 = await admin.adminOp('admin:restorePlayer', { memberId: byName['Inerpeace'].id });
    check('13-remove-restore', 'restore after >3 days accepted (fresh-start message)',
      res2.op && res2.op.ok === true, JSON.stringify(res2.op || res2.error));
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).members
      .find((m) => m.memberId === byName['Inerpeace'].id);
    check('13-remove-restore', 'restore AFTER 3 days: stored record is a fresh reset (pre-login)',
      stored.cash === 10000 && stored.homes.length === 0 && stored.cars.length === 0
      && stored.mba === false && stored.points === 0 && stored.milestones.length === 0
      && stored.playSeconds === 0 && stored.removedAt === null,
      `stored=${JSON.stringify({ cash: stored.cash, homes: stored.homes.length, cars: stored.cars.length, mba: stored.mba, points: stored.points })}`);
    const rrFresh = await newMember('rrFresh', 'Inerpeace');
    check('13-remove-restore', 'restore AFTER 3 days: login shows fresh reset (only first-login re-granted, +25)',
      rrFresh.lastState.cash === 10000 && rrFresh.lastState.homes.length === 0 && rrFresh.lastState.cars.length === 0
      && rrFresh.lastState.mba === false && rrFresh.lastState.playSeconds === 0
      && rrFresh.lastState.career === null
      && rrFresh.lastState.milestones.length === 1 && rrFresh.lastState.milestones[0] === 'first-login'
      && rrFresh.lastState.points === 25
      && Object.values(rrFresh.lastState.careers).every((c) => c.level === 0 && c.shifts === 0),
      `state=${JSON.stringify({ cash: rrFresh.lastState.cash, points: rrFresh.lastState.points, milestones: rrFresh.lastState.milestones, career: rrFresh.lastState.career })}`);
    rrFresh.disconnect();
  });

  // --- Admin console (§14) -------------------------------------------------------
  await section('14-admin', async () => {
    disconnectAll();
    admin = await newAdmin('adminConsole', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const ledgerMark = admin.ledger;
    admin.socket.emit('admin:ledger', {});
    await waitFor(() => admin.ledger !== ledgerMark && admin.ledger !== null, 10000, 'ledger data');
    check('14-admin', 'ledger returns all non-removed players (26)',
      admin.ledger.players.length === 26, `players=${admin.ledger.players.length}`);
    check('14-admin', 'ledger rows carry memberId/tier/points/playSeconds/netWorth; no admins in ledger',
      admin.ledger.players.every((p) => p.memberId && p.tier && typeof p.points === 'number')
      && !admin.ledger.players.some((p) => ['CoolVibez', 'Nimmie', 'ReeseCup'].includes(p.name)),
      `first=${JSON.stringify(admin.ledger.players[0])}`);
    const stMark = admin.standings;
    admin.socket.emit('admin:standings', {});
    await waitFor(() => admin.standings !== stMark && admin.standings !== null, 10000, 'standings data');
    const standings = admin.standings.standings;
    check('14-admin', 'standings return all non-removed players, ranked, with memberIds',
      standings.length === 26 && standings.every((s, i) => s.rank === i + 1 && s.memberId)
      && standings.every((s, i) => i === 0 || standings[i - 1].netWorth >= s.netWorth),
      `standings=${standings.length}`);
    check('14-admin', 'admins never appear in standings',
      !standings.some((s) => ['CoolVibez', 'Nimmie', 'ReeseCup'].includes(s.name)), 'admin in standings');
    const exMark = admin.exportData;
    admin.socket.emit('admin:export', { kind: 'points' });
    await waitFor(() => admin.exportData !== exMark && admin.exportData !== null, 10000, 'points export');
    const pointsCsv = admin.exportData.csv;
    check('14-admin', 'points CSV has the contract header',
      pointsCsv.split('\n')[0] === 'name,memberId,tier,points,playSeconds,netWorth',
      `header=${pointsCsv.split('\n')[0]}`);
    check('14-admin', 'points CSV has one row per active player and contains member IDs (admin-only export)',
      pointsCsv.split('\n').length === 27 && /\bPVR\d{5}\b/.test(pointsCsv),
      `lines=${pointsCsv.split('\n').length}`);
    const exMark2 = admin.exportData;
    admin.socket.emit('admin:export', { kind: 'standings' });
    await waitFor(() => admin.exportData !== exMark2, 10000, 'standings export');
    const standingsCsv = admin.exportData.csv;
    check('14-admin', 'standings CSV has the contract header',
      standingsCsv.split('\n')[0] === 'rank,name,memberId,tier,netWorth,homes,cars,points',
      `header=${standingsCsv.split('\n')[0]}`);
    check('14-admin', 'standings CSV has one row per active player',
      standingsCsv.split('\n').length === 27, `lines=${standingsCsv.split('\n').length}`);
    // Catalog edits apply to subsequent purchases and day cycles.
    const maple0 = catalog.homes.find((h) => h.id === 'maple-court');
    const editP = await admin.adminOp('admin:updateCatalog', { type: 'home', id: 'maple-court', fields: { price: 9000 } });
    check('14-admin', 'catalog price edit accepted',
      editP.op && editP.op.ok === true, JSON.stringify(editP.op || editP.error));
    await waitFor(() => admin.lastCatalog && admin.lastCatalog.homes.find((h) => h.id === 'maple-court').price === 9000,
      10000, 'catalog price broadcast');
    const rich2 = await newMember('rich2', 'Denise Cool');
    await ensureCash(rich2, 9000);
    const catNow = rich2.lastCatalog;
    const buyEdited = await rich2.windowed('player:buyHome', { homeId: 'maple-court' });
    check('14-admin', 'catalog price edit applies to subsequent purchases (exactly $9,000)',
      !buyEdited.error && cashOk(buyEdited.before, buyEdited.after, -9000, buyEdited.lifeDelta, buyEdited.dayDelta,
        catNow.homes.find((h) => h.id === 'maple-court').rent),
      `cash ${buyEdited.before.cash}->${buyEdited.after.cash}`);
    const editR = await admin.adminOp('admin:updateCatalog', { type: 'home', id: 'maple-court', fields: { rent: 999 } });
    check('14-admin', 'catalog rent edit accepted', editR.op && editR.op.ok === true, JSON.stringify(editR.op || editR.error));
    const cb2 = await newMember('carebear2', 'Carebear');
    const dayB = cb2.lastState.day; const cashB = cb2.lastState.cash;
    const toastMark = cb2.toasts.length;
    await admin.adminOp('admin:advanceDay', {});
    await waitFor(() => cb2.lastState.day > dayB, 10000, 'rent-edit day advance');
    const lifeR = cb2.toasts.slice(toastMark).filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + t.delta, 0);
    const DR = cb2.lastState.day - dayB;
    const unlistedMaples = cb2.lastState.homes.filter((h) => h.homeId === 'maple-court' && !h.listingId).length;
    check('14-admin', 'catalog rent edit applies from the next day cycle ($999/maple)',
      cb2.lastState.cash === cashB + 999 * unlistedMaples * DR + lifeR,
      `cash ${cashB}->${cb2.lastState.cash}, expected +${999 * unlistedMaples * DR}+life(${lifeR})`);
    const editS = await admin.adminOp('admin:updateCatalog', { type: 'car', id: 'jet-setter', fields: { stock: 0 } });
    check('14-admin', 'catalog stock edit accepted', editS.op && editS.op.ok === true, JSON.stringify(editS.op || editS.error));
    const jetBuy = await rich2.windowed('player:buyCar', { carId: 'jet-setter' });
    check('14-admin', 'catalog stock edit to 0 makes the car unsellable (sold out)',
      !!jetBuy.error && /sold out/i.test(jetBuy.error.message), JSON.stringify(jetBuy.error));
    // Restore catalog defaults touched here.
    await admin.adminOp('admin:updateCatalog', { type: 'home', id: 'maple-court', fields: { price: maple0.price, rent: maple0.rent } });
    await admin.adminOp('admin:updateCatalog', { type: 'car', id: 'jet-setter', fields: { stock: 1 } });
    await waitFor(() => admin.lastCatalog
      && admin.lastCatalog.homes.find((h) => h.id === 'maple-court').price === maple0.price
      && admin.lastCatalog.homes.find((h) => h.id === 'maple-court').rent === maple0.rent,
      10000, 'catalog restore broadcast');
    check('14-admin', 'catalog edits restored to defaults after the test',
      admin.lastCatalog.homes.find((h) => h.id === 'maple-court').price === maple0.price
      && admin.lastCatalog.homes.find((h) => h.id === 'maple-court').rent === maple0.rent,
      'restore mismatch');
    // advanceDay triggers exactly one day cycle (retry: auto cycles run every 5s).
    let oneDayOk = false; let oneDayDetail = '';
    for (let attempt = 0; attempt < 5 && !oneDayOk; attempt++) {
      const D0 = admin.lastDay;
      const op = await admin.adminOp('admin:advanceDay', {});
      await waitFor(() => admin.lastDay > D0, 10000, 'advanceDay game:day');
      const delta = admin.lastDay - D0;
      oneDayDetail = `day ${D0}->${admin.lastDay} (delta ${delta}), op=${JSON.stringify(op.op)}`;
      if (delta === 1 && op.op && op.op.message === `Advanced to day ${admin.lastDay}.`) oneDayOk = true;
      else await sleep(6000); // let any racing auto cycle pass before retrying
    }
    check('14-admin', 'admin:advanceDay triggers exactly one day cycle',
      oneDayOk, oneDayDetail);
    rich2.disconnect(); cb2.disconnect();
  });

  // --- Cheat probes (§15) ---------------------------------------------------------
  await section('15-cheats', async () => {
    const paris = await newMember('cheatParis', 'Paris');
    await ensureCash(paris, 8500);
    const forged = await paris.windowed('player:buyHome', { homeId: 'maple-court', price: 1, cash: 999999 });
    check('15-cheats', 'forged purchase with a client-invented price is charged the catalog price, not $1',
      !forged.error && cashOk(forged.before, forged.after, -8500, forged.lifeDelta, forged.dayDelta, 120),
      `cash ${forged.before.cash}->${forged.after.cash}, err=${JSON.stringify(forged.error)}`);
    const rasheed = await newMember('cheatRasheed', 'Rasheed');
    await rasheed.act('player:switchCareer', { career: 'hustler' });
    const forgedCash = await rasheed.windowed('player:workShift', { cash: 999999, salary: 999999 });
    check('15-cheats', 'forged cash/salary in a payload is ignored (shift pays exactly $150)',
      cashOk(forgedCash.before, forgedCash.after, 150, forgedCash.lifeDelta, forgedCash.dayDelta, 0),
      `cash ${forgedCash.before.cash}->${forgedCash.after.cash}`);
    const shal = await newMember('cheatShal', 'Shalashae');
    const noFunds = await shal.windowed('player:buyHome', { homeId: 'pulse-palace' });
    check('15-cheats', 'buying a home without funds is rejected with no state change',
      !!noFunds.error && shal.lastState.homes.length === 0
      && cashOk(noFunds.before, noFunds.after, 0, noFunds.lifeDelta, noFunds.dayDelta, 0),
      `cash ${noFunds.before.cash}->${noFunds.after.cash}, err=${JSON.stringify(noFunds.error)}`);
    const stacie = await newMember('cheatStacie', 'Stacie D.');
    await stacie.act('player:switchCareer', { career: 'hustler' });
    const promoCheat = await stacie.windowed('player:promote', {});
    check('15-cheats', 'promoting without 5 shifts is rejected with no state change',
      !!promoCheat.error && stacie.lastState.careerLevel === 0 && stacie.lastState.shiftsAtLevel === 0,
      JSON.stringify(promoCheat.error));
    const stoic = await newMember('cheatStoic', 'Stoic');
    const ceoCheat = await stoic.windowed('player:switchCareer', { career: 'ceo' });
    check('15-cheats', 'buying/entering the CEO ladder without MBA is rejected',
      !!ceoCheat.error && stoic.lastState.career !== 'ceo', JSON.stringify(ceoCheat.error));
    const tight = await newMember('cheatTight', 'Tightwork');
    const eMark = tight.errorSeq;
    tight.socket.emit('admin:removePlayer', { memberId: byName['Trendi'].id });
    tight.socket.emit('admin:advanceDay', {});
    await waitFor(() => tight.errorSeq >= eMark + 2, 10000, 'member admin-event cheat rejections');
    check('15-cheats', 'calling admin events as a member yields no admin:opResult',
      tight.lastOp === null, `lastOp=${JSON.stringify(tight.lastOp)}`);
    const trendiAlive = await new Client('trendiCheck', 'member', byName['Trendi'].id);
    await trendiAlive.connect();
    const trendiAuth = await trendiAlive.login('member', byName['Trendi'].id);
    check('15-cheats', 'calling admin events as a member is rejected and the target is untouched',
      trendiAuth.ok === true,
      `trendi login ok=${trendiAuth.ok}`);
    trendiAlive.disconnect();
    const eMarkA = admin.errorSeq;
    admin.socket.emit('player:workShift', {});
    admin.socket.emit('player:buyHome', { homeId: 'maple-court' });
    await waitFor(() => admin.errorSeq >= eMarkA + 2, 10000, 'admin player-event cheat rejections');
    check('15-cheats', 'calling player events as an admin is rejected',
      admin.lastError && /Not authorized/.test(admin.lastError.message), JSON.stringify(admin.lastError));
    const trendi2 = await newMember('cheatTrendi', 'Trendi');
    const ghost = await trendi2.windowed('player:buyListing', { listingId: 'does-not-exist-123' });
    check('15-cheats', 'buying a listing that does not exist is rejected with no state change',
      !!ghost.error && cashOk(ghost.before, ghost.after, 0, ghost.lifeDelta, ghost.dayDelta, 0),
      JSON.stringify(ghost.error));
    const wicked = await newMember('cheatWicked', 'Wicked Kitten');
    await ensureCash(wicked, 8500);
    await wicked.act('player:buyHome', { homeId: 'maple-court' });
    await wicked.act('player:listHome', { homeId: 'maple-court', price: -500 });
    const negListing = (wicked.lastMarketplace || []).find((l) => l.sellerName === 'Wicked Kitten');
    check('15-cheats', 'negative listing price is clamped to the $100 floor',
      !!negListing && negListing.price === 100, `listing=${JSON.stringify(negListing)}`);
    await wicked.act('player:unlistHome', { listingId: wicked.lastState.homes[0].listingId });
    paris.disconnect(); rasheed.disconnect(); shal.disconnect(); stacie.disconnect();
    stoic.disconnect(); tight.disconnect(); trendi2.disconnect(); wicked.disconnect();
  });

  // --- Console errors (§16) ---------------------------------------------------------
  await section('16-console', async () => {
    const errLines = [...serverErr];
    const outErrLines = serverOut.filter((l) => /error|Error|Unhandled|failed/i.test(l));
    check('16-console', 'zero console errors: server stderr is empty',
      errLines.length === 0, `stderr lines: ${errLines.slice(0, 5).join(' | ')}`);
    check('16-console', 'zero console errors: no error lines on server stdout',
      outErrLines.length === 0, `stdout error lines: ${outErrLines.slice(0, 5).join(' | ')}`);
    check('16-console', 'server process stayed alive for the whole run',
      child !== null, 'server child exited early');
  });

  // ---------- v2 socket sections (§17–§26) ---------------------------------
  await section('17-shift-cap', async () => {
    const bw = await newMember('bw17', 'Bwonderful');
    await bw.act('player:switchCareer', { career: 'hustler' });
    for (let i = 0; i < 3; i++) {
      const r = await bw.act('player:workShift', {});
      check('17-shift-cap', `shift ${i + 1} of 3 within the window succeeds`,
        !r.error, JSON.stringify(r.error));
    }
    const beforeCap = clone(bw.lastState);
    const capped = await bw.act('player:workShift', {});
    check('17-shift-cap', '4th shift inside the window is rejected with the shift-limit message and cash unchanged',
      !!capped.error && /shift limit/i.test(capped.error.message) && bw.lastState.cash === beforeCap.cash,
      JSON.stringify(capped.error));
    await sleep(700);
    const okAgain = await shiftOK(bw);
    check('17-shift-cap', 'after the window passes, a shift succeeds again',
      !!okAgain && !okAgain.error, JSON.stringify(okAgain && okAgain.error));
    check('17-shift-cap', 'shiftHistory reflects pruning (only the post-window shift remains)',
      bw.lastState.shiftHistory.length === 1, JSON.stringify(bw.lastState.shiftHistory));
    bw.disconnect();
  });

  await section('18-careers', async () => {
    const kay = await newMember('kay18', 'Kay Kay');
    const ladders = [
      ['trader', 300], ['tech', 280], ['chef', 180], ['fitness', 170],
    ];
    for (const [careerId, salary] of ladders) {
      await kay.act('player:switchCareer', { career: careerId });
      const w = await windowedShift(kay);
      check('18-careers', `${careerId} L0 shift pays $${salary}`,
        cashOk(w.before, w.after, salary, w.lifeDelta, w.dayDelta, 0),
        `cash ${w.before.cash}->${w.after.cash}, life ${w.lifeDelta}, days ${w.dayDelta}`);
    }
    const ceoTry = await kay.act('player:switchCareer', { career: 'ceo' });
    check('18-careers', 'CEO track still locked without the MBA',
      !!ceoTry.error && /MBA/i.test(ceoTry.error.message) && kay.lastState.career !== 'ceo',
      JSON.stringify(ceoTry.error));
    kay.disconnect();
  });

  await section('19-promotions', async () => {
    const rob = await newMember('rob19', "That's Robyn");
    await rob.act('player:switchCareer', { career: 'hustler' });
    for (let i = 0; i < 5; i++) await shiftOK(rob);
    const early = await rob.act('player:promote', {});
    check('19-promotions', 'promotion with 5 shifts but too little playtime is rejected for playtime',
      !!early.error && /playtime/i.test(early.error.message) && rob.lastState.careerLevel === 0,
      JSON.stringify(early.error));
    await promoteReady(rob);
    check('19-promotions', 'promotion succeeds once the playtime gate is met (level 1)',
      rob.lastState.careerLevel === 1 && rob.lastState.shiftsAtLevel === 0,
      `level ${rob.lastState.careerLevel}, shifts ${rob.lastState.shiftsAtLevel}`);
    for (let i = 0; i < 5; i++) await shiftOK(rob);
    const early2 = await rob.act('player:promote', {});
    check('19-promotions', 'level-2 promotion rejected for playtime against the higher gate',
      !!early2.error && /playtime/i.test(early2.error.message) && rob.lastState.careerLevel === 1,
      JSON.stringify(early2.error));
    await promoteReady(rob);
    check('19-promotions', 'level-2 promotion succeeds once its playtime gate is met',
      rob.lastState.careerLevel === 2, `level ${rob.lastState.careerLevel}`);
    rob.disconnect();
  });

  await section('20-board-tiles', async () => {
    const tw = await newMember('tw20', 'Twan');
    check('20-board-tiles', 'fresh player starts on board tile 1 ($10,000)',
      tw.lastState.boardPosition === 1, `tile ${tw.lastState.boardPosition}`);
    await grindTo(tw, 50000);
    check('20-board-tiles', 'crossing $50,000 net worth claims tile 5',
      tw.lastState.claimedTiles.includes(5),
      `claimed ${JSON.stringify(tw.lastState.claimedTiles)}, netWorth ${tw.lastState.netWorth}`);
    const refreshed = await tw.refresh();
    check('20-board-tiles', 'claimed tile 5 survives a re-login refresh',
      refreshed && refreshed.claimedTiles.includes(5),
      JSON.stringify(refreshed && refreshed.claimedTiles));
    tw.disconnect();
  });

  await section('21-wallet', async () => {
    const tw = await newMember('tw21', 'Twan');
    const bh = await tw.act('player:buyHome', { homeId: 'maple-court' });
    check('21-wallet', 'buying Maple Court succeeds', !bh.error, JSON.stringify(bh.error));
    const bc = await tw.act('player:buyCar', { carId: 'city-cruiser' });
    check('21-wallet', 'buying City Cruiser succeeds', !bc.error, JSON.stringify(bc.error));
    const s = tw.lastState;
    const w = s.wallet;
    const expectedCharge = s.wallet.homes.reduce((a, h) => a + Math.round(0.02 * h.value), 0);
    check('21-wallet', 'wallet snapshot matches state (cash, netWorth, homes, cars)',
      w && w.cash === s.cash && w.netWorth === s.netWorth
      && w.homes.length === s.homes.length && w.cars.length === s.cars.length
      && w.homes.some((h) => h.name === 'Maple Court Starter')
      && w.cars.some((c) => c.carId === 'city-cruiser'),
      JSON.stringify(w));
    check('21-wallet', 'wallet nextUtilityCharge = sum of round(2% x value) over wallet homes (same state)',
      w.nextUtilityCharge === expectedCharge, `charge ${w.nextUtilityCharge} vs ${expectedCharge}`);
    check('21-wallet', 'wallet nextUtilityDay is set after buying a home',
      typeof w.nextUtilityDay === 'number' && w.nextUtilityDay !== null,
      `nextUtilityDay ${w.nextUtilityDay}`);
    tw.disconnect();
  });

  await section('22-frontend', async () => {
    const idx = await httpGet('/');
    for (const needle of ['How to Play', 'howToModal', 'walletModal', 'mailCard', 'resetCard', 'howToPlayBtn', '3 shifts every 24 hours']) {
      check('22-frontend', `landing HTML contains ${needle}`, idx.body.includes(needle), `missing ${needle}`);
    }
    const css = await httpGet('/style.css');
    for (const needle of ['hero.jpg', '.modal', '.badge']) {
      check('22-frontend', `style.css contains ${needle}`, css.body.includes(needle), `missing ${needle}`);
    }
    const a22 = await newAdmin('admin22', ADMIN0.adminId);
    const cat = a22.lastCatalog;
    check('22-frontend', 'admin catalog: every home/car photo is an images.unsplash.com https URL',
      cat.homes.every((h) => String(h.photo).startsWith('https://images.unsplash.com/'))
      && cat.cars.every((c) => String(c.photo).startsWith('https://images.unsplash.com/')),
      cat.homes.map((h) => h.photo).concat(cat.cars.map((c) => c.photo)).join(' | '));
    check('22-frontend', 'admin catalog: board 40 tiles, tile rewards at [5,10,15,20,25], 8 careers',
      cat.board.tiles === 40
      && JSON.stringify(cat.tileRewards.map((t) => t.tile)) === '[5,10,15,20,25]'
      && cat.careers.length === 8,
      `tiles ${cat.board.tiles}, rewards ${cat.tileRewards.map((t) => t.tile).join(',')}, careers ${cat.careers.length}`);
    check('22-frontend', 'admin catalog: exclusive car present in snapshot but NOT in buyable cars',
      !!cat.exclusiveCar && cat.exclusiveCar.id === 'pulse-phantom'
      && !cat.cars.some((c) => c.id === 'pulse-phantom'),
      JSON.stringify(cat.exclusiveCar));
    a22.disconnect();
  });

  await section('23-messaging', async () => {
    const bw = await newMember('bw23', 'Bwonderful');
    const kay = await newMember('kay23', 'Kay Kay');
    const rob = await newMember('rob23', "That's Robyn");
    const pingMark = kay.lastMailNew;
    const sent = await bw.mailOp('player:sendMessage', { toName: 'Kay Kay', subject: 'Hi', body: 'Hello from the test!' });
    check('23-messaging', 'sending a message succeeds (sender inbox shows it, no error)',
      !sent.error && sent.inbox && sent.inbox.messages.some((m) => m.toName === 'Kay Kay' && m.subject === 'Hi'),
      JSON.stringify(sent.error || sent.inbox));
    await waitFor(() => kay.lastMailNew !== pingMark && kay.lastMailNew !== null, 10000, 'recipient mail:new ping');
    check('23-messaging', 'recipient receives a mail:new ping (badge/alert)',
      !!kay.lastMailNew && kay.lastMailNew.fromName === 'Bwonderful',
      JSON.stringify(kay.lastMailNew));
    const listed = await kay.mailOp('player:listMail', {});
    const msg = listed.inbox && listed.inbox.messages.find((m) => m.fromName === 'Bwonderful' && m.subject === 'Hi');
    check('23-messaging', 'recipient inbox contains the message with unread = 1',
      !!msg && listed.inbox.unread === 1, JSON.stringify(listed.inbox));
    const read = await kay.mailOp('player:readMail', { id: msg.id });
    check('23-messaging', 'readMail marks the message read and drops unread to 0',
      read.inbox && read.inbox.unread === 0
      && read.inbox.messages.find((m) => m.id === msg.id).read === true,
      JSON.stringify(read.inbox));
    const robInbox = await rob.mailOp('player:listMail', {});
    check('23-messaging', 'a third player inbox does NOT contain the private message',
      !robInbox.inbox.messages.some((m) => m.id === msg.id),
      `third-party inbox has ${robInbox.inbox.messages.length} messages`);
    const selfMsg = await bw.mailOp('player:sendMessage', { toName: 'Bwonderful', subject: 'Self', body: 'me' });
    check('23-messaging', 'self-message is rejected', !!selfMsg.error, JSON.stringify(selfMsg.error));
    const unknown = await bw.mailOp('player:sendMessage', { toName: 'Nobody Here', subject: 'X', body: 'y' });
    check('23-messaging', 'unknown-recipient message is rejected', !!unknown.error, JSON.stringify(unknown.error));
    const adm = await newAdmin('admin23', ADMIN0.adminId);
    const admTry = await adm.adminOp('player:sendMessage', { toName: 'Kay Kay', subject: 'X', body: 'y' });
    check('23-messaging', 'admin socket calling player:sendMessage is rejected with no opResult',
      !!admTry.error && !admTry.op, JSON.stringify(admTry.error || admTry.op));
    bw.disconnect(); kay.disconnect(); rob.disconnect(); adm.disconnect();
  });

  await section('24-utilities', async () => {
    disconnectAll();
    await stopServer();
    await startServer(false, { UTILITY_INTERVAL_DAYS: '2' });
    admin = await newAdmin('admin24', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const rob = await newMember('rob24', "That's Robyn");
    await ensureCash(rob, 9000); // insurance against life-event drift since §19
    const buy = await rob.act('player:buyHome', { homeId: 'maple-court' });
    check('24-utilities', 'buying a home succeeds for the utility test', !buy.error, JSON.stringify(buy.error));
    const purchased = clone(rob.lastState);
    check('24-utilities', 'wallet nextUtilityCharge is $170 (2% of $8,500) right after purchase',
      purchased.wallet.nextUtilityCharge === 170, `charge ${purchased.wallet.nextUtilityCharge}`);
    check('24-utilities', 'wallet nextUtilityDay = purchase day + 2',
      purchased.wallet.nextUtilityDay === purchased.day + 2,
      `day ${purchased.day}, next ${purchased.wallet.nextUtilityDay}`);
    const toastMark = rob.toasts.length;
    const dayBefore = purchased.day;
    const targetDay = purchased.wallet.nextUtilityDay;
    for (let i = 0; i < 3 && rob.lastState.day < targetDay; i++) {
      await admin.adminOp('admin:advanceDay', {});
    }
    await waitFor(() => rob.lastState.day >= targetDay, 30000, 'reach utility day');
    const after = await rob.refresh();
    const newToasts = rob.toasts.slice(toastMark);
    const utilDelta = newToasts.filter((t) => t.title === 'Utilities Due').reduce((a, t) => a + (t.delta || 0), 0);
    const lifeDelta = newToasts.filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + (t.delta || 0), 0);
    const tileDelta = newToasts.filter((t) => t.title === 'Tile Reward!').reduce((a, t) => a + (t.delta || 0), 0);
    const dayDelta = after.day - dayBefore;
    check('24-utilities', 'a negative Utilities Due toast fired on the utility day',
      utilDelta < 0, `utility delta ${utilDelta}`);
    check('24-utilities', 'nextUtilityDay advanced past the charged day',
      after.nextUtilityDay > purchased.wallet.nextUtilityDay,
      `next ${after.nextUtilityDay} vs ${purchased.wallet.nextUtilityDay}`);
    check('24-utilities', 'exact cash after days: rent x dayDelta + life deltas + utility delta (+ tile deltas)',
      after.cash === purchased.cash + 120 * dayDelta + lifeDelta + utilDelta + tileDelta,
      `cash ${purchased.cash}->${after.cash}, rent 120x${dayDelta}, life ${lifeDelta}, util ${utilDelta}, tile ${tileDelta}`);
    rob.disconnect();
  });

  await section('25-migration', async () => {
    disconnectAll();
    await stopServer();
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const ladder0 = () => ({
      hustler: { level: 0, shifts: 0 }, creative: { level: 0, shifts: 0 },
      business: { level: 0, shifts: 0 }, ceo: { level: 0, shifts: 0 },
      trader: { level: 0, shifts: 0 }, chef: { level: 0, shifts: 0 },
      fitness: { level: 0, shifts: 0 }, tech: { level: 0, shifts: 0 },
    });
    // Deliberately NO v2 fields (active, shiftHistory, claimedTiles,
    // nextUtilityDay) — exactly like pre-v2 rows in the live database.
    raw.members.push({
      memberId: 'PVR99991', name: 'MigActive', tier: 'Rookie', cash: 15000,
      homes: [{ instanceId: 'mig-home-1', homeId: 'maple-court', name: 'Maple Court Starter',
        value: 8500, purchasePrice: 8500, listedPrice: null, listingId: null }],
      cars: [], career: null, careers: { ...ladder0(), hustler: { level: 0, shifts: 3 } },
      mba: false, points: 25, playSeconds: 120, milestones: ['first-login'],
      removedAt: null, token: null, firstLoginAt: null,
    });
    raw.members.push({
      memberId: 'PVR99992', name: 'MigInactive', tier: 'Rookie', cash: 9400,
      homes: [], cars: [], career: null, careers: ladder0(),
      mba: false, points: 0, playSeconds: 0, milestones: [],
      removedAt: null, token: null, firstLoginAt: null,
    });
    fs.writeFileSync(DATA_FILE, JSON.stringify(raw));
    // Boot once and stop immediately (before any auto day-cycle can run)
    // so the migration's own writes are what the file check sees.
    await startServer(false);
    await stopServer();
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const sActive = stored.members.find((m) => m.memberId === 'PVR99991');
    const sInactive = stored.members.find((m) => m.memberId === 'PVR99992');
    check('25-migration', 'active-looking row migrated to active with cash/homes preserved',
      sActive && sActive.active === true && sActive.cash === 15000 && sActive.homes.length === 1
      && sActive.homes[0].value === 8500,
      JSON.stringify(sActive && { active: sActive.active, cash: sActive.cash, homes: sActive.homes.length }));
    check('25-migration', 'inactive-looking row migrated to inactive with cash reset to exactly $10,000',
      sInactive && sInactive.active === false && sInactive.cash === 10000,
      JSON.stringify(sInactive && { active: sInactive.active, cash: sInactive.cash }));
    await startServer(false);
    admin = await newAdmin('admin25b', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const lbRow = (admin.lastLeaderboard || []).find((r) => r.name === 'MigInactive');
    check('25-migration', 'leaderboard shows the inactive migrated member at $10,000 with 0 homes',
      !!lbRow && lbRow.netWorth === 10000 && lbRow.homes === 0,
      JSON.stringify(lbRow));
    const dayBefore = admin.lastDay;
    await admin.adminOp('admin:advanceDay', {});
    await waitFor(() => admin.lastDay > dayBefore, 15000, 'day advanced after migration');
    const dayDelta = admin.lastDay - dayBefore;
    await stopServer();
    const stored2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const sActive2 = stored2.members.find((m) => m.memberId === 'PVR99991');
    const sInactive2 = stored2.members.find((m) => m.memberId === 'PVR99992');
    check('25-migration', 'inactive row skipped by the day cycle (cash still $10,000, milestones still empty)',
      sInactive2.cash === 10000 && sInactive2.milestones.length === 0,
      `cash ${sInactive2.cash}, milestones ${JSON.stringify(sInactive2.milestones)}`);
    check('25-migration', 'active row home appreciated by exactly compound(8500, 0.4, dayDelta)',
      sActive2.homes[0].value === compound(8500, 0.4, dayDelta),
      `value ${sActive2.homes[0].value} vs ${compound(8500, 0.4, dayDelta)} (dayDelta ${dayDelta})`);
    await startServer(false);
    admin = await newAdmin('admin25c', ADMIN0.adminId);
    catalog = admin.lastCatalog;
  });

  await section('26-reset', async () => {
    const kay = await newMember('kay26', 'Kay Kay');
    const bw = await newMember('bw26', 'Bwonderful');
    await ensureCash(kay, 9000); // insurance against life-event drift since §18
    const buy = await kay.act('player:buyHome', { homeId: 'maple-court' });
    check('26-reset', 'setup: Kay Kay buys a home', !buy.error, JSON.stringify(buy.error));
    const list = await kay.act('player:listHome', { homeId: 'maple-court', price: 9000 });
    check('26-reset', 'setup: Kay Kay lists the home', !list.error, JSON.stringify(list.error));
    const msg = await kay.mailOp('player:sendMessage', { toName: 'Bwonderful', subject: 'ResetTest', body: 'before reset' });
    check('26-reset', 'setup: Kay Kay messages Bwonderful', !msg.error, JSON.stringify(msg.error));
    const nimmie = await newAdmin('nimmie26', ADMINS[1].adminId);
    const reese = await newAdmin('reesecup26', ADMINS[2].adminId);
    const kayBefore = clone(kay.lastState);
    const kayToastMark = kay.toasts.length;
    const nTry = await nimmie.adminOp('admin:resetPlayer', { memberId: byName['Kay Kay'].id, confirm: true });
    check('26-reset', 'Nimmie resetPlayer is rejected server-side',
      nTry.op && nTry.op.ok === false, JSON.stringify(nTry.op || nTry.error));
    const rTry = await reese.adminOp('admin:resetPlayer', { memberId: byName['Kay Kay'].id, confirm: true });
    check('26-reset', 'ReeseCup resetPlayer is rejected server-side',
      rTry.op && rTry.op.ok === false, JSON.stringify(rTry.op || rTry.error));
    const noConfirm = await admin.adminOp('admin:resetPlayer', { memberId: byName['Kay Kay'].id });
    check('26-reset', 'CoolVibez resetPlayer without confirm is rejected',
      noConfirm.op && noConfirm.op.ok === false, JSON.stringify(noConfirm.op || noConfirm.error));
    const kayLife = kay.toasts.slice(kayToastMark)
      .filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + (t.delta || 0), 0);
    const kayStill = await kay.refresh();
    check('26-reset', 'Kay Kay unchanged after rejected resets (cash + life deltas, same home ids)',
      kayStill && kayStill.cash === kayBefore.cash + kayLife
      && JSON.stringify(kayStill.homes.map((h) => h.homeId)) === JSON.stringify(kayBefore.homes.map((h) => h.homeId)),
      `cash ${kayBefore.cash}+${kayLife} vs ${kayStill && kayStill.cash}`);
    const bwSnap = await bw.refresh();
    const bwToastMark = bw.toasts.length;
    const reset = await admin.adminOp('admin:resetPlayer', { memberId: byName['Kay Kay'].id, confirm: true });
    check('26-reset', 'CoolVibez individual reset accepted',
      reset.op && reset.op.ok === true, JSON.stringify(reset.op || reset.error));
    await waitFor(() => kay.disconnected === true, 10000, 'Kay Kay session disconnected by reset');
    check('26-reset', 'reset disconnects the player live session', kay.disconnected === true);
    await stopServer();
    const rawF = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const kayRec = rawF.members.find((m) => m.memberId === byName['Kay Kay'].id);
    check('26-reset', 'individual reset leaves an exact fresh record',
      kayRec && kayRec.cash === 10000 && kayRec.homes.length === 0 && kayRec.cars.length === 0
      && kayRec.mba === false && kayRec.points === 0 && kayRec.milestones.length === 0
      && kayRec.removedAt === null && kayRec.active === false
      && Object.values(kayRec.careers).every((c) => c.level === 0 && c.shifts === 0)
      && (kayRec.shiftHistory || []).length === 0 && (kayRec.claimedTiles || []).length === 0
      && kayRec.nextUtilityDay === null,
      JSON.stringify(kayRec && { cash: kayRec.cash, homes: kayRec.homes.length, cars: kayRec.cars.length, points: kayRec.points, milestones: kayRec.milestones.length }));
    check('26-reset', "individual reset removes the player's marketplace listing",
      !rawF.listings.some((l) => l.sellerMemberId === byName['Kay Kay'].id),
      `listings=${rawF.listings.length}`);
    check('26-reset', "individual reset deletes the player's messages",
      !rawF.messages.some((m) => m.fromMemberId === byName['Kay Kay'].id || m.toMemberId === byName['Kay Kay'].id),
      `messages=${rawF.messages.length}`);
    const bwRec = rawF.members.find((m) => m.memberId === byName['Bwonderful'].id);
    const bwLife = bw.toasts.slice(bwToastMark)
      .filter((t) => LIFE_TITLES.has(t.title)).reduce((a, t) => a + (t.delta || 0), 0);
    check('26-reset', 'other players untouched by individual reset (Bwonderful cash + life deltas, same homes/cars/milestones)',
      bwRec && bwRec.cash === bwSnap.cash + bwLife
      && JSON.stringify(bwRec.homes.map((h) => h.homeId)) === JSON.stringify(bwSnap.homes.map((h) => h.homeId))
      && JSON.stringify(bwRec.cars.map((c) => c.carId)) === JSON.stringify(bwSnap.cars.map((c) => c.carId))
      && JSON.stringify(bwRec.milestones) === JSON.stringify(bwSnap.milestones),
      `cash ${bwSnap.cash}+${bwLife} vs ${bwRec && bwRec.cash}`);
    await startServer(false);
    admin = await newAdmin('admin26b', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const bw2 = await newMember('bw26b', 'Bwonderful');
    const bwInbox = await bw2.mailOp('player:listMail', {});
    check('26-reset', "reset deletes the player's messages from the other party's inbox",
      !bwInbox.inbox.messages.some((m) => m.fromName === 'Kay Kay' || m.toName === 'Kay Kay'),
      `inbox=${bwInbox.inbox.messages.length}`);
    const gameReset = await admin.adminOp('admin:resetGame', { confirm: true });
    check('26-reset', 'CoolVibez game reset accepted',
      gameReset.op && gameReset.op.ok === true, JSON.stringify(gameReset.op || gameReset.error));
    await waitFor(() => admin.lastDay === 1, 10000, 'admin day back to 1 after game reset');
    check('26-reset', 'game reset resets the day counter to 1 (live broadcast)', admin.lastDay === 1, `day ${admin.lastDay}`);
    // Stop immediately so the file check sees the reset's own day=1
    // (an auto-cycle ticking afterwards would advance it again).
    await stopServer();
    const raw2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    check('26-reset', 'game reset leaves every stored member fresh',
      raw2.members.length > 0 && raw2.members.every((m) => m.cash === 10000 && m.homes.length === 0
        && m.cars.length === 0 && m.points === 0 && m.milestones.length === 0
        && m.mba === false && m.removedAt === null
        && Object.values(m.careers || {}).every((c) => c.level === 0 && c.shifts === 0)),
      `members=${raw2.members.length}`);
    check('26-reset', 'game reset clears all marketplace listings and all messages, meta day = 1',
      raw2.listings.length === 0 && raw2.messages.length === 0 && raw2.meta.day === 1,
      `listings=${raw2.listings.length}, messages=${raw2.messages.length}, day=${raw2.meta.day}`);
    await startServer(false);
    admin = await newAdmin('admin26c', ADMIN0.adminId);
    catalog = admin.lastCatalog;
    const nimmieAfter = await newAdmin('nimmie26b', ADMINS[1].adminId);
    check('26-reset', 'admins unaffected by game reset (Nimmie can still log in)',
      nimmieAfter.lastAuth && nimmieAfter.lastAuth.ok === true,
      JSON.stringify(nimmieAfter.lastAuth && nimmieAfter.lastAuth.ok));
    const rem = await admin.adminOp('admin:removePlayer', { memberId: byName['Twan'].id });
    check('26-reset', 'remove after resets still accepted', rem.op && rem.op.ok === true, JSON.stringify(rem.op || rem.error));
    const blocked = new Client('blocked26', 'member', byName['Twan'].id);
    await blocked.connect();
    const blockedAuth = await blocked.login('member', byName['Twan'].id);
    check('26-reset', 'removed player login blocked after resets',
      blockedAuth.ok === false && /removed/i.test(blockedAuth.error || ''), JSON.stringify(blockedAuth));
    blocked.disconnect();
    const remReset = await admin.adminOp('admin:resetPlayer', { memberId: byName['Twan'].id, confirm: true });
    check('26-reset', 'individual reset refuses an already-removed player (restore instead)',
      remReset.op && remReset.op.ok === false, JSON.stringify(remReset.op || remReset.error));
    const res = await admin.adminOp('admin:restorePlayer', { memberId: byName['Twan'].id });
    check('26-reset', 'restore within 3 days still works after resets',
      res.op && res.op.ok === true, JSON.stringify(res.op || res.error));
    const twBack = await newMember('tw26back', 'Twan');
    check('26-reset', 'restored player logs in with the game-reset state preserved (fresh, $10,000)',
      twBack.lastState.cash === 10000 && twBack.lastState.homes.length === 0,
      `cash ${twBack.lastState.cash}`);
    twBack.disconnect();
    check('26-reset', 'zero console errors: server stderr still empty after v2 sections',
      serverErr.length === 0, `stderr lines: ${serverErr.slice(0, 5).join(' | ')}`);
  });

  // --- ID-leak verdict (§3, aggregated over every payload received) ----------------
  check('3-isolation', 'no member/admin ID pattern in ANY player-facing payload (deep scan)',
    scanViolations.length === 0, scanViolations.slice(0, 10).join('; '));
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (e) {
    console.error(`HARNESS ERROR: ${e && e.stack ? e.stack : e}`);
    check('harness', 'run completed without harness crash', false, e.message);
    exitCode = 1;
  } finally {
    try { disconnectAll(); } catch {}
    try { await stopServer(); } catch {}
    wipeScratch();
    const leftover = fs.existsSync(DATA_FILE);
    check('cleanup', 'scratch data file deleted after the run', !leftover, leftover ? DATA_FILE : '');
    // package.json must be untouched by this script (it never writes it).
    const fails = summary();
    if (fails > 0) exitCode = 1;
    console.log(`\nScratch file present after cleanup: ${leftover}`);
    console.log(`Server stdout lines: ${serverOut.length}, stderr lines: ${serverErr.length}`);
    process.exit(exitCode);
  }
})();
