// Demo seeder: joins 8 fake players to a room (CODE env) and bids once bidding opens.
// Keeps running so players stay "online" for screenshots.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const CODE = process.env.CODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ack = (s, ev, d) => new Promise((res) => s.emit(ev, d, res));
const NAMES = ['Twan', 'Chrissy', 'Blue Diamond', 'Tightwork', 'Trendi', 'LadyBug', 'Carebear', 'Stoic'];

(async () => {
  const players = [];
  for (const name of NAMES) {
    const s = io(URL);
    await new Promise((r) => s.on('connect', r));
    const r = await ack(s, 'player:join', { code: CODE, name });
    if (!r.ok) { console.log('join failed:', name, r.error); process.exit(1); }
    let state = null;
    s.on('state', (st) => { state = st; });
    players.push({ s, name, get state() { return state; } });
    await sleep(120);
  }
  console.log('seeded 8 players in room', CODE);

  const t0 = Date.now();
  while (Date.now() - t0 < 280000) {
    const st = players[0].state;
    if (st && st.phase === 'bidding') {
      for (let round = 0; round < 5; round++) {
        for (const p of players) {
          const cur = p.state;
          if (!cur || cur.phase !== 'bidding') break;
          const me = cur.players.find((q) => q.name === p.name);
          if (!me || !me.active || cur.highBidderName === p.name) continue;
          const next = cur.currentBid + 50;
          if (me.balance >= next && Math.random() < 0.75) {
            await ack(p.s, 'player:bid', { amount: next });
            await sleep(350);
          }
        }
      }
      await ack(players[2].s, 'player:peek', {});
      console.log('demo bids placed, current bid should be lively');
      break;
    }
    await sleep(1000);
  }
  setInterval(() => {}, 15000); // stay alive
})();
