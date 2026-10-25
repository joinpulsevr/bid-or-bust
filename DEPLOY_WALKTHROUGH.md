# PulseVR Life — Deploy Walkthrough (for Karen)

Deploying the live server takes about 20 minutes. You do it once; after
that, players just open one link. Follow the steps in order — each one
builds on the last.

> **⚠️ NEVER make the GitHub repo public. This folder contains real
> member IDs (in `lib/seed.js`). The repo MUST stay private, or anyone
> on the internet could sign in as any member.**

## Step 1 — Create a free Neon database

Neon is the permanent free home for all game data (players, cash, homes,
points). It costs nothing, needs no credit card, and never expires.

1. Go to [neon.tech](https://neon.tech) and create a free account
   (sign up with Google or GitHub — either is fine).
2. Create a new project. Name it something like `pulsevr-life`.
   Region: pick the one closest to you (US East is a safe default).
3. Inside the project, create a database (Neon usually creates one called
   `neondb` for you — that works fine).
4. Open the project's **Dashboard → Connection Details** and copy the
   **connection string**. It looks like this:
   `postgres://username:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
5. **Keep that string handy — you paste it into Render in Step 4.**
   Treat it like a password: never post it in chat, and never commit it
   to the repo. (The repo's `render.yaml` leaves `DATABASE_URL` blank on
   purpose — `sync: false` means Render asks you for it, it never comes
   from the code.)

Why Neon and not Render's own free database? Render's free Postgres is
**deleted 30 days after creation** — every player's progress would vanish.
Neon's free tier is permanent.

## Step 2 — Push this folder to a PRIVATE GitHub repo

1. On GitHub, create a **new repository** named `pulsevr-life` (or
   similar).
2. **Set it to Private.** This is the important one — see the warning
   at the top. Double-check the repo says "Private" before you push
   anything.
3. Push this folder's contents to that repo (the same way Bid or Bust
   was pushed: `git init`, `git add .`, `git commit`, `git remote add`,
   `git push`). Make sure `lib/seed.js` is included — the server needs
   it for the first boot — and make sure no real `DATABASE_URL` is in
   any file (there shouldn't be; `render.yaml` only has the placeholder).

## Step 3 — Create a free Render web service

1. Go to [render.com](https://render.com) and sign in (the same account
   used for Bid or Bust works).
2. Click **New → Web Service** and pick **Build and deploy from a Git
   repository**. Connect the private `pulsevr-life` repo from Step 2.
3. Render will read `render.yaml` from the repo and fill in the settings
   for you: **Name** `pulsevr-life`, **Environment** `Node`,
   **Plan** `Free`, **Build Command** `npm install`, **Start Command**
   `npm start`.
4. Confirm the plan is **Free** before continuing.

## Step 4 — Paste in DATABASE_URL

1. On the new service's setup page, find the **Environment Variables**
   section. You will see `DATABASE_URL` listed (from `render.yaml`) with
   an empty value.
2. Paste the Neon connection string you copied in Step 1 as the value
   of `DATABASE_URL`.
3. Click **Create Web Service**. Render will install dependencies and
   start the server. First boot takes a couple of minutes.

## Step 5 — Deploy (and what happens on first boot)

Render deploys automatically once the service is created. On the very
first boot — and only then — the server seeds the game: all 26 members
(starting at $10,000) and the 3 admins. After that, the database is the
source of truth, and redeploys never re-seed or reset anyone.

You can watch progress on the service's **Logs** tab. When you see
`PulseVR Life server listening on ...`, the deploy is done.

## Step 6 — Verify it works

1. Open your Render service URL with `/health` on the end, e.g.
   `https://pulsevr-life.onrender.com/health`.
   You should see: `{ "ok": true, "game": "pulsevr-life" }`.
2. Open the service URL itself (`https://pulsevr-life.onrender.com`).
   The PulseVR Life landing page should load.
3. Sign in as a member with your own Member ID and check that your
   dashboard shows $10,000 starting cash. Then sign out and sign in on
   the Admin tab with an admin ID to check the Admin Console loads.
4. If anything looks off, check the **Logs** tab on Render first — it
   shows startup errors in plain language.

If the page takes a while to load the very first time, that is normal
(see the free-tier notes below) — wait about a minute and refresh.

## Step 7 — Share the link

Once verification passes, share the Render URL with members. One link
works on phones and on the web. Members sign in with their own Member
ID; nobody ever sees anyone else's ID or the member list.

## Free-tier notes (what to expect)

- **The Render service sleeps after 15 minutes idle.** The first visit
  after a sleep takes about **1 minute to wake up** (a "cold start").
  After that it is fast. For a big game night, open the link yourself a
  few minutes early to wake it up — just like Bid or Bust.
- **Render free plan: 750 instance hours/month**, which covers one
  always-on-ish service for a month.
- **Neon scales to zero when idle.** That is normal and free — the
  database wakes itself up on the next request, usually in a second or
  two.
- **If Neon's free CU-hours run out**, the database pauses until the
  next month. **Your data survives** — nothing is deleted — the game
  just waits until the new month's hours start (or until you upgrade
  Neon, which is optional).
- **Render's filesystem is temporary.** That is why the game data lives
  in Neon, not on Render: redeploys and restarts never touch player
  progress.
- **Keep the repo private forever.** If you ever need to share the code
  with a helper, add them as a collaborator on the private repo instead
  of making it public.
