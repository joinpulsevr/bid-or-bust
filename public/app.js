// PulseVR Life — single-page client.
// All game data arrives over the live socket connection only.
// Nothing in this file contains another player's details: the only
// personal detail ever displayed is the signed-in user's own, as
// returned by the server for that session.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    socket: null, role: null, player: null, admin: null,
    catalog: null, leaderboard: [], listings: [], day: 1, connected: false,
    mail: [], unread: 0
  };

  function money(n) {
    n = Number(n || 0);
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(title, text) {
    var box = $('toasts'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<strong>' + esc(title) + '</strong><small>' + esc(text || '') + '</small>';
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 8000);
  }
  function showView(id) {
    ['view-landing', 'view-auth', 'view-game', 'view-admin'].forEach(function (v) {
      var el = $(v); if (el) el.classList.toggle('hidden', v !== id);
    });
    var lo = $('logoutBtn'); if (lo) lo.classList.toggle('hidden', id === 'view-landing' || id === 'view-auth');
    var mb = $('mailBtn'); if (mb) mb.classList.toggle('hidden', id !== 'view-game');
    window.scrollTo(0, 0);
  }
  function setStatus(text) { var s = $('serverStatus'); if (s) s.textContent = text; }
  function showAuthError(msg) {
    var e = $('authError'); if (!e) return;
    e.textContent = msg; e.classList.remove('hidden');
  }
  function setAuthTab(isAdmin) {
    $('tabMember').classList.toggle('active', !isAdmin);
    $('tabAdmin').classList.toggle('active', isAdmin);
    $('tabMember').setAttribute('aria-selected', String(!isAdmin));
    $('tabAdmin').setAttribute('aria-selected', String(isAdmin));
    $('memberForm').classList.toggle('hidden', isAdmin);
    $('adminForm').classList.toggle('hidden', !isAdmin);
  }
  function avatarFor(name) {
    var label = String(name || '?').trim();
    var initials = label.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase() || '?';
    var h = 0; for (var i = 0; i < label.length; i++) { h = (h * 31 + label.charCodeAt(i)) >>> 0; }
    var hue = h % 360;
    return { initials: initials, bg: 'linear-gradient(135deg,hsl(' + hue + ',80%,45%),hsl(' + ((hue + 60) % 360) + ',85%,55%))' };
  }
  function renderAvatar(el, name, pawnColor) {
    if (!el) return;
    var a = avatarFor(name);
    el.textContent = a.initials;
    el.style.background = pawnColor ? pawnColor : a.bg;
  }
  function stockBadge(stock) {
    if (stock == null) return '<span class="stock">In stock</span>';
    if (stock <= 0) return '<span class="stock out">⛔ SOLD OUT</span>';
    if (stock === 1) return '<span class="stock last">🔥 LAST ONE — ' + stock + ' left</span>';
    return '<span class="stock">' + stock + ' left</span>';
  }

  // ---------- Socket connection ----------
  function connect() {
    if (typeof io === 'undefined') {
      setStatus('Live server not reached — page still loads standalone');
      return null;
    }
    if (state.socket) return state.socket;
    var socket = io();
    state.socket = socket;
    socket.on('connect', function () {
      state.connected = true; setStatus('● Live');
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem('pvl_session') || 'null'); } catch (e) { saved = null; }
      if (saved && saved.token) socket.emit('auth:login', { role: saved.role, token: saved.token });
    });
    socket.on('disconnect', function () { state.connected = false; setStatus('Reconnecting…'); });
    socket.on('connect_error', function () { setStatus('Live server not reached'); });

    socket.on('auth:result', function (res) {
      if (!res || !res.ok) { showAuthError((res && res.error) || 'Sign-in failed. Please try again.'); return; }
      state.role = res.role;
      try {
        if (res.token) localStorage.setItem('pvl_session', JSON.stringify({ role: res.role, token: res.token }));
      } catch (e) { /* storage unavailable; session lasts until refresh */ }
      if (res.catalog) { state.catalog = res.catalog; renderCatalog(); }
      if (res.leaderboard) { state.leaderboard = res.leaderboard; renderLeaderboard(); }
      if (res.marketplace) { state.listings = res.marketplace; renderMarketplace(); }
      if (res.day != null) { state.day = res.day; renderDay(); }
      if (res.role === 'admin') {
        state.admin = res.admin || {};
        showView('view-admin');
        var rc = $('resetCard');
        if (rc) rc.classList.toggle('hidden', !(state.admin && state.admin.name === 'CoolVibez'));
        socket.emit('admin:ledger', {});
        socket.emit('admin:standings', {});
      } else {
        if (res.player) { state.player = res.player; renderPlayer(); }
        showView('view-game');
      }
    });
    socket.on('player:state', function (res) {
      if (res && res.player) { state.player = res.player; renderPlayer(); }
    });
    socket.on('game:leaderboard', function (res) {
      if (res && res.leaderboard) { state.leaderboard = res.leaderboard; renderLeaderboard(); }
    });
    socket.on('game:marketplace', function (res) {
      if (res && res.listings) { state.listings = res.listings; renderMarketplace(); }
    });
    socket.on('game:catalog', function (res) {
      if (res && res.catalog) { state.catalog = res.catalog; renderCatalog(); }
    });
    socket.on('game:day', function (res) {
      if (res && res.day != null) { state.day = res.day; renderDay(); }
    });
    socket.on('game:event', function (ev) {
      if (!ev) return;
      toast(ev.title || 'Life event', (ev.text || '') + (ev.delta != null ? ' (' + (ev.delta >= 0 ? '+' : '') + money(ev.delta) + ')' : ''));
    });
    socket.on('mail:inbox', function (res) {
      if (!res) return;
      state.mail = res.messages || [];
      state.unread = res.unread || 0;
      renderMailBadge();
      renderMail();
    });
    socket.on('mail:new', function (res) {
      if (!res) return;
      state.unread = res.unread || 0;
      renderMailBadge();
      toast('📧 New mail', 'From ' + (res.fromName || 'a player') + (res.subject ? ': ' + res.subject : ''));
    });
    socket.on('mail:sent', function () {
      toast('Message sent', 'Your private message is on its way.');
      var m = $('mailMsg'); if (m) m.textContent = 'Message sent!';
    });
    socket.on('admin:ledgerData', function (res) { if (res) renderLedger(res); });
    socket.on('admin:standingsData', function (res) { if (res && res.standings) renderStandings(res.standings); });
    socket.on('admin:exportData', function (res) {
      if (res && res.csv != null) downloadCsv(res.kind || 'export', res.csv);
    });
    socket.on('admin:opResult', function (res) {
      if (res) toast(res.ok ? 'Done' : 'Could not complete', res.message || '');
      if (res && res.ok) { socket.emit('admin:ledger', {}); socket.emit('admin:standings', {}); }
    });
    socket.on('error', function (err) {
      toast('Something went wrong', (err && err.message) || 'Please try again.');
    });
    return socket;
  }
  function emit(name, payload) {
    var s = connect();
    if (!s || !state.connected) { toast('Not connected yet', 'The live server is not reachable right now. Please try again in a moment.'); return false; }
    s.emit(name, payload || {});
    return true;
  }
  function login(role, idValue) {
    var s = connect();
    if (!s) { showAuthError('The live server is not reachable right now. Please try again in a moment.'); return; }
    if (!state.connected) { showAuthError('Still connecting to the live server — please try again in a moment.'); return; }
    s.emit('auth:login', { role: role, id: idValue });
  }
  function downloadCsv(kind, csv) {
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pulsevr-life-' + kind + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- Player rendering (server payloads only) ----------
  function renderDay() { var d = $('dayBadge'); if (d) d.textContent = 'Day ' + state.day; }
  function renderPlayer() {
    var p = state.player; if (!p) return;
    $('playerName').textContent = p.name || 'Player';
    $('playerTier').textContent = p.tier || '';
    $('playerPoints').textContent = (p.points || 0) + ' pts';
    $('ownId').textContent = p.memberId || '';
    $('cashVal').textContent = money(p.cash);
    $('netWorthVal').textContent = money(p.netWorth);
    $('playTimeVal').textContent = (p.playSeconds || 0) + 's';
    renderAvatar($('playerAvatar'), p.name, null);
    renderBoard(p.boardPosition || 0, p.claimedTiles || []);
    renderCareer(p);
    renderOwned(p);
  }
  function renderBoard(pos, claimedTiles) {
    var path = $('boardPath'); if (!path) return;
    var claimed = {};
    (claimedTiles || []).forEach(function (t) { claimed[t] = true; });
    var rewards = {};
    if (state.catalog && state.catalog.tileRewards) {
      state.catalog.tileRewards.forEach(function (r) { rewards[r.tile] = r; });
    }
    var total = (state.catalog && state.catalog.board && state.catalog.board.tiles) || 40;
    var html = '';
    for (var i = 0; i < total; i++) {
      var cls = 'board-space' + (i < pos ? ' reached' : '') + (i === pos ? ' current' : '') + (rewards[i] ? ' reward' : '');
      var mark;
      if (i === pos) mark = '♟️';
      else if (rewards[i]) mark = claimed[i] ? '✅' : '🎁';
      else if (i === total - 1) mark = '👑';
      else if (i === 0) mark = '🏁';
      else mark = '·';
      html += '<div class="' + cls + '" title="' + (rewards[i] ? esc(rewards[i].title) : '') + '">' + mark + '<span class="num">' + (i + 1) + '</span></div>';
    }
    path.innerHTML = html;
  }
  function renderCareer(p) {
    var status = $('careerStatus'); if (!status) return;
    var cat = state.catalog;
    var ladder = null;
    if (cat && cat.careers) {
      for (var i = 0; i < cat.careers.length; i++) { if (cat.careers[i].id === p.career) ladder = cat.careers[i]; }
    }
    var gates = (cat && cat.promotionGates) || { 0: { shifts: 5, playSeconds: 60 }, 1: { shifts: 5, playSeconds: 180 } };
    var gate = gates[p.careerLevel] || { shifts: 5, playSeconds: 0 };
    var shiftsUsed = (p.shiftHistory || []).length;
    status.textContent = p.careerLevel != null
      ? 'Current: ' + p.careerTitle + ' — shifts at this level: ' + (p.shiftsAtLevel || 0) + ' (promotion needs ' + gate.shifts + ' shifts + ' + gate.playSeconds + 's playtime) · Shifts used (24h): ' + shiftsUsed + '/3'
      : 'Pick a career ladder to start earning.';
    var levelsEl = $('careerLevels');
    if (ladder && ladder.levels) {
      levelsEl.innerHTML = ladder.levels.map(function (lv) {
        return '<div class="career-level' + (lv.title === p.careerTitle ? ' active' : '') + '"><span>' + esc(lv.title) + '</span><strong>' + money(lv.salary) + ' / shift</strong></div>';
      }).join('');
    } else { levelsEl.innerHTML = ''; }
    var note = $('careerNote');
    if (note) note.textContent = p.mba ? 'MBA unlocked — the CEO ladder is open to you.' : 'The CEO ladder requires a one-time MBA purchase.';
    var sel = $('careerSelect');
    if (cat && cat.careers && sel && !sel.dataset.filled) {
      sel.innerHTML = cat.careers.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.mbaRequired ? ' (needs MBA)' : '') + '</option>'; }).join('');
      sel.dataset.filled = '1';
    }
    if (sel && p.career) sel.value = p.career;
    var pb = $('promoteBtn');
    if (pb) pb.disabled = !(p.careerLevel != null && (p.shiftsAtLevel || 0) >= gate.shifts && (p.playSeconds || 0) >= gate.playSeconds);
    var mb = $('mbaBtn'); if (mb) mb.disabled = !!p.mba;
  }
  function renderOwned(p) {
    var homesEl = $('ownedHomes');
    if (homesEl) {
      if (!p.homes || !p.homes.length) { homesEl.innerHTML = '<p class="muted">You do not own any homes yet.</p>'; }
      else {
        homesEl.innerHTML = p.homes.map(function (h, idx) {
          var listed = h.listedPrice != null;
          return '<div class="owned-row"><span>🏠 ' + esc(h.name) + ' — value ' + money(h.value) + ' · rent ' + money(h.rent) + '/day' + (listed ? ' · listed at ' + money(h.listedPrice) : '') + '</span>' +
            (listed ? '' : '<input class="price-input" type="number" min="100" placeholder="Listing price" data-list-price="' + idx + '">') +
            (listed ? '' : '<button class="btn btn-gold" type="button" data-list-home="' + idx + '">List for sale</button>') + '</div>';
        }).join('');
        homesEl.querySelectorAll('[data-list-home]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var idx = Number(btn.getAttribute('data-list-home'));
            var input = homesEl.querySelector('[data-list-price="' + idx + '"]');
            var price = input ? Number(input.value) : 0;
            var home = state.player.homes[idx];
            if (!home || !price || price <= 0) { toast('Listing price needed', 'Enter a positive price first.'); return; }
            emit('player:listHome', { homeId: home.homeId, price: Math.round(price) });
          });
        });
      }
    }
    var carsEl = $('ownedCars');
    if (carsEl) {
      if (!p.cars || !p.cars.length) { carsEl.innerHTML = '<p class="muted">You do not own any cars yet.</p>'; }
      else carsEl.innerHTML = p.cars.map(function (c) { return '<div class="owned-row"><span>🚗 ' + esc(c.name) + ' — ' + money(c.price) + '</span></div>'; }).join('');
    }
  }
  function renderCatalog() {
    var cat = state.catalog; if (!cat) return;
    var homesEl = $('homesGrid');
    if (homesEl) {
      if (!cat.homes || !cat.homes.length) { homesEl.innerHTML = '<p class="muted">No homes in the catalog yet.</p>'; }
      else {
        homesEl.innerHTML = cat.homes.map(function (h) {
          return '<article class="deed"><img src="' + esc(h.photo || '') + '" alt="" onerror="this.style.display=\'none\'">' +
            '<div class="deed-body"><h4>🏠 ' + esc(h.name) + '</h4>' +
            '<div class="deed-price">' + money(h.price) + '</div>' +
            '<p>Rent ' + money(h.rent) + ' / day · Grows ' + (h.appreciation != null ? (Number(h.appreciation) * 100).toFixed(1) + '% / day' : '—') + '</p>' +
            stockBadge(h.stock) +
            '<button class="btn btn-gold" type="button" data-buy-home="' + esc(h.id) + '"' + (h.stock === 0 ? ' disabled' : '') + '>Buy Home</button></div></article>';
        }).join('');
        homesEl.querySelectorAll('[data-buy-home]').forEach(function (btn) {
          btn.addEventListener('click', function () { emit('player:buyHome', { homeId: btn.getAttribute('data-buy-home') }); });
        });
      }
    }
    var carsEl = $('carsGrid');
    if (carsEl) {
      if (!cat.cars || !cat.cars.length) { carsEl.innerHTML = '<p class="muted">No cars in the catalog yet.</p>'; }
      else {
        carsEl.innerHTML = cat.cars.map(function (c) {
          return '<article class="deed"><img src="' + esc(c.photo || '') + '" alt="" onerror="this.style.display=\'none\'">' +
            '<div class="deed-body"><h4>🚗 ' + esc(c.name) + '</h4>' +
            '<div class="deed-price">' + money(c.price) + '</div>' +
            stockBadge(c.stock) +
            '<button class="btn btn-gold" type="button" data-buy-car="' + esc(c.id) + '"' + (c.stock === 0 ? ' disabled' : '') + '>Buy Car</button></div></article>';
        }).join('');
        carsEl.querySelectorAll('[data-buy-car]').forEach(function (btn) {
          btn.addEventListener('click', function () { emit('player:buyCar', { carId: btn.getAttribute('data-buy-car') }); });
        });
      }
    }
    if (state.player) renderCareer(state.player);
    renderCatalogControls();
  }
  function renderLeaderboard() {
    var list = $('leaderboardList'); if (!list) return;
    if (!state.leaderboard.length) { list.innerHTML = '<li><span class="muted">Leaderboard loads from the live server.</span></li>'; return; }
    list.innerHTML = state.leaderboard.map(function (e) {
      var av = avatarFor(e.name);
      return '<li class="' + (e.crown ? 'first' : '') + '">' +
        '<span class="avatar avatar-sm" style="background:' + (e.pawnColor || av.bg) + '">' + av.initials + '</span>' +
        '<div class="lb-meta"><strong>' + (e.crown ? '👑 ' : '') + esc(e.name) + '</strong><span>' + esc(e.tier || '') + ' · ' + (e.homes || 0) + ' homes · ' + (e.cars || 0) + ' cars · ' + (e.points || 0) + ' pts</span></div>' +
        '<div class="lb-worth">' + money(e.netWorth) + '<br><span style="font-size:12px;color:var(--muted)">#' + (e.rank || '') + '</span></div></li>';
    }).join('');
  }
  function renderMarketplace() {
    var el = $('marketList'); if (!el) return;
    if (!state.listings.length) { el.innerHTML = '<p class="muted">No homes listed for sale right now.</p>'; return; }
    el.innerHTML = state.listings.map(function (l) {
      return '<div class="market-row"><span>🏠 ' + esc(l.homeName) + ' — listed at ' + money(l.price) + ' (value ' + money(l.value) + ')<br><small style="color:var(--muted)">Seller: ' + esc(l.sellerName) + '</small></span>' +
        '<button class="btn btn-gold" type="button" data-buy-listing="' + esc(l.id) + '">Buy</button></div>';
    }).join('');
    el.querySelectorAll('[data-buy-listing]').forEach(function (btn) {
      btn.addEventListener('click', function () { emit('player:buyListing', { listingId: btn.getAttribute('data-buy-listing') }); });
    });
  }

  // ---------- v2: mail + wallet rendering ----------
  function renderMailBadge() {
    var b = $('mailBadge'); if (!b) return;
    b.textContent = String(state.unread || 0);
    b.classList.toggle('hidden', !(state.unread > 0));
  }
  function renderMail() {
    var el = $('mailList'); if (!el) return;
    if (!state.mail.length) { el.innerHTML = '<p class="muted">No messages yet.</p>'; return; }
    var me = state.player ? state.player.name : '';
    el.innerHTML = state.mail.map(function (m) {
      var incoming = m.toName === me;
      var unread = incoming && !m.read;
      return '<div class="mail-row' + (unread ? ' unread' : '') + '" data-read-mail="' + esc(m.id) + '">' +
        '<strong>' + (unread ? '🆕 ' : '') + (incoming ? 'From ' + esc(m.fromName) : 'To ' + esc(m.toName)) + '</strong>' +
        (m.subject ? ' — ' + esc(m.subject) : '') +
        '<div class="mail-body">' + esc(m.body) + '</div>' +
        '<small class="muted">' + esc(m.createdAt || '') + (incoming ? ' · click to mark read' : '') + '</small></div>';
    }).join('');
    el.querySelectorAll('[data-read-mail]').forEach(function (row) {
      row.addEventListener('click', function () {
        emit('player:readMail', { id: row.getAttribute('data-read-mail') });
      });
    });
  }
  function renderWallet() {
    var body = $('walletBody'); if (!body) return;
    var p = state.player; if (!p) { body.innerHTML = '<p class="muted">Wallet loads from the live server.</p>'; return; }
    var w = p.wallet || {};
    var homes = w.homes || p.homes || [];
    var cars = w.cars || p.cars || [];
    var html = '<div class="wallet-row"><span>Cash</span><strong>' + money(w.cash != null ? w.cash : p.cash) + '</strong></div>' +
      '<div class="wallet-row"><span>Net Worth</span><strong>' + money(w.netWorth != null ? w.netWorth : p.netWorth) + '</strong></div>' +
      '<h4>Homes (' + homes.length + ')</h4>' +
      (homes.length ? homes.map(function (h) {
        return '<div class="wallet-row"><span>🏠 ' + esc(h.name) + '</span><span>value ' + money(h.value) + ' · rent ' + money(h.rent) + '/day</span></div>';
      }).join('') : '<p class="muted">No homes yet.</p>') +
      '<h4>Cars (' + cars.length + ')</h4>' +
      (cars.length ? cars.map(function (c) {
        return '<div class="wallet-row"><span>🚗 ' + esc(c.name) + (c.exclusive ? ' 👑 EXCLUSIVE' : '') + '</span><span>' + money(c.price) + '</span></div>';
      }).join('') : '<p class="muted">No cars yet.</p>') +
      '<div class="wallet-row"><span>Next utility charge</span><strong>' +
      money(w.nextUtilityCharge || 0) + (w.nextUtilityDay != null ? ' · day ' + w.nextUtilityDay : ' · no homes') + '</strong></div>';
    body.innerHTML = html;
  }

  // ---------- Admin rendering (server payloads only) ----------
  function renderLedger(res) {
    var tbody = $('ledgerTable').querySelector('tbody');
    var players = res.players || [];
    tbody.innerHTML = players.length ? players.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.tier || '') + '</td><td>' + (p.points || 0) + '</td><td>' + (p.playSeconds || 0) + '</td><td>' + money(p.netWorth) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted">No players in the ledger.</td></tr>';
    var removedEl = $('removedList');
    var removed = res.removed || [];
    if (!removed.length) { removedEl.innerHTML = '<p class="muted">No removed players.</p>'; }
    else {
      removedEl.innerHTML = removed.map(function (r) {
        return '<div class="manage-row"><span>🚫 ' + esc(r.name) + ' — removed ' + esc(r.removedAt || '') + ' · restore by ' + esc(r.restoreDeadline || '') + ' (' + (r.daysLeft != null ? r.daysLeft + ' days left' : '—') + ')</span>' +
          '<button class="btn btn-gold" type="button" data-restore="' + esc(r.memberId) + '">Restore</button></div>';
      }).join('');
      removedEl.querySelectorAll('[data-restore]').forEach(function (btn) {
        btn.addEventListener('click', function () { emit('admin:restorePlayer', { memberId: btn.getAttribute('data-restore') }); });
      });
    }
    var manageEl = $('manageList');
    if (!players.length) { manageEl.innerHTML = '<p class="muted">Player management rows appear here once the ledger loads.</p>'; }
    else {
      manageEl.innerHTML = players.map(function (p) {
        return '<div class="manage-row"><span>' + esc(p.name) + ' — ' + esc(p.tier || '') + ' · ' + (p.points || 0) + ' pts</span>' +
          (p.memberId ? '<button class="btn btn-pink" type="button" data-remove="' + esc(p.memberId) + '">Remove</button>' : '') + '</div>';
      }).join('');
      manageEl.querySelectorAll('[data-remove]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (confirm('Remove this player? They will not be able to sign in until restored.')) emit('admin:removePlayer', { memberId: btn.getAttribute('data-remove') });
        });
      });
    }
  }
  function renderStandings(standings) {
    var tbody = $('standingsTable').querySelector('tbody');
    tbody.innerHTML = standings.length ? standings.map(function (s) {
      return '<tr><td>' + (s.rank || '') + '</td><td>' + esc(s.name) + '</td><td>' + esc(s.tier || '') + '</td><td>' + money(s.netWorth) + '</td><td>' + (s.homes || 0) + '</td><td>' + (s.cars || 0) + '</td><td>' + (s.points || 0) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">No standings yet.</td></tr>';
  }
  function renderCatalogControls() {
    var el = $('catalogControls'); if (!el || !state.catalog) return;
    var rows = '';
    (state.catalog.homes || []).forEach(function (h) {
      rows += '<div class="catalog-row"><strong>🏠 ' + esc(h.name) + '</strong>' +
        '<label>Price <input type="number" data-cat="home" data-id="' + esc(h.id) + '" data-field="price" value="' + (h.price || 0) + '"></label>' +
        '<label>Rent <input type="number" data-cat="home" data-id="' + esc(h.id) + '" data-field="rent" value="' + (h.rent || 0) + '"></label>' +
        '<label>Stock <input type="number" data-cat="home" data-id="' + esc(h.id) + '" data-field="stock" value="' + (h.stock == null ? '' : h.stock) + '" placeholder="Unlimited"></label>' +
        '<button class="btn btn-gold" type="button" data-save-cat="home" data-id="' + esc(h.id) + '">Save</button></div>';
    });
    (state.catalog.cars || []).forEach(function (c) {
      rows += '<div class="catalog-row"><strong>🚗 ' + esc(c.name) + '</strong>' +
        '<label>Price <input type="number" data-cat="car" data-id="' + esc(c.id) + '" data-field="price" value="' + (c.price || 0) + '"></label>' +
        '<label>Stock <input type="number" data-cat="car" data-id="' + esc(c.id) + '" data-field="stock" value="' + (c.stock == null ? '' : c.stock) + '" placeholder="Unlimited"></label>' +
        '<span></span><button class="btn btn-gold" type="button" data-save-cat="car" data-id="' + esc(c.id) + '">Save</button></div>';
    });
    el.innerHTML = rows || '<p class="muted">Catalog controls load from the live server.</p>';
    el.querySelectorAll('[data-save-cat]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-save-cat'); var id = btn.getAttribute('data-id');
        var fields = {};
        el.querySelectorAll('[data-cat="' + type + '"][data-id="' + id + '"]').forEach(function (inp) {
          if (inp.value !== '') fields[inp.getAttribute('data-field')] = Number(inp.value);
        });
        emit('admin:updateCatalog', { type: type, id: id, fields: fields });
      });
    });
  }

  // ---------- Wiring ----------
  $('playNowBtn').addEventListener('click', function () { showView('view-auth'); connect(); });
  $('howToPlayBtn').addEventListener('click', function () { $('howToModal').classList.remove('hidden'); });
  $('howToCloseBtn').addEventListener('click', function () { $('howToModal').classList.add('hidden'); });
  $('walletBtn').addEventListener('click', function () { renderWallet(); $('walletModal').classList.remove('hidden'); });
  $('walletCloseBtn').addEventListener('click', function () { $('walletModal').classList.add('hidden'); });
  $('mailBtn').addEventListener('click', function () {
    emit('player:listMail', {});
    var card = $('mailCard'); if (card) card.scrollIntoView({ behavior: 'smooth' });
  });
  $('composeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var to = $('mailTo').value.trim();
    var subject = $('mailSubject').value.trim();
    var body = $('mailBody').value.trim();
    if (!to || !body) { $('mailMsg').textContent = 'Add a recipient and a message first.'; return; }
    if (emit('player:sendMessage', { toName: to, subject: subject, body: body })) {
      $('mailBody').value = '';
    }
  });
  $('resetPlayerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('resetMemberId').value.trim();
    if (!id) return;
    if (confirm('Reset ' + id + ' to a fresh start ($10,000, no homes/cars, careers reset)? This is PERMANENT and cannot be undone.')) {
      emit('admin:resetPlayer', { memberId: id, confirm: true });
      $('resetMsg').textContent = 'Request sent — watch for confirmation.';
    }
  });
  $('resetGameBtn').addEventListener('click', function () {
    if (confirm('Reset the ENTIRE game? Every player returns to a fresh start, all listings and messages are deleted, and the day counter resets. This is PERMANENT and cannot be undone.')) {
      emit('admin:resetGame', { confirm: true });
      $('resetMsg').textContent = 'Request sent — watch for confirmation.';
    }
  });
  $('backToLanding').addEventListener('click', function () { showView('view-landing'); });
  $('tabMember').addEventListener('click', function () { setAuthTab(false); });
  $('tabAdmin').addEventListener('click', function () { setAuthTab(true); });
  $('memberForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('memberIdInput').value.trim();
    if (!v) { showAuthError('Please enter your Member ID.'); return; }
    login('member', v);
  });
  $('adminForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('adminIdInput').value;
    if (!v) { showAuthError('Please enter your Admin ID.'); return; }
    login('admin', v);
  });
  $('logoutBtn').addEventListener('click', function () {
    var role = state.role;
    if (state.socket && state.connected) state.socket.emit(role === 'admin' ? 'admin:logout' : 'player:logout', {});
    try { localStorage.removeItem('pvl_session'); } catch (e) { /* ignore */ }
    state.role = null; state.player = null; state.admin = null;
    showView('view-landing');
  });
  $('workBtn').addEventListener('click', function () { emit('player:workShift', {}); });
  $('promoteBtn').addEventListener('click', function () { emit('player:promote', {}); });
  $('mbaBtn').addEventListener('click', function () { emit('player:buyMBA', {}); });
  $('switchCareerBtn').addEventListener('click', function () {
    var v = $('careerSelect').value;
    if (v) emit('player:switchCareer', { career: v });
  });
  $('refreshLedgerBtn').addEventListener('click', function () { emit('admin:ledger', {}); });
  $('refreshStandingsBtn').addEventListener('click', function () { emit('admin:standings', {}); });
  $('advanceDayBtn').addEventListener('click', function () { emit('admin:advanceDay', {}); });
  $('exportPointsBtn').addEventListener('click', function () { emit('admin:export', { kind: 'points' }); });
  $('exportStandingsBtn').addEventListener('click', function () { emit('admin:export', { kind: 'standings' }); });
  $('addMemberForm').addEventListener('submit', function (e) {
    e.preventDefault();
    emit('admin:addMember', { name: $('addName').value.trim(), tier: $('addTier').value, memberId: $('addMemberId').value.trim() });
  });
  $('changeIdForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (emit('admin:changeId', { newId: $('newAdminId').value })) $('changeIdMsg').textContent = 'Request sent — watch for confirmation.';
  });
  $('removeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    emit('admin:removePlayer', { memberId: $('removeMemberId').value.trim() });
  });

  // Initial render: landing + board skeleton, no server data assumed.
  renderBoard(0);
  renderDay();
  connect();
})();
