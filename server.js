// ============================================================================
// Bid or Bust — Join PulseVR live auction party game
// Real-time server: Express + Socket.IO. One Node process hosts many rooms.
// ============================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'bid-or-bust' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const INCREMENT = 50;                 // bids move in $50 steps
const ANTI_SNIPE_WINDOW_MS = 10000;   // bid inside last 10s ...
const ANTI_SNIPE_EXTEND_MS = 15000;   // ... extends the clock 15s
const MAX_EXTENSIONS = 3;

// ---------------------------------------------------------------------------
// The 15 lots: 10 prizes + 5 busts, shuffled fresh every game.
// ---------------------------------------------------------------------------
const PRIZES = [
  { key: 'meta5',    label: '$5 Meta Quest App',     detail: '$5 Meta Quest store app — winner picks the title!', value: 5 },
  { key: 'meta10',   label: '$10 Meta Quest App',    detail: '$10 Meta Quest store app — winner picks the title!', value: 10 },
  { key: 'vrcplus',  label: '$10 VRChat Plus',       detail: '$10 of VRChat Plus credit', value: 10 },
  { key: 'cash20',   label: '$20 Cash App',          detail: '$20 sent straight to Cash App', value: 20 },
  { key: 'cash5',    label: '$5 Cash App',           detail: '$5 sent straight to Cash App', value: 5 },
  { key: 'cash25',   label: '$25 Cash App',          detail: '$25 sent straight to Cash App', value: 25 },
  { key: 'vrchome',  label: 'VRChat Home Upgrade',   detail: 'A fresh VRChat Home makeover', value: 25 },
  { key: 'sub1',     label: '1 Month Join PulseVR',  detail: 'One month of PulseVR membership — on the house', value: 20 },
  { key: 'sub50',    label: '50% Off Join PulseVR',  detail: 'Half off one month of PulseVR membership', value: 10 },
  { key: 'spend100', label: '$100 PulseVR Spend',    detail: '+$100 virtual cash added to your balance!', value: 100, bonus: 100 },
];

const BUST_LOTS = [
  { key: 'nothing',  label: 'BUST: Nothing',    detail: 'The box is empty. Absolutely nothing.', bust: true },
  { key: 'nothing',  label: 'BUST: Nothing',    detail: 'The box is empty. Absolutely nothing.', bust: true },
  { key: 'lose50',   label: 'BUST: Lose $50',   detail: '-$50 ripped straight out of your balance!', bust: true, penalty: 50 },
  { key: 'lose50',   label: 'BUST: Lose $50',   detail: '-$50 ripped straight out of your balance!', bust: true, penalty: 50 },
  { key: 'lose100',  label: 'BUST: Lose $100',  detail: '-$100 ripped straight out of your balance!', bust: true, penalty: 100 },
];

function shuffledLots() {
  const lots = [
    ...PRIZES.map(p => ({ ...p, kind: 'prize' })),
    ...BUST_LOTS.map(b => ({ ...b, kind: 'bust', value: 0 })),
  ];
  for (let i = lots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [lots[i], lots[j]] = [lots[j], lots[i]];
  }
  return lots.map((l, i) => ({ ...l, id: i, revealed: false }));
}

function clampInt(v, min, max, fallback) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(settings) {
  const code = makeCode();
  const room = {
    code,
    hostToken: crypto.randomBytes(16).toString('hex'),
    hostSocketId: null,
    settings: {
      startCash: clampInt(settings && settings.startCash, 100, 5000, 500),
      bidSeconds: clampInt(settings && settings.bidSeconds, 10, 180, 120),
    },
    players: new Map(),   // playerId -> player
    phase: 'lobby',       // lobby | between | bidding | sealed | reveal | done
    lots: [],
    roundIndex: -1,
    sealedRound: -1,
    currentBid: 0,
    highBidderId: null,
    sealedBids: new Map(), // playerId -> { amount, at }
    endsAt: null,
    timer: null,
    extensions: 0,
    lastReveal: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, balance: p.balance, active: p.active, online: p.online,
    peekUsed: p.peekUsed,
    lotsWon: p.lotsWon, prizeValue: p.prizeValue,
    winnings: p.winnings.map(w => ({ label: w.label, value: w.value })),
  };
}

function publicState(room) {
  const players = [...room.players.values()].map(publicPlayer)
    .sort((a, b) => b.prizeValue - a.prizeValue || b.balance - a.balance);
  const highBidder = room.highBidderId && room.players.get(room.highBidderId);
  return {
    code: room.code,
    phase: room.phase,
    roundIndex: room.roundIndex,
    totalLots: room.lots.length,
    currentBid: room.currentBid,
    highBidderName: highBidder ? highBidder.name : null,
    endsAt: room.endsAt,
    isSealed: room.phase === 'sealed',
    sealedRound: room.sealedRound,
    players,
    playersIn: players.filter(p => p.active).length,
    playersOut: players.filter(p => !p.active).length,
    lastReveal: room.lastReveal,
    settings: { bidSeconds: room.settings.bidSeconds, startCash: room.settings.startCash },
  };
}

// Host sees everything: the actual contents of the current mystery lot.
function hostState(room) {
  const s = publicState(room);
  const lot = room.lots[room.roundIndex];
  s.hostView = {
    currentLot: lot ? { kind: lot.kind, label: lot.label, detail: lot.detail } : null,
    sealedRound: room.sealedRound,
    lots: room.lots.map(l => (l.revealed ? { kind: l.kind, label: l.label } : { kind: 'mystery' })),
    extensions: room.extensions,
  };
  return s;
}

function emitState(room) {
  io.to(room.code).emit('state', publicState(room));
  if (room.hostSocketId) io.to(room.hostSocketId).emit('hostState', hostState(room));
}

function scheduleClose(room) {
  if (room.timer) clearTimeout(room.timer);
  const ms = Math.max(0, room.endsAt - Date.now());
  room.timer = setTimeout(() => closeBidding(room), ms);
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
function startGame(room) {
  if (room.phase !== 'lobby') return { ok: false, error: 'Game already started.' };
  if (room.players.size === 0) return { ok: false, error: 'No players have joined yet.' };
  room.lots = shuffledLots();
  room.sealedRound = Math.floor(Math.random() * room.lots.length); // one secret "High Roller" round
  room.roundIndex = 0;
  room.phase = 'between';
  room.lastReveal = null;
  emitState(room);
  return { ok: true };
}

function openBidding(room) {
  if (room.phase !== 'between') return { ok: false, error: 'Not ready to open bidding.' };
  const active = [...room.players.values()].filter(p => p.active);
  if (active.length === 0) { // everybody busted out — game over
    room.phase = 'done';
    emitState(room);
    return { ok: true, gameOver: true };
  }
  room.currentBid = 0;
  room.highBidderId = null;
  room.sealedBids = new Map();
  room.extensions = 0;
  room.phase = (room.roundIndex === room.sealedRound) ? 'sealed' : 'bidding';
  room.endsAt = Date.now() + room.settings.bidSeconds * 1000;
  scheduleClose(room);
  emitState(room);
  return { ok: true };
}

function closeBidding(room) {
  if (room.phase !== 'bidding' && room.phase !== 'sealed') return;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }

  let winnerId = null;
  let paidBid = 0;
  if (room.phase === 'sealed') {
    let best = 0, bestAt = Infinity;
    for (const [pid, entry] of room.sealedBids) {
      if (entry.amount > best || (entry.amount === best && entry.at < bestAt)) {
        best = entry.amount; bestAt = entry.at; winnerId = pid;
      }
    }
    paidBid = best;
    if (best <= 0) winnerId = null;
  } else {
    winnerId = room.highBidderId;
    paidBid = room.currentBid;
  }

  const lot = room.lots[room.roundIndex];
  const eliminated = [];
  let winnerName = null, newBalance = null;

  if (winnerId) {
    const w = room.players.get(winnerId);
    if (w && w.active) {
      w.balance -= paidBid;                    // pay the winning bid ...
      if (lot.bonus) w.balance += lot.bonus;   // ... $100 spend lot tops you back up
      if (lot.penalty) w.balance -= lot.penalty; // ... bust lots sting extra
      if (!lot.bust) {
        w.winnings.push({ label: lot.label, detail: lot.detail, value: lot.value || 0 });
        w.lotsWon += 1;
        w.prizeValue += (lot.value || 0);
      }
      if (w.balance <= 0) {                    // broke = out
        w.balance = 0;
        w.active = false;
        eliminated.push(w.name);
      }
      winnerName = w.name;
      newBalance = w.balance;
    } else {
      winnerId = null; // winner left / went inactive mid-round; lot burns
    }
  }

  lot.revealed = true;
  room.lastReveal = {
    roundIndex: room.roundIndex,
    kind: lot.kind,
    label: lot.label,
    detail: lot.detail,
    bust: !!lot.bust,
    penalty: lot.penalty || 0,
    bonus: lot.bonus || 0,
    winnerName, bid: paidBid, newBalance, eliminated,
    noBids: !winnerId,
  };
  room.phase = 'reveal';
  room.currentBid = 0;
  room.highBidderId = null;
  room.sealedBids = new Map();
  room.endsAt = null;
  emitState(room);
  io.to(room.code).emit('reveal', room.lastReveal);
}

function nextLot(room) {
  if (room.phase !== 'reveal') return { ok: false, error: 'Finish the reveal first.' };
  if (room.roundIndex + 1 >= room.lots.length) {
    room.phase = 'done';
  } else {
    room.roundIndex += 1;
    room.phase = 'between';
  }
  room.lastReveal = null;
  emitState(room);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Socket protocol
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ---- host ----
  socket.on('host:create', ({ settings } = {}, cb) => {
    const room = newRoom(settings);
    room.hostSocketId = socket.id;
    socket.hostRef = { code: room.code };
    socket.join(room.code);
    emitState(room);
    if (cb) cb({ ok: true, code: room.code, hostToken: room.hostToken });
  });

  socket.on('host:claim', ({ code, hostToken } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room || room.hostToken !== hostToken) {
      if (cb) cb({ ok: false, error: 'Could not reclaim the host session.' });
      return;
    }
    room.hostSocketId = socket.id;
    socket.hostRef = { code: room.code };
    socket.join(room.code);
    emitState(room);
    if (cb) cb({ ok: true });
  });

  const requireHost = (cb) => {
    const ref = socket.hostRef;
    const room = ref && rooms.get(ref.code);
    if (!room) { if (cb) cb({ ok: false, error: 'Host session lost.' }); return null; }
    return room;
  };

  socket.on('host:startGame', (_data, cb) => {
    const room = requireHost(cb); if (!room) return;
    if (cb) cb(startGame(room));
  });

  socket.on('host:openBidding', (_data, cb) => {
    const room = requireHost(cb); if (!room) return;
    if (cb) cb(openBidding(room));
  });

  socket.on('host:closeBidding', (_data, cb) => {
    const room = requireHost(cb); if (!room) return;
    closeBidding(room);
    if (cb) cb({ ok: true });
  });

  socket.on('host:nextLot', (_data, cb) => {
    const room = requireHost(cb); if (!room) return;
    if (cb) cb(nextLot(room));
  });

  // ---- players ----
  socket.on('player:join', ({ code, name, playerId } = {}, cb) => {
    const done = (r) => { if (cb) cb(r); };
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return done({ ok: false, error: 'Room not found. Check the code.' });
    name = String(name || '').trim().slice(0, 24);
    if (!name) return done({ ok: false, error: 'Enter your display name.' });

    let p = playerId && room.players.get(playerId);
    if (p) { // rejoin (phone refresh / dropped connection)
      p.online = true;
      p.socketId = socket.id;
      if (name) p.name = name;
    } else {
      if (room.phase !== 'lobby') return done({ ok: false, error: 'This game already started — catch the next one!' });
      if (room.players.size >= MAX_PLAYERS) return done({ ok: false, error: 'Room is full (50 players).' });
      const taken = [...room.players.values()].some(q => q.name.toLowerCase() === name.toLowerCase());
      if (taken) return done({ ok: false, error: 'That name is taken — pick another.' });
      const id = crypto.randomUUID();
      p = {
        id, name, balance: room.settings.startCash,
        active: true, online: true, socketId: socket.id,
        winnings: [], peekUsed: false, lotsWon: 0, prizeValue: 0,
        joinedAt: Date.now(),
      };
      room.players.set(id, p);
    }
    socket.playerRef = { code, playerId: p.id };
    socket.join(code);
    emitState(room);
    done({ ok: true, playerId: p.id });
  });

  const requirePlayer = (cb) => {
    const ref = socket.playerRef;
    const room = ref && rooms.get(ref.code);
    const p = room && room.players.get(ref.playerId);
    if (!room || !p) { if (cb) cb({ ok: false, error: 'You are not in this room.' }); return null; }
    return { room, p };
  };

  socket.on('player:bid', ({ amount } = {}, cb) => {
    const ctx = requirePlayer(cb); if (!ctx) return;
    const { room, p } = ctx;
    const fail = (error) => cb({ ok: false, error });
    if (room.phase !== 'bidding') return fail('Bidding is not open right now.');
    if (!p.active) return fail('You are out of the game.');
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount % INCREMENT !== 0)
      return fail('Bids must be in $50 increments.');
    const minBid = room.currentBid + INCREMENT;
    if (amount < minBid) return fail(`Minimum bid is $${minBid}.`);
    if (amount > p.balance) return fail("That bid is more than your balance.");
    if (room.highBidderId === p.id) return fail('You already hold the high bid.');
    room.currentBid = amount;
    room.highBidderId = p.id;
    // anti-snipe: late bids extend the clock
    if (room.endsAt - Date.now() < ANTI_SNIPE_WINDOW_MS && room.extensions < MAX_EXTENSIONS) {
      room.endsAt += ANTI_SNIPE_EXTEND_MS;
      room.extensions += 1;
      scheduleClose(room);
    }
    emitState(room);
    cb({ ok: true });
  });

  socket.on('player:sealedBid', ({ amount } = {}, cb) => {
    const ctx = requirePlayer(cb); if (!ctx) return;
    const { room, p } = ctx;
    const fail = (error) => cb({ ok: false, error });
    if (room.phase !== 'sealed') return fail('This is not the sealed round.');
    if (!p.active) return fail('You are out of the game.');
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount % INCREMENT !== 0)
      return fail('Bids must be in $50 increments.');
    if (amount > p.balance) return fail("That bid is more than your balance.");
    room.sealedBids.set(p.id, { amount, at: Date.now() }); // re-submits overwrite
    emitState(room);
    cb({ ok: true });
  });

  // Peek token: once per game, privately learn whether the lot is a prize or a bust.
  socket.on('player:peek', (_data, cb) => {
    const ctx = requirePlayer(cb); if (!ctx) return;
    const { room, p } = ctx;
    const fail = (error) => cb({ ok: false, error });
    if (room.phase !== 'bidding' && room.phase !== 'sealed') return fail('Peek only works while bidding is open.');
    if (!p.active) return fail('You are out of the game.');
    if (p.peekUsed) return fail('You already used your peek.');
    p.peekUsed = true;
    const lot = room.lots[room.roundIndex];
    emitState(room);
    cb({ ok: true, isPrize: lot.kind === 'prize' });
  });

  // ---- spectators (broadcast view) ----
  socket.on('spectate', ({ code } = {}, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { if (cb) cb({ ok: false, error: 'Room not found.' }); return; }
    socket.join(code);
    if (cb) cb({ ok: true });
    socket.emit('state', publicState(room));
  });

  socket.on('disconnect', () => {
    const ref = socket.playerRef;
    if (ref) {
      const room = rooms.get(ref.code);
      const p = room && room.players.get(ref.playerId);
      if (p) { p.online = false; emitState(room); }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bid or Bust live on port ${PORT}`);
});
