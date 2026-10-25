# PulseVR Life — LIVE SERVER BUILD CONTRACT

This file is the single source of truth for the server build in
`~/workspace/pulsevr-life-server/`. Backend and frontend builders MUST follow
it exactly. If anything here conflicts with an earlier idea, this file wins.

## 1. Layout and ownership (no overwrites)

```
pulsevr-life-server/
  package.json, server.js, render.yaml, README.md, DEPLOY_WALKTHROUGH.md
  lib/catalog.js, lib/game.js, lib/store.js, lib/store-file.js,
  lib/store-pg.js, lib/seed.js
  public/index.html, public/style.css, public/app.js, public/hero.jpg
  test/simulate.js
```

- BACKEND builder owns everything EXCEPT `public/`.
- FRONTEND builder owns ONLY `public/` (and copies the hero image there).
- Neither builder touches the other's files. The tester owns `test/`.
- Stack mirrors Bid or Bust: Node + Express + Socket.IO. `npm start` runs
  `node server.js`. Health endpoint: `GET /health` → `{ ok: true, game:
  'pulsevr-life' }`.
- `express.static` serves ONLY `public/`. Nothing else in the repo is ever
  served to a browser.

## 2. Database decision (researched 2026-10-23)

- **Production: Neon Free Postgres** via the `pg` driver, connection string in
  env var `DATABASE_URL`. Permanent free tier, no credit card, no expiry
  (unlike Render's own free Postgres, which is DELETED 30 days after
  creation — never use Render free Postgres for this game).
- **Local/dev/test fallback: JSON file** (`DATA_FILE`, default
  `./data/pulsevr-life.json`) when `DATABASE_URL` is unset. Atomic writes
  (write temp file, then rename).
- `lib/store.js` picks the adapter: `DATABASE_URL` set → Postgres, else file.
  Both adapters expose the SAME async interface (see §7). Game logic never
  knows which adapter is active.
- **Repo MUST stay PRIVATE.** `lib/seed.js` contains real member IDs (see
  §3). The deploy walkthrough must warn Karen in bold: never make the
  GitHub repo public. Seeding runs only when the tables are empty; after
  first boot the database is the source of truth.
- Render free web service notes for the walkthrough: sleeps after 15 min
  idle (~1 min cold start), 750 instance hours/month, ephemeral filesystem
  (which is exactly why the database must live outside Render).

## 3. Seed data (SERVER ONLY — never in public/, never in client code)

- 26 real members, each: display name, tier, PVR ID. The backend builder
  receives the exact roster in its brief. Seed cash $10,000, no homes/cars,
  career unset (player picks on first play), points 0.
- 3 admins ONLY: CoolVibez (ADM739214), Nimmie (ADM518407), ReeseCup
  (ADM926351). Admin IDs are seeded server-side only.
- Admins are NOT players: no player record, no cash, no pawn, never on the
  leaderboard, points ledger, or CSV exports.

## 4. Catalog (server is authoritative; client renders what server sends)

### Homes (8) — price, daily rent, daily appreciation, stock (null = unlimited)
1. Maple Court Starter — $8,500 — rent $120/day — 0.4%/day — stock null
2. Neon Loft — $15,000 — rent $220/day — 0.5%/day — stock null
3. Palm Villa — $25,000 — rent $380/day — 0.5%/day — stock null
4. Skyline Condo — $40,000 — rent $620/day — 0.6%/day — stock null
5. Gold Coast Mansion — $65,000 — rent $1,050/day — 0.6%/day — stock null
6. Baddie Penthouse — $100,000 — rent $1,700/day — 0.7%/day — stock null
7. Sunset Estate — $150,000 — rent $2,600/day — 0.7%/day — stock 5
8. Pulse Palace — $250,000 — rent $4,500/day — 0.8%/day — stock 3

Photos: stable seeded placeholder photos (e.g. picsum seeded URLs) on each
card. NEVER a broken-image risk. README documents how Karen swaps in real
photo URLs later.

### Cars (7) — price, stock (scarcity enforced server-side)
1. City Cruiser — $3,000 — stock 10
2. Neon Coupe — $8,000 — stock 5
3. Gold SUV — $15,000 — stock 5
4. Pink Phantom — $25,000 — stock 3
5. Diamond GT — $45,000 — stock 2
6. Crown Royale — $80,000 — stock 1
7. Jet Setter — $150,000 — stock 1
Cars count toward net worth at purchase price. No income from cars.

### Careers (4 ladders; shift salary per level)
- Hustler: Side Hustle $150 → Full-Time Grind $280 → Boss Moves $450
- Creative: Content Creator $200 → Influencer $400 → Media Mogul $700
- Business: Intern $250 → Manager $500 → Executive $900
- CEO track (requires one-time MBA purchase $5,000): MBA Student → Startup
  Founder $1,200 → CEO $2,000
Rules: a player picks a ladder; working a shift pays that level's salary.
After 5 shifts at the current level, promotion is available (free). Progress
is kept PER LADDER (switching ladders resumes that ladder's stored level).
MBA purchase is a persistent flag that unlocks the CEO ladder.

### Day cycles
- Server day timer: `DAY_MS` env (default 120000 = 2 min). One global day
  counter starting at day 1. Each cycle, for every ACTIVE (non-removed)
  player: cash += sum of daily rent of owned UNLISTED homes; each owned
  home value *= (1 + appreciation). Then a 30% life-event roll per player
  (see below). Persist everything. Broadcast leaderboard + personal states.
- Admin event `admin:advanceDay` triggers one immediate cycle (admin tool
  and test hook).

### Life events (server picks; client only renders the toast)
Pool (random pick on a hit): Cash windfall +$250; Side gig bonus +$500;
Viral moment +$1,000; Car repair −$200; Rent spike bonus +$300 (extra rent);
Market dip −$400; Birthday gifts +$750; Luxury tax −$600. Apply the delta
to cash (never below $0 from an event penalty — floor at $0), send a
personal `game:event` toast, persist.

### Points and milestones
- Playtime: +1 pt per 10 seconds of connected socket time, accrued
  server-side. Persist on every mutation, plus a 60-second flush and on
  disconnect.
- Milestones (+25 pts each, toast on first unlock): first-login,
  first-job (first shift), first-promotion, first-home, first-car,
  first-sale (first marketplace sale), mba (MBA purchased), ceo (reached
  CEO level), rich-50k (net worth ≥ $50,000), rich-100k (net worth ≥
  $100,000), top1 (reached #1 on leaderboard).

### Net worth and board position
- netWorth = cash + Σ owned home values + Σ car purchase prices.
- boardPosition (Road to Riches, 20 spaces): min(19, floor(netWorth /
  15000)). Server computes and sends it; client only renders.

## 5. Auth (server-side only — non-negotiable)

- The client NEVER receives the member roster, any member ID except the
  signed-in player's own (labeled private), or any admin ID.
- `auth:login { role: 'member'|'admin', id?, token? }`:
  - Fresh login: `id` given. Member IDs: trim + uppercase, exact match
    against the server member table. Admin IDs: exact match against the
    server admin table.
  - Resume: `token` given (issued at login, stored server-side in the DB).
  - Wrong ID → `auth:result { ok: false, error: 'Invalid ID' }` (generic).
  - Removed member → `auth:result { ok: false, error: 'This player
    account is currently removed. Contact an admin.' }`.
  - Success → `auth:result { ok: true, role, token, player?, admin?,
    catalog, leaderboard, marketplace, day }`. Player payload includes the
    player's OWN memberId (client shows it as "Your ID (private)").
- A socket authenticated as a MEMBER may only use player events. A socket
  authenticated as an ADMIN may only use admin events. Cross-role calls
  are rejected. Unauthenticated sockets get nothing but `auth:result`
  failures.
- Logout (`player:logout` / `admin:logout`) invalidates the token.

## 6. Socket events

Client → server:
- `auth:login`, `player:workShift {}`, `player:promote {}`,
  `player:buyMBA {}`, `player:switchCareer { career }`,
  `player:buyHome { homeId }`, `player:buyCar { carId }`,
  `player:listHome { homeId, price }`, `player:unlistHome { listingId }`,
  `player:buyListing { listingId }`, `player:logout {}`
- `admin:ledger {}`, `admin:standings {}`,
  `admin:export { kind: 'points'|'standings' }`,
  `admin:removePlayer { memberId }`, `admin:restorePlayer { memberId }`,
  `admin:addMember { name, tier, memberId }`,
  `admin:updateCatalog { type: 'home'|'car', id, fields }`,
  `admin:changeId { newId }`, `admin:advanceDay {}`, `admin:logout {}`

Server → client:
- `auth:result`, `player:state { player }`, `game:leaderboard
  { leaderboard }`, `game:marketplace { listings }`, `game:catalog
  { catalog }`, `game:day { day }`, `game:event { title, text, delta }`,
  `admin:ledgerData { players, removed }`, `admin:standingsData
  { standings }`, `admin:exportData { kind, csv }`, `admin:opResult
  { ok, message }`, `error { message }`

Shapes:
- player: `{ name, tier, memberId (owner only), cash, netWorth, career,
  careerLevel, mba, shiftsAtLevel, careers: { hustler, creative, business,
  ceo }, homes: [{ homeId, name, value, purchasePrice, rent, listedPrice,
  listingId }], cars: [{ carId, name, price }], points, playSeconds, boardPosition,
  milestones: [ids], day }` — `listingId` is the marketplace listing id when
  that owned home is currently listed, else null (so the client can unlist
  via `player:unlistHome { listingId }`).
- leaderboard entry: `{ rank, name, tier, netWorth, cash, homes, cars,
  points, pawnColor, boardPosition, crown }` — NO IDs, ever.
- catalog: `{ homes: [{ id, name, price, rent, appreciation, stock,
  photo }], cars: [{ id, name, price, stock, photo }], careers: [{ id,
  name, levels: [{ title, salary }], mbaRequired }] }`
- marketplace listing: `{ id, homeId, homeName, price, sellerName, value }`
  — seller NAME only, never an ID.

## 7. Store interface (both adapters implement all of these)

`init()`, `getMemberById(id)`, `getAllMembers()`, `saveMember(m)`,
`getAdminById(id)`, `getAllAdmins()`, `saveAdmin(a)`, `getListings()`,
`saveListing(l)`, `deleteListing(id)`, `getMeta(key)`, `setMeta(key,
value)`, `close()`. Write-through: every mutation persists before the
server acknowledges the action to the client.

## 8. Server-side validation (anti-cheat — the tester WILL probe this)

- The server NEVER trusts client-supplied money, prices, or quantities.
  Prices, salaries, rents, and stock come from the server catalog.
- buyHome/buyCar: player must have funds; stock must remain (decrement
  atomically-ish: check-then-write in one awaited sequence); duplicate
  home ownership allowed (a player may own several homes, including
  multiples of one type, while stock lasts).
- listHome: player must own the home and it must not already be listed.
  Price must be a positive integer (server clamps: min $100, max
  $10,000,000). buyListing: buyer must have funds; buyer cannot buy their
  own listing; on sale the home transfers with its current value, the
  listing is deleted, seller cash += price, buyer cash -= price.
- workShift/promote/buyMBA/switchCareer: validate career state
  server-side (promotion only after 5 shifts at level; MBA only once and
  only with funds; CEO ladder only with MBA flag).
- updateCatalog: admin-only; validate field ranges; changes apply to
  future purchases and to day-cycle rent/appreciation from the next cycle.
- addMember: admin-only; memberId must match /^PVR\d{5}$/ and be unique;
  name non-empty (≤ 40 chars); tier one of Rookie/Rising Star/VIP/Elite/
  Legend. Duplicate ACTIVE memberId → error. Duplicate REMOVED memberId
  → treated as a restore (see §9).

## 9. Admin console and remove/restore (server-side, real dates)

- Console-only view for admins: points ledger, standings, CSV exports
  (points + standings, delivered as CSV text over the socket for client
  download), add-member, manage-players table, catalog price/rent/stock
  controls, advance-day button, "Your Admin ID" panel.
- CSV points columns: name, memberId, tier, points, playSeconds, netWorth.
  CSV standings columns: rank, name, memberId, tier, netWorth, homes,
  cars, points.
- Remove: `admin:removePlayer` sets removedAt = now (ISO). Removed
  players: cannot sign in, are excluded from leaderboard + ledger +
  standings, and their active marketplace listings are delisted (homes
  stay owned but unlisted). Their socket sessions are invalidated.
- Restore: `admin:restorePlayer` — if now − removedAt ≤ 3 days, clear
  removedAt and return the player with FULL state intact (cash, homes,
  cars, career, points). If > 3 days, reset to fresh: $10,000, no
  homes/cars, careers reset to level 1, MBA flag cleared, points 0,
  playSeconds 0, milestones cleared, then clear removedAt.
- Ledger response includes a `removed` array: `{ memberId, name,
  removedAt, restoreDeadline, daysLeft }` for admin visibility.

## 10. Frontend requirements (for the frontend builder)

- One page app: landing hero (Karen's reference image, copied to
  `public/hero.jpg`) → sign-in (Member ID field + "Enter the Game" button;
  separate Admin tab with a MASKED Admin ID field only) → game dashboard.
- Mobile-first responsive (phone + web, one link). Neon pink + metallic
  gold + deep purple. Diamond PULSEVR Life logo treatment with crown,
  "PLAY NOW" energy, Monopoly board elements (deed cards, dice, cash
  stacks, board path).
- Dashboard: player pawn on the Road to Riches path, cash/net worth,
  career card (work shift, promote, MBA, switch ladder), homes catalog
  (deed cards with photo, price, rent, appreciation, stock badge incl.
  LAST ONE / SOLD OUT), cars catalog, marketplace, life-event toasts,
  live leaderboard (crown on #1, NO IDs anywhere), points display.
- Admin console view (admin sessions only): ledger, CSV download buttons,
  add-member form, manage-players table (remove/restore with deadlines),
  catalog controls, advance-day button, Your Admin ID panel.
- NO member IDs, NO admin IDs, NO roster, NO tokens, NO lists of other
  players anywhere in `public/` files or client code. The ONLY ID the
  client ever holds is the one the signed-in user typed (their own).
- Zero console errors. No broken images (hero + seeded photos only).
- Avatar: deterministic CSS avatar per member (initials + gradient +
  pawn color, derived from name hash). No external avatar dependency.

## 11. Testing hooks

- `DAY_MS` env var controls the day timer (tests set it small).
- `admin:advanceDay` forces one day cycle immediately.
- `GET /health` for deploy verification.
- The tester will run a full-game simulation (see the test brief) and
  report pass/fail counts honestly.
