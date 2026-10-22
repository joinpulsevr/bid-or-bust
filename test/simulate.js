// Full-game simulation test: host + 6 players play all 15 lots.
// Run with the server up:  PORT=3000 node server.js  (one terminal)
//                          npm test                  (another)
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}

(async () => {
  const host = io(URL);
  await new Promise((r) => host.on('connect', r));
  let hostState = null;
  host.on('hostState', (s) => { hostState = s; });

  const created = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 20 } });
  check('room created', created.ok && !!created.code, created.code);
  const code = created.code;

  const players = [];
  for (let i = 0; i < 6; i++) {
    const s = io(URL);
    await new Promise((r) => s.on('connect', r));
    const name = 'Player' + i;
    const r = await ack(s, 'player:join', { code, name });
    check('player joined: ' + name, r.ok, r.error || '');
    players.push({ sock: s, name, playerId: r.playerId });
  }

  const dup = io(URL);
  await new Promise((r) => dup.on('connect', r));
  const dupRes = await ack(dup, 'player:join', { code, name: 'Player0' });
  check('duplicate name rejected', !dupRes.ok, dupRes.error || '');

  await sleep(300);
  const started = await ack(host, 'host:startGame', {});
  check('game started', started.ok && hostState.phase === 'between', hostState && hostState.phase);
  check('15 lots shuffled', hostState.totalLots === 15, String(hostState.totalLots));
  check('sealed High Roller round assigned', hostState.hostView.sealedRound >= 0 && hostState.hostView.sealedRound < 15,
    'lot ' + (hostState.hostView.sealedRound + 1));

  const earlyBid = await ack(players[0].sock, 'player:bid', { amount: 50 });
  check('bid rejected before bidding opens', !earlyBid.ok);

  let peekOnce = false, peekTwiceRejected = false, peekDone = false;
  let endedEarly = false;
  let totalPaid = 0, totalPenalty = 0, totalBonus = 0, clampOverflow = 0;
  let sealedRoundsSeen = 0;

  const balOf = (name) => {
    const p = hostState.players.find((q) => q.name === name);
    return p ? p.balance : null;
  };

  for (let round = 0; round < 15; round++) {
    const opened = await ack(host, 'host:openBidding', {});
    if (!opened.ok) { check('open bidding round ' + (round + 1), false, opened.error); break; }
    if (opened.gameOver) { endedEarly = true; break; } // everybody busted out: game over
    await sleep(250);
    const sealed = hostState.isSealed;
    if (sealed) sealedRoundsSeen++;
    const before = {};
    hostState.players.forEach((p) => { before[p.name] = p.balance; });
    const active = players.filter((pl) => {
      const p = hostState.players.find((q) => q.name === pl.name);
      return p && p.active;
    });

    if (sealed) {
      for (const pl of active) {
        const amt = Math.min(balOf(pl.name), 50 + 50 * Math.floor(Math.random() * 4));
        if (amt >= 50) await ack(pl.sock, 'player:sealedBid', { amount: amt });
      }
    } else {
      const bad = await ack(active[0].sock, 'player:bid', { amount: 75 });
      check(`round ${round + 1}: non-$50 bid rejected`, !bad.ok);
      if (!peekDone) {
        peekDone = true;
        const pk = await ack(active[0].sock, 'player:peek', {});
        peekOnce = pk.ok && typeof pk.isPrize === 'boolean';
        const pk2 = await ack(active[0].sock, 'player:peek', {});
        peekTwiceRejected = !pk2.ok;
      }
      for (const pl of active) { // escalating open bids
        const next = hostState.currentBid + 50;
        if (balOf(pl.name) >= next && hostState.highBidderName !== pl.name) {
          await ack(pl.sock, 'player:bid', { amount: next });
        }
        await sleep(40);
      }
      for (const pl of [...active].reverse()) { // some raises
        if (Math.random() < 0.5) {
          const next = hostState.currentBid + 50;
          if (balOf(pl.name) >= next && hostState.highBidderName !== pl.name) {
            await ack(pl.sock, 'player:bid', { amount: next });
          }
          await sleep(30);
        }
      }
    }

    await sleep(200);
    await ack(host, 'host:closeBidding', {});
    await sleep(300);
    const rv = hostState.lastReveal;
    check(`round ${round + 1}: revealed (${rv && rv.label})`, !!rv && rv.roundIndex === round);
    if (rv && !rv.noBids) {
      totalPaid += rv.bid;
      totalPenalty += rv.penalty || 0;
      totalBonus += rv.bonus || 0;
      const raw = before[rv.winnerName] - rv.bid + (rv.bonus || 0) - (rv.penalty || 0);
      clampOverflow += Math.max(0, -raw);
      const w = hostState.players.find((p) => p.name === rv.winnerName);
      check(`round ${round + 1}: winner balance math`, w.balance === Math.max(0, raw),
        `${rv.winnerName}: ${w.balance} vs ${Math.max(0, raw)}`);
    }
    if (round < 14) {
      const nx = await ack(host, 'host:nextLot', {});
      if (!nx.ok) { check('next lot after round ' + (round + 1), false, nx.error); break; }
      await sleep(200);
    }
  }

  if (endedEarly) {
    check('game ended early by elimination', hostState.players.every((p) => !p.active));
    check('at most one sealed round played', sealedRoundsSeen <= 1, String(sealedRoundsSeen));
  } else {
    check('exactly one sealed round played', sealedRoundsSeen === 1, String(sealedRoundsSeen));
  }
  check('peek reveals prize/bust once', peekOnce);
  check('second peek rejected', peekTwiceRejected);

  await ack(host, 'host:nextLot', {});
  await sleep(300);
  check('game reached DONE', hostState.phase === 'done', hostState.phase);
  if (!endedEarly) check('all 15 lots revealed', hostState.hostView.lots.every((l) => l.kind !== 'mystery'));
  check('balances sane (>=0, $50 steps)',
    hostState.players.every((p) => p.balance >= 0 && p.balance % 50 === 0));
  check('busted-out players sit at $0',
    hostState.players.filter((p) => !p.active).every((p) => p.balance === 0));

  const totalBal = hostState.players.reduce((a, p) => a + p.balance, 0);
  const expectedTotal = 6 * 500 - totalPaid - totalPenalty + totalBonus + clampOverflow;
  check('money conserved across game', totalBal === expectedTotal, `${totalBal} vs ${expectedTotal}`);

  const std = hostState.players;
  const sorted = std.every((p, i) => i === 0 ||
    std[i - 1].prizeValue > p.prizeValue ||
    (std[i - 1].prizeValue === p.prizeValue && std[i - 1].balance >= p.balance));
  check('standings sorted by prize value', sorted);

  // Host restart: available after the game, resets to a fresh lobby.
  await sleep(300);
  const rs = await ack(host, 'host:restart', {});
  await sleep(300);
  check('host can restart after game over', rs.ok && hostState.phase === 'lobby', hostState && hostState.phase);
  check('restart resets balances to start cash',
    hostState.players.every((p) => p.balance === 500 && p.active && p.prizeValue === 0));
  check('restart keeps all players in the room', hostState.players.length === 6);
  const again = await ack(host, 'host:startGame', {});
  await sleep(300);
  check('game can start again after restart', again.ok && hostState.phase === 'between', hostState && hostState.phase);

  const passed = results.filter((r) => r.ok).length;  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
