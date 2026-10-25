// ============================================================================
// PulseVR Life — server-authoritative catalog (CONTRACT §4, v2 rules)
// The server is the ONLY source of prices, rents, salaries and stock.
// Client-supplied money, prices or quantities are never trusted.
// Catalog overrides (admin price/rent/stock edits) live in the store under
// meta key 'catalog' and are merged over these defaults at boot.
// For finite items, `stock` in the public snapshot means REMAINING units.
// ============================================================================

const HOMES = [
  { id: 'maple-court',    name: 'Maple Court Starter', price: 8500,   rent: 120,  appreciation: 0.4, stock: null },
  { id: 'neon-loft',      name: 'Neon Loft',           price: 15000,  rent: 220,  appreciation: 0.5, stock: null },
  { id: 'palm-villa',     name: 'Palm Villa',          price: 25000,  rent: 380,  appreciation: 0.5, stock: null },
  { id: 'skyline-condo',  name: 'Skyline Condo',       price: 40000,  rent: 620,  appreciation: 0.6, stock: null },
  { id: 'gold-coast',     name: 'Gold Coast Mansion',  price: 65000,  rent: 1050, appreciation: 0.6, stock: null },
  { id: 'baddie-penthouse', name: 'Baddie Penthouse',  price: 100000, rent: 1700, appreciation: 0.7, stock: null },
  { id: 'sunset-estate',  name: 'Sunset Estate',       price: 150000, rent: 2600, appreciation: 0.7, stock: 5 },
  { id: 'pulse-palace',   name: 'Pulse Palace',        price: 250000, rent: 4500, appreciation: 0.8, stock: 3 },
];

const CARS = [
  { id: 'city-cruiser',  name: 'City Cruiser',  price: 3000,   stock: 10 },
  { id: 'neon-coupe',    name: 'Neon Coupe',    price: 8000,   stock: 5 },
  { id: 'gold-suv',      name: 'Gold SUV',      price: 15000,  stock: 5 },
  { id: 'pink-phantom',  name: 'Pink Phantom',  price: 25000,  stock: 3 },
  { id: 'diamond-gt',    name: 'Diamond GT',    price: 45000,  stock: 2 },
  { id: 'crown-royale',  name: 'Crown Royale',  price: 80000,  stock: 1 },
  { id: 'jet-setter',    name: 'Jet Setter',    price: 150000, stock: 1 },
];

const CAREERS = [
  { id: 'hustler', name: 'Hustler', mbaRequired: false, levels: [
    { title: 'Side Hustle', salary: 150 },
    { title: 'Full-Time Grind', salary: 280 },
    { title: 'Boss Moves', salary: 450 },
  ] },
  { id: 'creative', name: 'Creative', mbaRequired: false, levels: [
    { title: 'Content Creator', salary: 200 },
    { title: 'Influencer', salary: 400 },
    { title: 'Media Mogul', salary: 700 },
  ] },
  { id: 'business', name: 'Business', mbaRequired: false, levels: [
    { title: 'Intern', salary: 250 },
    { title: 'Manager', salary: 500 },
    { title: 'Executive', salary: 900 },
  ] },
  { id: 'ceo', name: 'CEO Track', mbaRequired: true, levels: [
    { title: 'MBA Student', salary: 0 },
    { title: 'Startup Founder', salary: 1200 },
    { title: 'CEO', salary: 2000 },
  ] },
  // --- v2 ladders (Karen Oct 25: more jobs / career paths) ------------------
  { id: 'trader', name: 'Trader', mbaRequired: false, levels: [
    { title: 'Day Trader', salary: 300 },
    { title: 'Swing Trader', salary: 550 },
    { title: 'Hedge Fund Boss', salary: 1000 },
  ] },
  { id: 'chef', name: 'Culinary', mbaRequired: false, levels: [
    { title: 'Line Cook', salary: 180 },
    { title: 'Sous Chef', salary: 350 },
    { title: 'Celebrity Chef', salary: 800 },
  ] },
  { id: 'fitness', name: 'Fitness', mbaRequired: false, levels: [
    { title: 'Gym Trainer', salary: 170 },
    { title: 'Fitness Coach', salary: 330 },
    { title: 'Wellness Mogul', salary: 750 },
  ] },
  { id: 'tech', name: 'Tech', mbaRequired: false, levels: [
    { title: 'Junior Dev', salary: 280 },
    { title: 'Senior Engineer', salary: 600 },
    { title: 'CTO', salary: 1100 },
  ] },
];

const MBA_PRICE = 5000;
const SHIFTS_TO_PROMOTE = 5;

// --- v2: shift cap -----------------------------------------------------------
// Max work shifts per player per rolling window. Production window is 24h
// (SHIFT_WINDOW_MS env, default 86400000). The sim test compresses the
// window to keep the suite fast; the rule itself never changes.
const SHIFT_CAP = 3;

// --- v2: promotion gates ------------------------------------------------------
// Promotion requires BOTH the shift count AND cumulative playtime at the
// player's account (playSeconds, all sessions/ladders combined).
// Table (production seconds): L0→L1: 5 shifts + 60s; L1→L2: 5 shifts + 180s.
// PROMO_PLAYTIME_SCALE env (default 1) compresses thresholds for tests only.
const PROMOTION_GATES = {
  0: { shifts: 5, playSeconds: 60 },
  1: { shifts: 5, playSeconds: 180 },
};
function promotionGate(levelIndex, scale = 1) {
  const base = PROMOTION_GATES[levelIndex] || { shifts: 5, playSeconds: 0 };
  return {
    shifts: base.shifts,
    playSeconds: Math.max(0, Math.round(base.playSeconds * (scale || 1))),
  };
}

// --- v2: board ----------------------------------------------------------------
// 40 tiles, one tile per $10,000 of net worth. Crown at tile 39 ($400,000).
const BOARD_TILES = 40;
const BOARD_STEP = 10000;

// --- v2: tile milestone rewards ----------------------------------------------
// Granted the FIRST time a player's pawn reaches or passes the tile.
// Cash rewards add to cash; the exclusive car is granted once and can
// NEVER be bought in the catalog (it is not a catalog car).
const TILE_REWARDS = [
  { tile: 5,  kind: 'cash', amount: 1000, title: 'Lucky Break',    text: 'You landed on a Lucky Break tile — +$1,000!' },
  { tile: 10, kind: 'cash', amount: 2500, title: 'Cash Bonus',     text: 'You landed on a Cash Bonus tile — +$2,500!' },
  { tile: 15, kind: 'tax',  amount: 5000, title: 'Tax Return',     text: 'Tax return season! The refund lands — +$5,000!' },
  { tile: 20, kind: 'car',  carId: 'pulse-phantom', name: 'Pulse Phantom', price: 30000,
    title: 'Exclusive Ride', text: 'You unlocked the EXCLUSIVE Pulse Phantom — it cannot be bought anywhere else!' },
  { tile: 25, kind: 'cash', amount: 7500, title: 'Jackpot Tile',   text: 'You landed on a Jackpot tile — +$7,500!' },
];
const EXCLUSIVE_CAR = {
  id: 'pulse-phantom', name: 'Pulse Phantom', price: 30000, exclusive: true,
};

// --- v2: home utilities --------------------------------------------------------
// Every UTILITY_INTERVAL_DAYS day-cycles (default 30), each owned home
// (listed or not) is charged UTILITY_RATE of its current value, deducted
// from cash floored at $0. No debt is ever carried.
const UTILITY_RATE = 0.02;

// --- v2: real catalog photos ---------------------------------------------------
// Direct images.unsplash.com URLs (verified live, HTTP 200). No picsum
// placeholders, no deprecated source.unsplash.com. Every home and car
// carries its own photo; the exclusive car has one too.
const U = (id) => `https://images.unsplash.com/${id}?w=800&q=80&auto=format&fit=crop`;
const PHOTOS = {
  'maple-court': U('photo-1568605114967-8130f3a36994'),
  'neon-loft': U('photo-1502672260266-1c1ef2d93688'),
  'palm-villa': U('photo-1512917774080-9991f1c4c750'),
  'skyline-condo': U('photo-1545324418-cc1a3fa10c00'),
  'gold-coast': U('photo-1564013799919-ab600027ffc6'),
  'baddie-penthouse': U('photo-1600607687939-ce8a6c25118c'),
  'sunset-estate': U('photo-1600596542815-ffad4c1539a9'),
  'pulse-palace': U('photo-1600585154340-be6161a56a0c'),
  'city-cruiser': U('photo-1549317661-bd32c8ce0db2'),
  'neon-coupe': U('photo-1503376780353-7e6692767b70'),
  'gold-suv': U('photo-1519641471654-76ce0107ad1b'),
  'pink-phantom': U('photo-1552519507-da3b142c6e3d'),
  'diamond-gt': U('photo-1555215695-3004980ad54e'),
  'crown-royale': U('photo-1563720223185-11003d516935'),
  'jet-setter': U('photo-1540962351504-03099e0a754b'),
  'pulse-phantom': U('photo-1617531653332-bd46c24f2068'),
};
function photo(id) { return PHOTOS[id] || ''; }

const LIFE_EVENTS = [
  { title: 'Cash Windfall', text: 'A surprise payout lands in your account!', delta: 250 },
  { title: 'Side Gig Bonus', text: 'Your side gig paid out extra this week!', delta: 500 },
  { title: 'Viral Moment', text: 'Your content went viral — cha-ching!', delta: 1000 },
  { title: 'Car Repair', text: 'Ouch — the car needed emergency repairs.', delta: -200 },
  { title: 'Rent Spike Bonus', text: 'Rents are up — extra income this cycle!', delta: 300 },
  { title: 'Market Dip', text: 'The market dipped and took a bite.', delta: -400 },
  { title: 'Birthday Gifts', text: 'Happy birthday! Gifts poured in!', delta: 750 },
  { title: 'Luxury Tax', text: 'The tax collector came for the luxe life.', delta: -600 },
];

const MILESTONES = [
  'first-login', 'first-job', 'first-promotion', 'first-home', 'first-car',
  'first-sale', 'mba', 'ceo', 'rich-50k', 'rich-100k', 'top1',
];

const PAWN_COLORS = ['#ff2d78', '#f5c542', '#a855f7', '#22d3ee', '#34d399', '#fb923c', '#f472b6', '#60a5fa'];

// Deterministic pawn color from a name hash (no external dependency).
function pawnColor(name) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return PAWN_COLORS[h % PAWN_COLORS.length];
}

function getHome(id) { return HOMES.find((h) => h.id === id) || null; }
function getCar(id) { return CARS.find((c) => c.id === id) || null; }
function getCareer(id) { return CAREERS.find((c) => c.id === id) || null; }

// Merge admin overrides (from store meta 'catalog') over defaults.
// overrides shape: { homes: { id: { price?, rent?, appreciation?, stock? } },
//                    cars:  { id: { price?, stock? } } }
// Stock in overrides/snapshot = REMAINING units (null = unlimited).
function applyOverrides(overrides) {
  const o = overrides || {};
  const homes = HOMES.map((h) => ({
    ...h,
    ...(o.homes && o.homes[h.id] ? o.homes[h.id] : {}),
    photo: photo(h.id),
  }));
  const cars = CARS.map((c) => ({
    ...c,
    ...(o.cars && o.cars[c.id] ? o.cars[c.id] : {}),
    photo: photo(c.id),
  }));
  const careers = CAREERS.map((c) => ({ ...c, levels: c.levels.map((l) => ({ ...l })) }));
  return {
    homes, cars, careers,
    board: { tiles: BOARD_TILES, step: BOARD_STEP },
    tileRewards: TILE_REWARDS.map((t) => ({ ...t })),
    exclusiveCar: { ...EXCLUSIVE_CAR, photo: photo(EXCLUSIVE_CAR.id) },
  };
}

function defaultOverrides() {
  const homes = {};
  const cars = {};
  for (const h of HOMES) homes[h.id] = { stock: h.stock };
  for (const c of CARS) cars[c.id] = { stock: c.stock };
  return { homes, cars };
}

module.exports = {
  HOMES, CARS, CAREERS, MBA_PRICE, SHIFTS_TO_PROMOTE,
  SHIFT_CAP, PROMOTION_GATES, promotionGate,
  BOARD_TILES, BOARD_STEP, TILE_REWARDS, EXCLUSIVE_CAR, UTILITY_RATE,
  PHOTOS,
  LIFE_EVENTS, MILESTONES, photo, pawnColor,
  getHome, getCar, getCareer, applyOverrides, defaultOverrides,
};
