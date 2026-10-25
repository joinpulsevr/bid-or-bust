# PulseVR Life — Live Server

The live server game for the Join PulseVR community: Monopoly × Game of
Life. Players start with $10,000, pick a career ladder, work shifts, get
promoted, buy homes and cars, trade on the player marketplace, and climb
the Road to Riches leaderboard while days tick by on the server.

Stack: Node + Express + Socket.IO, mirroring Bid or Bust (`server.js` +
`public/` + `render.yaml` + `package.json`).

## What lives here

| Path | What it is |
| --- | --- |
| `server.js` | Express + Socket.IO server, `/health`, day timer, all socket events, auth + role enforcement, points accrual |
| `lib/catalog.js` | Server-authoritative catalog: homes, cars, careers, life events, milestones |
| `lib/game.js` | Pure game logic: net worth, board position, leaderboard, day cycle, CSV exports, remove/restore math |
| `lib/store.js` | Picks the adapter: Postgres when `DATABASE_URL` is set, else the JSON file |
| `lib/store-file.js` | JSON file store (atomic write-temp-then-rename) |
| `lib/store-pg.js` | Neon Postgres store via `pg` |
| `lib/seed.js` | **Server only** — the 26 real members + 3 admins. Never copied to `public/`, never sent to a client |
| `public/` | Frontend: player UI (careers, board, wallet, mail, How to Play), admin console (incl. CoolVibez-only reset card) |
| `test/simulate.js` | Full-game simulation: 145 pre-existing checks + v2 unit tests + v2 socket sections (§17–§26) |

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` (once the frontend is in `public/`) and
check `http://localhost:3000/health` → `{ "ok": true, "game": "pulsevr-life" }`.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (Render sets this itself) |
| `DATABASE_URL` | *(unset)* | Neon Postgres connection string. When unset, the JSON file store is used |
| `DATA_FILE` | `./data/pulsevr-life.json` | Path for the JSON file store |
| `DAY_MS` | `120000` | Length of one in-game day in milliseconds (2 minutes). Tests set this small |
| `SHIFT_WINDOW_MS` | `86400000` | Rolling window for the 3-shift cap (24 hours). Tests compress this |
| `PROMO_PLAYTIME_SCALE` | `1` | Multiplier on promotion playtime thresholds. Tests use `1/6` (10s/30s) |
| `UTILITY_INTERVAL_DAYS` | `30` | Days between utility charges per player. Tests use a huge value except §24 |

## The database choice — and why

**Production: Neon Free Postgres.** It is a permanent free tier: no credit
card, no expiry, and it scales to zero when idle. **Never use Render's own
free Postgres for this game** — Render deletes its free databases 30 days
after creation, which would wipe every player's progress.

**Local/dev fallback: a JSON file** (`DATA_FILE`, default
`./data/pulsevr-life.json`) when `DATABASE_URL` is unset, with atomic
writes (write a temp file, then rename). This is what `npm start` uses on
a laptop with no database configured. Note: Render's filesystem is
ephemeral, so the file store must never be used in production — a
redeploy or restart would lose it. That is exactly why production data
lives in Neon, outside Render.

Both adapters implement the same interface (`lib/store.js`, CONTRACT §7),
so game logic never knows which one is active. Every mutation is written
through to the store **before** the server acknowledges the action to the
client.

Seeding runs only when a table is empty: on first boot the 26 members
($10,000 cash, no homes/cars, no career yet, 0 points) and the 3 admins
(no player record) are created. After that, the database is the source of
truth.

## Rules the server enforces (CONTRACT §4–§9, plus v2 rules Oct 25, 2026)

- **Careers:** 8 ladders — Hustler ($150/$280/$450), Creative
  ($200/$400/$700), Business ($250/$500/$900), CEO track
  ($0/$1,200/$2,000, MBA-required), Trader ($300/$550/$1,000),
  Culinary ($180/$350/$800), Fitness ($170/$330/$750), Tech
  ($280/$600/$1,100). Working a shift pays that level's salary.
  Progress is kept **per ladder** — switching ladders resumes that
  ladder's stored level and shift count. The CEO track needs a
  one-time $5,000 MBA purchase; every other ladder tops out at its
  own senior role.
- **Shift cap (v2):** max **3 work shifts per player per rolling
  24 hours**, enforced server-side from stored shift timestamps. A
  4th attempt is rejected ("Shift limit reached — you can work 3
  shifts every 24 hours. Try again later."). The window is rolling
  `(now − window, now]`; a shift exactly one window old has expired.
- **Slower promotions (v2):** promotion requires BOTH the shift
  count AND cumulative playtime (`playSeconds`, all sessions/ladders
  combined). Table: L0→L1 = 5 shifts + 60s; L1→L2 = 5 shifts + 180s.
  (`PROMO_PLAYTIME_SCALE` compresses the playtime leg for tests only.)
- **Day cycles:** every `DAY_MS`, every **playing** player (not
  removed AND activated — see below) earns rent from unlisted homes
  at the *current* catalog rent, every owned home appreciates at the
  *current* catalog rate, and each player has a 30% chance of a life
  event (+$250 to +$1,000, or −$200 to −$600, floored at $0). Admins
  can also force a cycle with `admin:advanceDay`.
- **Points:** +1 per 10 seconds of connected socket time, flushed every
  60 seconds and on disconnect. 11 milestones at +25 pts each
  (first login/job/promotion/home/car/sale, MBA, CEO, $50k/$100k net
  worth, leaderboard #1).
- **Monthly home utilities (v2):** every 30 day-cycles (per-player
  schedule, `UTILITY_INTERVAL_DAYS`), each owned home is charged
  **2% of its current value**, rounded per home, deducted from cash
  and floored at $0 (utilities never push cash negative, no debt
  carried). `nextUtilityDay` is set on first home owned (purchase or
  marketplace) to current day + interval; on a due day the charge is
  computed on post-appreciation values, deducted once, and
  `nextUtilityDay` advances one full interval. Listed homes are
  charged too (still owned). The wallet shows the next charge and day.
- **Inactive members (v2):** seeded members start **inactive** and
  stay at $10,000 with no assets until their first login, which
  activates them; only then does progress begin. The day cycle skips
  inactive players entirely (no rent, appreciation, life events,
  utilities, or milestones). The leaderboard shows inactive members
  at $10,000 with no assets.
- **Boot migration (v2, live game):** on boot, existing data is
  never re-seeded or reset. Rows missing the v2 fields are
  classified by activity — any playtime > 0, shifts > 0, owned homes
  or cars, or any milestone means **active** with progress fully
  preserved; zero activity across all of those means **inactive**
  with cash reset to exactly $10,000. Migrated players start with an
  empty shift-timestamp history (the 24h cap starts fresh), and
  active homeowners get their first utility charge one full interval
  after the v2 boot (no retroactive charges). Migration is
  idempotent: later boots change nothing.
- **Net worth** = cash + home values + car purchase prices. **Board
  position** (Road to Riches, **40 tiles**) =
  `min(39, floor(netWorth / 10000))`; the crown sits on tile 39
  ($400,000).
- **Tile milestone rewards (v2):** granted the FIRST time a pawn
  reaches or passes the tile (multi-tile jumps grant all crossed
  tiles), never re-granted: tile 5 Lucky Break +$1,000; tile 10 Cash
  Bonus +$2,500; tile 15 Tax Return +$5,000; tile 20 **exclusive
  Pulse Phantom car** ($30,000 net-worth value, cannot be bought in
  the catalog — `buyCar` rejects it as unknown); tile 25 Jackpot
  +$7,500.
- **Wallet quickview (v2):** the player UI has a Wallet button/panel
  showing cash, every owned home with current value, every owned
  car, total net worth, and the next utility charge — one snapshot
  (also in every `player:state` payload as `wallet`).
- **Private messaging (v2):** members message each other privately,
  email-style, addressed by exact player name (names are public via
  the leaderboard; member IDs are never needed or exposed). Events:
  `player:sendMessage` (rejects missing/ambiguous recipient,
  self-message, empty body, body > 2000 chars; subject truncated to
  100 chars), `player:listMail`, `player:readMail` (recipient only).
  Messages are server-stored (Postgres `messages` table and JSON
  fallback alike), carry names only, and only sender and recipient
  can read them — **admins have NO access to message contents**
  (no admin mail event exists). A `mail:new` ping plus a badge
  alerts the recipient.
- **How to Play (v2):** a How to Play button directly under the Play
  button on landing opens a modal explaining the goal (richest
  player wins), careers and shifts, the 3-shifts-per-24-hours cap,
  homes/cars/marketplace, points, messaging, and the tile rewards.
- **Game-image backdrop (v2):** the UI background is `public/hero.jpg`
  under a dark readable overlay, so the look matches the game's
  aesthetic.
- **Marketplace:** a player lists an owned, unlisted home at a price the
  server clamps to $100–$10,000,000. Buyers can't buy their own listing.
  On sale the home transfers at its current value, the listing is
  deleted, and the seller banks the price. A marketplace purchase
  also sets the buyer's `nextUtilityDay` if unset.
- **Scarcity:** finite stock (Sunset Estate 5, Pulse Palace 3, most cars)
  is enforced server-side; stock shown to clients is *remaining* units.
- **Remove/restore:** removing a player stamps `removedAt`, blocks
  sign-in, hides them from the leaderboard/ledger/standings, delists
  their marketplace homes (homes stay owned), and kicks their live
  sessions. Restoring within 3 days returns full state intact; after 3
  days they restart fresh at $10,000.
- **Admin reset (v2, SEPARATE from remove/restore):** destructive and
  permanent, no restorable snapshot, no 3-day grace. (a) Reset an
  individual player: exact fresh-start state ($10,000, no homes/cars,
  careers reset, MBA cleared, points 0, milestones empty), delists
  their marketplace listings, deletes messages to/from them; other
  players untouched. (b) Reset the entire game: EVERY player to
  fresh-start state, all listings and messages cleared, day counter
  reset to 1. Access: **ONLY the CoolVibez admin** (identified by
  admin NAME, not the changeable admin ID); Nimmie and ReeseCup are
  rejected server-side, and the Admin Console UI hides these
  controls from any admin who is not CoolVibez. Both actions require
  explicit confirmation (UI confirm dialog + a `confirm: true` flag
  the server checks). Individual reset refuses already-removed
  players (restore them instead). PVR IDs, tiers, and admin IDs are
  never touched. Catalog overrides and admin records are untouched.
- **Admin change-ID:** an admin can change their own admin ID
  (`ADM` + 6 digits, must be unique). The old ID stops working
  immediately; the change persists server-side.
- **Auth:** member IDs are matched trim + uppercase; admin IDs match
  exactly. Removed members get a specific "currently removed" message;
  wrong IDs get a generic "Invalid ID". Tokens are issued at login,
  stored server-side, and invalidated on logout or removal. Member
  sockets may only use player events; admin sockets only admin events.

## Security — read before deploying

- **This repo MUST stay private.** `lib/seed.js` contains real member
  IDs. Never make the GitHub repo public, never copy seed data into
  `public/`, and never log member or admin IDs.
- The server **never** sends the member roster, any member ID (except a
  player's own, to that player only), or any admin ID to a client.
  Leaderboard and marketplace payloads carry names only, never IDs.
  Admin-only views (ledger, standings, CSV exports) are the one place
  member IDs appear, and only to authenticated admin sockets.
- All prices, salaries, rents, and stock come from the server catalog.
  Client-supplied money is ignored, and every action is validated
  server-side (funds, stock, ownership, career state, listing ownership).
- `express.static` serves **only** `public/`. Nothing else in the repo
  is ever served to a browser.

## Home and car photos (v2)

Every catalog card shows a photo from the `PHOTOS` map in
`lib/catalog.js`: stable direct `images.unsplash.com` URLs (never
`source.unsplash.com`, which is deprecated), one per home (8), per car
(7), plus the exclusive Pulse Phantom. Every URL was verified with an
HTTP HEAD check (200) on Oct 25, 2026.

Note: the static demo artifact's home/car images could not be reused
as URLs — a completed artifact inspection (Oct 25, 2026) confirmed the
demo uses only local bundled files (`assets/home-*.jpg`,
`assets/car-*.jpg`), not external URLs, and no public base URL for the
demo exists to build absolute URLs from. The Unsplash photos above are
therefore the documented fallback, and they are what the live server
serves. To swap in Karen's real photos later, replace the `PHOTOS`
map entries in `lib/catalog.js` — no client changes needed, since the
client renders whatever photo URL the server's catalog snapshot sends.
