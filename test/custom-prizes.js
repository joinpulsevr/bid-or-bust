// Targeted checks for the host prize editor (Oct 22):
//  custom lot lists are used, bonus/penalty math holds, invalid lists rejected,
//  and rooms without a custom list still get the 15 defaults.
// Spawns its own server on PORT 3102, then shuts it down.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3102;
const URL = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}

const CUSTOM = [
  { kind: 'prize', label: 'Test $30 Cash App', detail: 'Custom prize 30', value: 30, bonus: 0, penalty: 0 },
  { kind: 'prize', label: 'Test $50 Spend', detail: 'Custom bonus prize', value: 50, bonus: 50, penalty: 0 },
  { kind: 'prize', label: 'Test Freebie', detail: 'Worth nothing, still a prize', value: 0, bonus: 0, penalty: 0 },
  { kind: 'bust', label: 'Test Nothing', detail: 'Custom empty box', value: 0, bonus: 0, penalty: 0 },
  { kind: 'bust', label: 'Test Lose $25', detail: 'Custom sting', value: 0, bonus: 0, penalty: 25 },
  { kind: 'prize', label: 'Test $10 Quest', detail: 'Custom quest app', value: 10, bonus: 0, penalty: 0 },
];

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

  // --- invalid lists are rejected, no room created ---
  const tooFew = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10, lots: CUSTOM.slice(0, 4) } });
  check('4-lot list rejected', !tooFew.ok, tooFew.error || '');
  const noName = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10, lots: [...CUSTOM.slice(0, 5), { kind: 'prize', label: '   ', detail: '', value: 5 }] } });
  check('unnamed lot rejected', !noName.ok, noName.error || '');
  const tooMany = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10, lots: Array.from({ length: 31 }, (_, i) => ({ kind: 'prize', label: 'P' + i, detail: '', value: 5 })) } });
  check('31-lot list rejected', !tooMany.ok, tooMany.error || '');

  // --- custom room plays the custom lots ---
  const created = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10, lots: CUSTOM } });
  check('custom room created', created.ok, created.code);
  const code = created.code;

  const players = [];
  for (let i = 0; i < 2; i++) {
    const s = io(URL);
    await new Promise((r) => s.on('connect', r));
    const r = await ack(s, 'player:join', { code, name: 'C' + i });
    check('player joined: C' + i, r.ok);
    players.push(s);
  }

  await ack(host, 'host:startGame', {});
  await sleep(300);
  check('custom game has 6 lots (not 15 defaults)', hostState.totalLots === 6, String(hostState.totalLots));

  const revealed = [];
  let bonusOk = null, penaltyOk = null;
  const balOf = (name) => {
    const p = hostState.players.find((q) => q.name === name);
    return p ? p.balance : null;
  };

  for (let round = 0; round < 6; round++) {
    await ack(host, 'host:openBidding', {});
    await sleep(300);
    const lotLabel = hostState.hostView.currentLot.label;
    const sealed = hostState.isSealed;
    const before = balOf('C0');
    if (lotLabel === 'Test $50 Spend' || lotLabel === 'Test Lose $25') {
      // C0 wins this lot for exactly $50 so bonus/penalty math is checkable.
      if (sealed) await ack(players[0], 'player:sealedBid', { amount: 50 });
      else await ack(players[0], 'player:bid', { amount: 50 });
      await sleep(200);
    }
    await ack(host, 'host:closeBidding', {});
    await sleep(300);
    const rv = hostState.lastReveal;
    revealed.push(rv && rv.label);
    if (rv && rv.winnerName === 'C0') {
      const after = balOf('C0');
      if (lotLabel === 'Test $50 Spend') bonusOk = after === before - 50 + 50;
      if (lotLabel === 'Test Lose $25') penaltyOk = after === before - 50 - 25;
    }
    if (round < 5) {
      await ack(host, 'host:nextLot', {});
      await sleep(300);
    }
  }
  check('all revealed labels are the custom lots',
    revealed.slice().sort().join('|') === CUSTOM.map((l) => l.label).sort().join('|'),
    revealed.join(', '));
  check('bonus prize tops winner back up (+$50)', bonusOk === true, String(bonusOk));
  check('bust penalty stings extra (-$25)', penaltyOk === true, String(penaltyOk));

  // --- a room without a custom list still gets the 15 defaults ---
  const def = await ack(host, 'host:create', { settings: { startCash: 500, bidSeconds: 10 } });
  check('default room created', def.ok, def.code);
  const dSock = io(URL);
  await new Promise((r) => dSock.on('connect', r));
  await ack(dSock, 'player:join', { code: def.code, name: 'D0' });
  await sleep(300);
  await ack(host, 'host:claim', { code: def.code, hostToken: def.hostToken });
  await sleep(200);
  // NOTE: host:claim re-points this socket at the new room; start it.
  const started = await ack(host, 'host:startGame', {});
  await sleep(300);
  check('default room still has 15 lots', started.ok && hostState.totalLots === 15,
    `${started.ok} / ${hostState.totalLots}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
