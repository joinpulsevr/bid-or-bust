# 🚀 Bid or Bust — Deploy Checklist (for the 10/21 live event)

The game is finished and tested (65/65 simulation checks pass). This is the
one remaining step before event night: put the server on a public host so
~50 phones can reach it.

## Recommended path: Render (already configured)

`render.yaml` in this folder is set up — Render reads it automatically.

1. Push this folder to a GitHub repo (any name, e.g. `bid-or-bust`).
2. Go to [render.com](https://render.com) → **New → Web Service** → connect the repo.
   Render picks up `render.yaml` (Node 20, `npm install`, `npm start`) on its own.
3. You get a URL like `https://bid-or-bust.onrender.com` — that becomes:
   - Players: `https://bid-or-bust.onrender.com/play.html?room=CODE`
   - Host: `https://bid-or-bust.onrender.com/host.html`
   - Broadcast (OBS/VRChat screen): `https://bid-or-bust.onrender.com/broadcast.html?room=CODE`
4. Do a 2-phone playtest: create a room on the host screen, join from two
   phones, run one lot end-to-end. If bidding + reveal work, you're live-ready.

## ⚠️ The one gotcha: free plan sleeps

`render.yaml` currently uses the **free** plan. Free web services **spin down
after 15 minutes of inactivity**, and the next visit pays a **30–60 second
cold start**. For an 8:30 PM show where 50 players all tap the link at once,
that means the first arrivals stare at a loading screen while the server
wakes up — bad first impression for a live event.

**Two ways to handle it:**

- **Free + warmup (costs $0):** ~5 minutes before showtime, open the game URL
  yourself (or the `/health` endpoint). One visit wakes the server and it
  stays warm through the whole event. Totally workable — just don't forget.
- **Starter plan ($7/mo, cancel after):** always-on, no spin-down, no cold
  start, slightly faster. The "insurance" option for event week.

Recommendation: deploy on **free today** so you can playtest this week, then
decide the week of the event whether the $7 is worth the peace of mind.

## Event-night warmup reminder

Whoever runs the host screen: open the public URL at ~8:25 PM ET on 10/21,
before sharing the link + 4-letter room code with the lounge. Five minutes
early = zero cold-start risk.
