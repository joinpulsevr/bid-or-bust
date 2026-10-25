# 🔨 Bid or Bust — Join PulseVR live auction game

A real-time, 50-player mystery-box auction. The host runs the show from a laptop,
players bid from their phones via a link, and a big broadcast view streams into
VRChat. 15 lots per game, shuffled fresh every time.

## Quick start (run it locally)

```bash
cd bid-or-bust
npm install
npm start
```

Then open:

- **Host screen:** http://localhost:3000/host.html — create the room, run the auction
- **Player join:** http://localhost:3000/play.html?room=CODE — phone-friendly bidding
- **Broadcast view:** http://localhost:3000/broadcast.html?room=CODE — the big screen

Run the automated full-game test (needs the server running in another terminal):

```bash
npm test
```

## Game rules (as built)

- **15 lots per game**, shuffled every game: 10 real prizes + 5 busts.
- **Host-editable prizes:** on the Create Room screen the host can rename lots, change prize values and bust penalties, flip a lot between prize and bust, add lots, or remove them (5–30 lots per game).
  - Prizes: $5 Meta Quest app · $10 Meta Quest app · $10 VRChat Plus · $20 Cash App ·
    $5 Cash App · $25 Cash App · VRChat Home Upgrade · 1 Month Join PulseVR ·
    50% Off Join PulseVR · **$100 PulseVR Spend** (adds $100 to the winner's balance)
  - Busts: Nothing ×2 · Lose $50 ×2 · Lose $100 ×1
    (bust penalty comes *on top of* the winning bid you already paid — that's the gamble)
- **Everyone starts with $500** virtual PulseVR cash (host can change this).
- **Bids in $50 increments**, opening at $50. You can never bid more than your balance.
- **$0 = busted out.** No re-entry that game.
- **One Peek per player per game:** privately learn whether the current box is a prize or a bust.
- **ALL IN button** for the dramatic moment.
- **Strict timer:** bidding closes the moment the clock hits zero — a bid in the last second does NOT add time. Bid before the timer runs out.
- **Host can remove a player** any time from the Players table — seat and name are freed instantly (great for duplicate accounts). **Players can leave** from their phone with the Leave game button.
- **One sealed High Roller round per game** (random lot): everyone submits ONE secret bid,
  highest wins. No bidding war.
- Winner pays their bid, the box opens live for everyone, then the host moves to the next lot.
- Final ranking: total prize value won, tiebreak on cash remaining.

### Why $500 starting cash?

15 rounds, $50 bid units. $500 = 10 units of bidding power: enough to seriously
contest 3–5 lots at typical $100–200 winning bids, survive one $100 bust, and still
be alive for the finale — while the $100-spend lot and careful peeks reward smart
money management. It fits a 60-minute show (about 3–4 minutes per lot).

## Hosting on the internet (for the 10/21 event)

The game needs a public server so 50 phones can reach it. Easiest path — Render:

1. Push this folder to a GitHub repo.
2. In Render: New → Web Service → connect the repo. It reads `render.yaml` automatically.
3. You get a URL like `https://bid-or-bust.onrender.com` — that's your player link.

Alternatives: Railway (`railway up`), Fly.io (`fly launch`), or any Node host.
One small Node process handles 50 players easily.

> Free tiers sleep when idle — open the host page ~10 minutes before showtime
> so the server is warm when players join.

## Broadcasting into VRChat (live)

VRChat video players play **video streams**, not web pages — so the path is:

1. Open the **broadcast view** (`/broadcast.html?room=CODE`) in a browser on the host PC.
2. Capture that browser window in **OBS** (Window Capture, 1920×1080).
3. Stream from OBS to **Twitch or YouTube** (Stream key from your channel dashboard).
4. In the VRChat world, add the Twitch/YouTube stream URL to the video player.
   (Most lounge worlds with a screen use a player that resolves Twitch/YouTube links —
   e.g. via the world's video player UI. Paste your channel URL.)

The broadcast view is designed for this: huge current bid, countdown bar, mystery box,
live leaderboard, and a dramatic 3-second REVEALING… beat before each box opens.

## Event runbook (10/21, 8:30–9:30P ET)

1. 8:15 — start the server / wake the host, open `host.html`, create the room.
2. Put the **player link** (or just the 4-letter code) in the Members Lounge / Discord.
3. 8:30 — players join on phones; hit **Start Game** when the room fills.
4. Each lot: **Open Bidding** → hype the mystery → bidding auto-closes (or close early) →
   box opens live → **Next Lot**. 15 lots ≈ 60 minutes at ~3–4 min each.
5. Fulfill real prizes after the show from the host's player table (who won what is listed).

## Tweaks

- Starting cash and bid timer are set on the host's **Create Room** screen.
- To change the lots, edit `PRIZES` / `BUST_LOTS` in `server.js`.
- Bust mix and the 50-player cap are constants at the top of `server.js`.
