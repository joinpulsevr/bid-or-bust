// Targeted checks for host remove-player + player leave (Oct 22):
//  host can kick anyone anytime (seat + name freed, high bid resets),
//  players can leave on their own, and removed mid-game players cannot
//  rejoin that game. Spawns its own server on PORT 3103, then shuts it down.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3103;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}

async function joinPlayer(code, name) {
  const s = io(URL);
  await new Promise((r) => s.on('connect', r));
  const removed = { got: false, by: null };
  s.on('removed', (d) => { removed.got = true; removed.by = d && d.by; });
  const r = await ack(s, 'player:join', { code, name });
  return { sock: s, playerId: r.playerId, ok: r.ok, removed };
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
  check('room created', created.ok, created.code);
  const code = created.code;

  const A = await joinPlayer(code, 'Alice');
  const B = await joinPlayer(code, 'Bob');
  const C = await joinPlayer(code, 'Carol');
  check('three players joined', A.ok && B.ok && C.ok);

  await ack(host, 'host:startGame', {});
  await sleep(300);
  // Open a NON-sealed round (only one round per game is sealed).
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
  check('open round for removal test', opened && hostState.phase === 'bidding', hostState && hostState.phase);

  const bidA = await ack(A.sock, 'player:bid', { amount: 50 });
  await sleep(300);
  check('Alice holds the high bid', bidA.ok && hostState.currentBid === 50 && hostState.highBidderName === 'Alice',
    `${hostState.currentBid} / ${hostState.highBidderName}`);

  // Host removes Bob (not the high bidder).
  const rmB = await ack(host, 'host:removePlayer', { playerId: B.playerId });
  await sleep(300);
  check('host removed Bob', rmB.ok && rmB.name === 'Bob', rmB.error || '');
  check('Bob got the removed notice', B.removed.got && B.removed.by === 'host', String(B.removed.by));
  check('Bob is gone from the player list', !hostState.players.some((p) => p.name === 'Bob'));
  const bidAfter = await ack(B.sock, 'player:bid', { amount: 50 });
  check('removed player cannot bid anymore', !bidAfter.ok, bidAfter.error || '');

  // Host removes Alice, the high bidder: the lot's bidding restarts.
  const rmA = await ack(host, 'host:removePlayer', { playerId: A.playerId });
  await sleep(300);
  check('host removed Alice', rmA.ok);
  check('high bid reset when high bidder removed',
    hostState.currentBid === 0 && hostState.highBidderName === null,
    `${hostState.currentBid} / ${hostState.highBidderName}`);

  // A removed mid-game player cannot rejoin that game, even with a fresh socket.
  const rejoin = io(URL);
  await new Promise((r) => rejoin.on('connect', r));
  const rejoinRes = await ack(rejoin, 'player:join', { code, name: 'Alice' });
  check('removed player cannot rejoin mid-game', !rejoinRes.ok, rejoinRes.error || '');

  // Carol leaves voluntarily.
  const leave = await ack(C.sock, 'player:leave', {});
  await sleep(300);
  check('Carol left voluntarily', leave.ok && leave.name === 'Carol', leave.error || '');
  check('Carol got the removed notice', C.removed.got && C.removed.by === 'you', String(C.removed.by));
  check('Carol is gone from the player list', !hostState.players.some((p) => p.name === 'Carol'));

  // Lobby scenario: removing frees the name for immediate reuse.
  const created2 = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10 } });
  check('second room created', created2.ok, created2.code);
  const D = await joinPlayer(created2.code, 'Dave');
  check('Dave joined lobby', D.ok);
  const rmD = await ack(host, 'host:removePlayer', { playerId: D.playerId });
  await sleep(300);
  check('host removed Dave in lobby', rmD.ok);
  const D2 = await joinPlayer(created2.code, 'Dave');
  check('freed name can be reused in the lobby', D2.ok, D2.playerId || '');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
