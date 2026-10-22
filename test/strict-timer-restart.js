// Targeted checks for the Oct 22 rule changes:
//  1. Strict timer: a bid in the last seconds does NOT extend the clock.
//  2. Host restart mid-game: same room, players kept, fresh lobby, old timer dead.
// Spawns its own server on PORT 3101, then shuts it down.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3101;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill(); } catch {} };
  process.on('exit', cleanup);

  const host = io(URL);
  await Promise.race([
    new Promise((r) => host.on('connect', r)),
    sleep(15000).then(() => { throw new Error('server did not start'); }),
  ]);
  let hostState = null;
  host.on('hostState', (s) => { hostState = s; });

  const created = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10 } });
  check('room created (10s timer)', created.ok, created.code);
  const code = created.code;

  const players = [];
  for (let i = 0; i < 2; i++) {
    const s = io(URL);
    await new Promise((r) => s.on('connect', r));
    const r = await ack(s, 'player:join', { code, name: 'T' + i });
    check('player joined: T' + i, r.ok);
    players.push(s);
  }

  await ack(host, 'host:startGame', {});
  await sleep(300);

  // Open a NON-sealed round for the timer test (only one round per game is sealed).
  let opened = false;
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    await ack(host, 'host:openBidding', {});
    await sleep(300);
    if (hostState.isSealed) {
      await ack(host, 'host:closeBidding', {});
      await sleep(300);
      await ack(host, 'host:nextLot', {});
      await sleep(300);
    } else {
      opened = true;
    }
  }
  check('open (non-sealed) round for timer test', opened && hostState.phase === 'bidding', hostState && hostState.phase);
  const endsAtBefore = hostState.endsAt;

  // Bid with ~1.5s left on the clock — the old anti-snipe rule would add 15s here.
  await sleep(8500);
  const bid = await ack(players[0], 'player:bid', { amount: 50 });
  check('last-second bid accepted', bid.ok, bid.error || '');
  await sleep(300);
  check('timer NOT extended by last-second bid', hostState.endsAt === endsAtBefore,
    `endsAt ${hostState.endsAt} vs ${endsAtBefore}`);

  // Wait past the original deadline (+margin) — the lot must close on time.
  await sleep(2000);
  check('lot closed on the original schedule (no extra 15s)',
    hostState.phase === 'reveal', hostState.phase);

  // --- mid-game restart ---
  await ack(host, 'host:nextLot', {});
  await sleep(300);
  await ack(host, 'host:openBidding', {});
  await sleep(300);
  check('round 2 opened (bidding or sealed)', ['bidding', 'sealed'].includes(hostState.phase), hostState.phase);
  await sleep(3000); // restart 3s into the round, well before the 10s deadline
  const rs = await ack(host, 'host:restart', {});
  await sleep(300);
  check('mid-game restart ok', rs.ok && hostState.phase === 'lobby', hostState && hostState.phase);
  check('restart kept both players', hostState.players.length === 2);
  check('restart reset balances', hostState.players.every((p) => p.balance === 500 && p.active));
  // The old round timer must be dead: wait past its original deadline.
  await sleep(9000);
  check('old timer dead after restart (still lobby, no stray reveal)',
    hostState.phase === 'lobby' && !hostState.lastReveal, hostState.phase);
  const again = await ack(host, 'host:startGame', {});
  await sleep(300);
  check('game starts again after mid-game restart', again.ok && hostState.phase === 'between', hostState && hostState.phase);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
