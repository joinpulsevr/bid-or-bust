// ============================================================================
// PulseVR Life — seed data (CONTRACT §3). SERVER ONLY.
// This file contains real member IDs and admin IDs. It must NEVER be copied
// into public/, sent to any client, or published in a public repo. The repo
// MUST stay private (see DEPLOY_WALKTHROUGH.md).
// Seeding runs ONLY when a table is empty; after first boot the database
// is the source of truth and this file is never consulted again.
// ============================================================================

const { newPlayer } = require('./game');
const { defaultOverrides } = require('./catalog');

// display name — tier — member ID
const MEMBERS = [
  ['Blue Diamond', 'Elite', 'PVR34079'],
  ['Bwonderful', 'Elite', 'PVR97401'],
  ['Carebear', 'VIP', 'PVR17343'],
  ['Charles', 'Elite', 'PVR77031'],
  ['Chrissy', 'Elite', 'PVR04834'],
  ['DaLboogie', 'Elite', 'PVR43913'],
  ['Denise Cool', 'Elite', 'PVR78269'],
  ['DrKharma', 'Rising Star', 'PVR30955'],
  ['Edgy Guppy', 'Elite', 'PVR05390'],
  ['EmKay', 'Elite', 'PVR68253'],
  ['Gdeuce', 'Rookie', 'PVR00478'],
  ['Inerpeace', 'Elite', 'PVR91560'],
  ['Itz Simpleeee', 'Elite', 'PVR65872'],
  ['Kay Kay', 'Elite', 'PVR14011'],
  ['Kyng Rob', 'VIP', 'PVR09061'],
  ['LadyBug', 'VIP', 'PVR78496'],
  ['Paris', 'Elite', 'PVR90505'],
  ['Rasheed', 'VIP', 'PVR47271'],
  ['Shalashae', 'Rookie', 'PVR88068'],
  ['Stacie D.', 'Elite', 'PVR12433'],
  ['Stoic', 'Elite', 'PVR99423'],
  ["That's Robyn", 'Elite', 'PVR68244'],
  ['Tightwork', 'Elite', 'PVR47287'],
  ['Trendi', 'VIP', 'PVR83655'],
  ['Twan', 'Elite', 'PVR80459'],
  ['Wicked Kitten', 'Rising Star', 'PVR45856'],
];

// Admins get NO player record (CONTRACT §3).
const ADMINS = [
  { adminId: 'ADM739214', name: 'CoolVibez', token: null },
  { adminId: 'ADM518407', name: 'Nimmie', token: null },
  { adminId: 'ADM926351', name: 'ReeseCup', token: null },
];

async function seedIfEmpty(store) {
  const seeded = { members: 0, admins: 0 };
  const members = await store.getAllMembers();
  if (members.length === 0) {
    for (const [name, tier, memberId] of MEMBERS) {
      await store.saveMember(newPlayer({ name, tier, memberId }));
      seeded.members += 1;
    }
  }
  const admins = await store.getAllAdmins();
  if (admins.length === 0) {
    for (const a of ADMINS) {
      await store.saveAdmin({ ...a });
      seeded.admins += 1;
    }
  }
  const catalog = await store.getMeta('catalog');
  if (!catalog) await store.setMeta('catalog', defaultOverrides());
  const day = await store.getMeta('day');
  if (day === null || day === undefined) await store.setMeta('day', 1);
  return seeded;
}

module.exports = { MEMBERS, ADMINS, seedIfEmpty };
