// ============================================================================
// PulseVR Life — pure game logic (CONTRACT §4, §6, §9; v2 rules)
// No I/O here: the server owns persistence and broadcasting. These helpers
// take plain player/catalog objects and return plain results.
// ============================================================================

const {
  getCareer, LIFE_EVENTS, pawnColor, CAREERS,
  BOARD_TILES, BOARD_STEP, TILE_REWARDS, UTILITY_RATE,
} = require('./catalog');

const START_CASH = 10000;

// Per-ladder progress, built from the catalog so new ladders are picked up
// automatically (v2 added 4 ladders; old records missing keys fall back to
// { level: 0, shifts: 0 } wherever they are read).
function freshCareerProgress() {
  const out = {};
  for (const c of CAREERS) out[c.id] = { level: 0, shifts: 0 };
  return out;
}

function newPlayer({ name, tier, memberId }) {
  return {
    memberId,
    name,
    tier,
    cash: START_CASH,
    homes: [], // { instanceId, homeId, name, value, purchasePrice, listedPrice, listingId }
    cars: [],  // { carId, name, price, exclusive? }
    career: null,
    careers: freshCareerProgress(),
    mba: false,
    points: 0,
    playSeconds: 0,
    milestones: [],
    removedAt: null,
    token: null,
    firstLoginAt: null,
    // --- v2 fields ---------------------------------------------------------
    active: false,        // false until the player's first login (see §4 v2)
    shiftHistory: [],     // epoch-ms timestamps of work shifts (cap window)
    claimedTiles: [],     // reward-tile indices already granted (once-only)
    nextUtilityDay: null, // absolute day number of the next utility charge
  };
}

// Fresh reset for a restore after > 3 days (CONTRACT §9) and for admin
// resets (v2): same as a new player, but the identity (name/tier/memberId)
// is kept. The spread of `fresh` clears every v2 field too.
function resetPlayer(player) {
  const fresh = newPlayer({ name: player.name, tier: player.tier, memberId: player.memberId });
  fresh.token = null;
  return { ...player, ...fresh, memberId: player.memberId, name: player.name, tier: player.tier };
}

function netWorthOf(player) {
  const homes = (player.homes || []).reduce((s, h) => s + (h.value || 0), 0);
  const cars = (player.cars || []).reduce((s, c) => s + (c.price || 0), 0);
  return (player.cash || 0) + homes + cars;
}

// v2 board: 40 tiles, one tile per $10,000 of net worth, crown at tile 39.
function boardPositionOf(player) {
  return Math.min(BOARD_TILES - 1, Math.floor(netWorthOf(player) / BOARD_STEP));
}

function currentLevel(player) {
  if (!player.career) return null;
  const career = getCareer(player.career);
  if (!career) return null;
  const prog = (player.careers || {})[player.career] || { level: 0, shifts: 0 };
  return { career, levelIndex: prog.level, shifts: prog.shifts, level: career.levels[prog.level] };
}

// --- v2: shift-cap window -----------------------------------------------------
// Keep only shifts strictly inside (nowMs - windowMs, nowMs]. A shift
// exactly windowMs old has expired and no longer counts.
function pruneShiftHistory(history, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  return (history || []).filter((t) => typeof t === 'number' && t > cutoff);
}

// --- v2: activity classification (boot migration) -----------------------------
// A player counts as active if they have ANY trace of play: playtime,
// shifts on any ladder, owned homes/cars, or any milestone. Zero across
// all of those means they never played.
function hasActivity(player) {
  if ((player.playSeconds || 0) > 0) return true;
  const careers = player.careers || {};
  if (Object.values(careers).some((c) => (c && c.shifts > 0) || (c && c.level > 0))) return true;
  if ((player.homes || []).length > 0) return true;
  if ((player.cars || []).length > 0) return true;
  if ((player.milestones || []).length > 0) return true;
  return false;
}

// --- v2: utilities ------------------------------------------------------------
// Sum of per-home fees at UTILITY_RATE of current value, rounded per home.
function utilityChargeFor(player) {
  return (player.homes || []).reduce((s, h) => s + Math.round(UTILITY_RATE * (h.value || 0)), 0);
}

// --- v2: tile rewards ----------------------------------------------------------
// Grant every unclaimed reward tile at or below the player's current board
// position. Rewards are once-only: claimed tiles are recorded before
// granting, and re-climbing after a net-worth dip never re-grants.
// Returns the list of granted rewards (for toasts).
function applyTileRewards(player) {
  const pos = boardPositionOf(player);
  const claimed = new Set(player.claimedTiles || []);
  const granted = [];
  for (const reward of TILE_REWARDS) {
    if (reward.tile > pos || claimed.has(reward.tile)) continue;
    claimed.add(reward.tile);
    if (reward.kind === 'car') {
      // Exclusive car: never grant twice, even if the record is odd.
      if (!(player.cars || []).some((c) => c.carId === reward.carId)) {
        player.cars = [...(player.cars || []), {
          carId: reward.carId, name: reward.name, price: reward.price, exclusive: true,
        }];
      }
      granted.push({ ...reward });
    } else {
      player.cash = (player.cash || 0) + reward.amount;
      granted.push({ ...reward });
    }
  }
  player.claimedTiles = [...claimed];
  return granted;
}

// Public player payload — sent ONLY to that player's own sockets.
// CONTRACT §6 + amendment: each owned home carries `listingId` (the
// marketplace listing id when listed, otherwise null) so the client can
// unlist via player:unlistHome { listingId }. `rent` reflects the CURRENT
// catalog rent for the home type (admin rent edits apply from next cycle).
// v2 additions: `wallet` (one-snapshot quickview), `claimedTiles`, and the
// next utility charge/day.
function publicPlayer(player, catalog, day) {
  const cur = currentLevel(player);
  const homeRent = new Map((catalog.homes || []).map((h) => [h.id, h.rent]));
  const homes = (player.homes || []).map((h) => ({
    instanceId: h.instanceId,
    homeId: h.homeId,
    name: h.name,
    value: h.value,
    purchasePrice: h.purchasePrice,
    rent: homeRent.has(h.homeId) ? homeRent.get(h.homeId) : h.rent,
    listedPrice: h.listedPrice || null,
    listingId: h.listingId || null,
  }));
  const cars = (player.cars || []).map((c) => ({
    carId: c.carId, name: c.name, price: c.price, exclusive: !!c.exclusive,
  }));
  const nextUtilityCharge = homes.length ? utilityChargeFor(player) : 0;
  const wallet = {
    cash: player.cash,
    netWorth: netWorthOf(player),
    homes: homes.map((h) => ({ instanceId: h.instanceId, name: h.name, value: h.value, rent: h.rent })),
    cars: cars.map((c) => ({ carId: c.carId, name: c.name, price: c.price, exclusive: c.exclusive })),
    nextUtilityCharge,
    nextUtilityDay: homes.length ? (player.nextUtilityDay ?? null) : null,
  };
  return {
    name: player.name,
    tier: player.tier,
    memberId: player.memberId, // owner only — never sent to anyone else
    cash: player.cash,
    netWorth: netWorthOf(player),
    career: player.career,
    careerLevel: cur ? cur.levelIndex : null,
    careerTitle: cur ? cur.level.title : null,
    mba: !!player.mba,
    shiftsAtLevel: cur ? cur.shifts : 0,
    careers: player.careers || freshCareerProgress(),
    homes,
    cars,
    points: player.points || 0,
    playSeconds: player.playSeconds || 0,
    boardPosition: boardPositionOf(player),
    milestones: [...(player.milestones || [])],
    day,
    active: player.active !== false,
    claimedTiles: [...(player.claimedTiles || [])],
    shiftHistory: [...(player.shiftHistory || [])],
    nextUtilityCharge,
    nextUtilityDay: player.nextUtilityDay ?? null,
    wallet,
  };
}

function isActive(player) { return !player.removedAt; }
// v2: "playing" = not removed AND activated (first login happened).
// Rows without the v2 `active` field (pre-v2 records the boot migration
// somehow missed) default to playing, so nothing is silently frozen.
function isPlaying(player) { return isActive(player) && player.active !== false; }

// Leaderboard — NO IDs, ever (CONTRACT §6). Inactive members appear at
// $10,000 with no assets (the migration + day-cycle skip guarantee that).
function buildLeaderboard(players) {
  const active = players.filter(isActive).slice()
    .sort((a, b) => netWorthOf(b) - netWorthOf(a) || String(a.name).localeCompare(String(b.name)));
  return active.map((p, i) => ({
    rank: i + 1,
    name: p.name,
    tier: p.tier,
    netWorth: netWorthOf(p),
    cash: p.cash,
    homes: (p.homes || []).length,
    cars: (p.cars || []).length,
    points: p.points || 0,
    pawnColor: pawnColor(p.name),
    boardPosition: boardPositionOf(p),
    crown: i === 0,
  }));
}

// Marketplace listings as clients see them: seller NAME only, never an ID.
function publicListings(listings) {
  return (listings || []).map((l) => ({
    id: l.id,
    homeId: l.homeId,
    homeName: l.homeName,
    price: l.price,
    sellerName: l.sellerName,
    value: l.value,
  }));
}

// Unlock any milestones the player newly qualifies for. Returns the list
// of newly unlocked ids (each worth +25 pts, toast on first unlock).
// `isTop1` is supplied by the caller (leaderboard rank), never inferred here.
function checkMilestones(player, { isTop1 = false } = {}) {
  const have = new Set(player.milestones || []);
  const unlocked = [];
  const grant = (id) => { if (!have.has(id)) { have.add(id); unlocked.push(id); } };
  const nw = netWorthOf(player);
  if (nw >= 50000) grant('rich-50k');
  if (nw >= 100000) grant('rich-100k');
  if (isTop1) grant('top1');
  if (unlocked.length) {
    player.milestones = [...have];
    player.points = (player.points || 0) + 25 * unlocked.length;
  }
  return unlocked;
}

// One day cycle (CONTRACT §4, v2 rules): for every PLAYING player
// (non-removed AND activated), unlisted homes pay rent at the CURRENT
// catalog rent, every owned home appreciates at the CURRENT catalog
// appreciation, homes are charged utilities when their utility day arrives
// (cash floored at $0, no debt), then a 30% life-event roll per player.
// Inactive players are skipped ENTIRELY: no rent, no appreciation, no
// life events, no utility charges, no milestone checks.
// `opts.day` is the day number the cycle advances TO; `opts.utilityIntervalDays`
// is the utility period (default 30).
// Returns [{ player, rentEarned, utilityCharged, events: [{title,text,delta}] }].
// The caller persists every returned player before broadcasting.
function applyDayCycle(players, catalog, opts = {}) {
  const rentById = new Map((catalog.homes || []).map((h) => [h.id, h.rent]));
  const apprById = new Map((catalog.homes || []).map((h) => [h.id, h.appreciation]));
  const day = opts.day;
  const interval = opts.utilityIntervalDays || 30;
  const results = [];
  for (const player of players.filter(isPlaying)) {
    let rentEarned = 0;
    for (const home of player.homes || []) {
      const rent = rentById.has(home.homeId) ? rentById.get(home.homeId) : (home.rent || 0);
      const appr = apprById.has(home.homeId) ? apprById.get(home.homeId) : 0;
      if (!home.listingId) rentEarned += rent;
      home.value = Math.round((home.value || 0) * (1 + (appr || 0) / 100));
      home.rent = rent;
    }
    player.cash = (player.cash || 0) + rentEarned;
    // Utilities: charged once when the player's utility day arrives, then
    // the next due day moves forward one full interval. Floored at $0.
    let utilityCharged = 0;
    if ((player.homes || []).length > 0 && typeof day === 'number'
      && player.nextUtilityDay != null && player.nextUtilityDay <= day) {
      utilityCharged = utilityChargeFor(player);
      player.cash = Math.max(0, (player.cash || 0) - utilityCharged);
      player.nextUtilityDay = day + interval;
    }
    const events = [];
    if (Math.random() < 0.30) {
      const ev = LIFE_EVENTS[Math.floor(Math.random() * LIFE_EVENTS.length)];
      player.cash = Math.max(0, player.cash + ev.delta);
      events.push({ title: ev.title, text: ev.text, delta: ev.delta });
    }
    results.push({ player, rentEarned, utilityCharged, events });
  }
  return results;
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pointsCsv(players) {
  const rows = [['name', 'memberId', 'tier', 'points', 'playSeconds', 'netWorth']];
  for (const p of players.filter(isActive)) {
    rows.push([p.name, p.memberId, p.tier, p.points || 0, p.playSeconds || 0, netWorthOf(p)]);
  }
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

function standingsCsv(players) {
  const rows = [['rank', 'name', 'memberId', 'tier', 'netWorth', 'homes', 'cars', 'points']];
  const sorted = players.filter(isActive).slice()
    .sort((a, b) => netWorthOf(b) - netWorthOf(a));
  sorted.forEach((p, i) => {
    rows.push([i + 1, p.name, p.memberId, p.tier, netWorthOf(p), (p.homes || []).length, (p.cars || []).length, p.points || 0]);
  });
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

// Removed-player ledger rows for admins (CONTRACT §9).
function removedRows(players, nowMs) {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  return players.filter((p) => p.removedAt).map((p) => {
    const removedMs = Date.parse(p.removedAt);
    const deadlineMs = removedMs + THREE_DAYS_MS;
    const daysLeft = Math.max(0, Math.ceil((deadlineMs - nowMs) / (24 * 60 * 60 * 1000)));
    return {
      memberId: p.memberId,
      name: p.name,
      removedAt: p.removedAt,
      restoreDeadline: new Date(deadlineMs).toISOString(),
      daysLeft,
    };
  });
}

// --- v2: private messaging ------------------------------------------------------
// Messages are stored server-side and NEVER sent with member IDs attached:
// clients only ever see names. Only the sender and the recipient may read
// a message; admins have no mail access at all (no admin mail event exists).
function stripMessage(m) {
  return {
    id: m.id,
    fromName: m.fromName,
    toName: m.toName,
    subject: m.subject,
    body: m.body,
    createdAt: m.createdAt,
    read: !!m.read,
  };
}
function publicInbox(messages, memberId) {
  return (messages || [])
    .filter((m) => m.fromMemberId === memberId || m.toMemberId === memberId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(stripMessage);
}
function unreadCount(messages, memberId) {
  return (messages || []).filter((m) => m.toMemberId === memberId && !m.read).length;
}

module.exports = {
  START_CASH, freshCareerProgress, newPlayer, resetPlayer,
  netWorthOf, boardPositionOf, currentLevel,
  pruneShiftHistory, hasActivity, utilityChargeFor, applyTileRewards,
  publicPlayer, isActive, isPlaying, buildLeaderboard, publicListings,
  checkMilestones, applyDayCycle, pointsCsv, standingsCsv, removedRows,
  stripMessage, publicInbox, unreadCount,
};
