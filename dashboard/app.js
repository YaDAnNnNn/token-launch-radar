// Token Launch Radar — the dashboard. Reads window.RADAR (data.js, written beside
// dashboard/ by main.ts) and renders the ranked board, its filters, a per-protocol
// detail view with the model's working and the farm plan, and the already-trading set
// the multiples were calibrated from. No network: every byte shown is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var PAGE = 60;
  var state = { q: '', category: 'all', chain: 'all', watch: false, sort: 'implied', dir: -1, shown: PAGE, detail: null };

  // Deep links the screenshots use: #detail=<slug>, #category=<name>, #watchlist=1.
  function readHash() {
    var h = (location.hash || '').replace(/^#/, '');
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv.length !== 2) return;
      var k = decodeURIComponent(kv[0]), v = decodeURIComponent(kv[1]);
      if (k === 'detail') state.detail = v;
      if (k === 'category') state.category = v;
      if (k === 'chain') state.chain = v;
      if (k === 'watchlist') state.watch = v === '1';
    });
  }

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days, assumed) {
    if (days === null || days === undefined) return 'unknown';
    var s = days >= 365 ? (days / 365).toFixed(1) + 'y' : Math.max(0, Math.round(days)) + 'd';
    return assumed ? s + ' (assumed)' : s;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function calibFor(category) {
    var key = category || 'Uncategorized';
    for (var i = 0; i < DATA.calibration.categories.length; i++) {
      if (DATA.calibration.categories[i].category === key) return DATA.calibration.categories[i];
    }
    return { category: key, samples: 0, median_ratio: DATA.calibration.global_multiple, multiple: DATA.calibration.global_multiple };
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorized') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = {
      implied: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; },
      growth: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days === null ? -1 : r.age_days; },
      rank: function (r) { return r.rank; },
    }[state.sort];
    rows.sort(function (a, b) { return (key(a) - key(b)) * (state.dir === -1 ? -1 : 1) || a.rank - b.rank; });
    return rows;
  }

  function masthead(compact) {
    if (compact) {
      return (
        '<div class="masthead"><div>' +
        '<p class="eyebrow">Token Launch Radar · model ' + esc(DATA.model_version) + '</p>' +
        '<h1 style="font-size:24px">Pre-token protocols, <span class="thin">ranked by what a launch could be worth</span></h1>' +
        '</div></div>'
      );
    }
    return (
      '<div class="masthead"><div>' +
      '<p class="eyebrow">Token Launch Radar · model ' + esc(DATA.model_version) + '</p>' +
      '<h1>Pre-token protocols, <span class="thin">ranked by what a launch could be worth</span></h1>' +
      '<p class="lede">Every protocol here <strong>records no token yet</strong> in the sealed DefiLlama snapshot of ' +
      esc(DATA.as_of) + '. Each is priced by a model calibrated on the protocols whose tokens already trade — ' +
      'never by a hand-picked list of names.</p></div>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + DATA.board_size + '</b><span>ranked</span></div>' +
      '<div class="stat"><b>' + DATA.watchlist_size + '</b><span>watchlist</span></div>' +
      '<div class="stat"><b>' + DATA.early_size + '</b><span>early finds</span></div>' +
      '<div class="stat"><b>' + DATA.calibration.live_protocols + '</b><span>live calibrators</span></div>' +
      '</div></div>'
    );
  }

  function modelBox() {
    var chips = DATA.calibration.categories
      .filter(function (c) { return c.samples >= 8; })
      .sort(function (a, b) { return b.samples - a.samples; })
      .slice(0, 8)
      .map(function (c) { return '<span class="chip">' + esc(c.category) + ' <b>×' + c.multiple.toFixed(2) + '</b> · ' + c.samples + ' live</span>'; })
      .join('');
    return (
      '<section class="model-box"><h2>How the implied value is built — from the snapshot itself</h2>' +
      '<p class="formula"><code>implied = TVL × category multiple × growth × maturity × breadth</code></p>' +
      '<p><strong>Category multiple:</strong> a sample-weighted geometric blend of the category\u2019s median market-cap / TVL ' +
      'with the global median (<strong>×' + DATA.calibration.global_multiple.toFixed(2) + '</strong>) — weight n : 4 on the category\u2019s own live samples, ' +
      'so a one-sample category keeps only a fifth of its own signal and an outlier ratio is compressed, not amplified — clamped to ×0.04–×1.50. ' +
      '<strong>Growth:</strong> the 7-day TVL change, clamped to −40%…+60%, weighted 0.55. ' +
      '<strong>Maturity:</strong> years live with no token, full weight at four years. <strong>Breadth:</strong> +2.5% per extra chain, up to eight. ' +
      'Every row names the live samples behind its multiple; rows resting on fewer than 3 samples are marked <em>thin</em> — their price leans ' +
      'mostly on the market-wide median. Open any protocol to see its own five numbers multiplied out.</p>' +
      '<div class="calib">' + chips + '</div></section>'
    );
  }

  function controls(categories, chains, count, total) {
    function opts(list, current, allLabel) {
      var out = '<option value="all">' + allLabel + '</option>';
      list.forEach(function (v) { out += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>'; });
      return out;
    }
    return (
      '<div class="controls">' +
      '<input type="search" id="q" placeholder="Search name, slug, chain…" value="' + esc(state.q) + '" aria-label="Search">' +
      '<select id="cat" aria-label="Category">' + opts(categories, state.category, 'All categories') + '</select>' +
      '<select id="chain" aria-label="Chain">' + opts(chains, state.chain, 'All chains') + '</select>' +
      '<label><input type="checkbox" id="watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + count + ' of ' + total + ' protocols</span></div>'
    );
  }

  function boardTable(rows) {
    var shown = rows.slice(0, state.shown);
    var head =
      '<tr><th data-sort="rank">#</th><th>Protocol</th><th class="num" data-sort="tvl">TVL</th>' +
      '<th class="num" data-sort="growth">7d</th><th class="num hide-s" data-sort="age">Age</th>' +
      '<th class="num" data-sort="implied">Implied value</th><th class="hide-s">×TVL</th><th class="hide-s">Chains</th></tr>';
    var body = shown.map(function (r) {
      var ratio = r.tvl_usd > 0 ? (r.implied_value_usd / r.tvl_usd).toFixed(2) : 'n/a';
      return (
        '<tr data-slug="' + esc(r.slug) + '"><td class="rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + (r.on_watchlist ? '<span class="badge">Watchlist</span>' : '') +
        '<span class="cat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num hide-s">' + fmtAge(r.age_days, r.age_assumed) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td class="hide-s">×' + ratio + '<span class="' + (r.category_samples < 3 ? 'cat conf-thin' : 'cat') + '">mult ×' +
        r.category_multiple.toFixed(2) + ' · ' + r.category_samples + ' live' + (r.category_samples < 3 ? ' · thin' : '') + '</span></td>' +
        '<td class="chains hide-s">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td></tr>'
      );
    }).join('');
    var more = rows.length > state.shown ? '<button class="more" id="more">Show more — ' + (rows.length - state.shown) + ' remaining</button>' : '';
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' + more;
  }

  function liveTable() {
    var body = DATA.live.map(function (r) {
      return (
        '<tr><td><span class="name">' + esc(r.name) + '</span><span class="cat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td><td class="num">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num">' + (r.mcap_tvl === null ? 'n/a' : '×' + r.mcap_tvl.toFixed(2)) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td></tr>'
      );
    }).join('');
    return (
      '<section class="live"><h2>Already trading — the calibration set, never ranked</h2>' +
      '<p>These protocols have a token, so the market has already priced them. The radar does not rank them; ' +
      'it learns each category\u2019s market-cap / TVL multiple from them and applies it to the pre-token board above.</p>' +
      '<table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">MCap / TVL</th><th class="num">7d</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></section>'
    );
  }

  function detail(r) {
    var cal = calibFor(r.category);
    var eq =
      fmtUsd(r.tvl_usd) + ' TVL × ' + r.category_multiple.toFixed(2) + ' category × ' + r.growth_multiplier.toFixed(3) +
      ' growth × ' + r.maturity_multiplier.toFixed(3) + ' maturity × ' + r.breadth_multiplier.toFixed(3) + ' breadth = ' + fmtUsd(r.implied_value_usd);
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    return (
      '<button class="back" id="back">← Back to the board</button>' +
      '<section class="detail"><h2>' + esc(r.name) + (r.on_watchlist ? '<span class="badge">Watchlist</span>' : '') + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' of ' + DATA.board_size + ' · ' + esc(r.category || 'Uncategorized') + ' · ' +
      esc(r.chains.join(', ') || 'chain not named') + ' · tracked since ' + esc(r.listed_at || 'unknown') + '</p>' +
      '<div class="breakdown">' +
      '<div class="cell"><b>' + fmtUsd(r.implied_value_usd) + '</b><span>Implied value</span></div>' +
      '<div class="cell"><b>' + fmtUsd(r.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div class="cell"><b>' + fmtPct(r.change_7d) + '</b><span>TVL change 7d</span></div>' +
      '<div class="cell"><b>' + fmtAge(r.age_days, r.age_assumed) + '</b><span>Live, no token</span></div>' +
      '<div class="cell"><b>×' + r.category_multiple.toFixed(2) + '</b><span>Category multiple</span></div>' +
      '<div class="cell"><b>' + r.category_samples + (r.category_samples < 3 ? ' — thin' : r.category_samples < 6 ? ' — fair' : ' — solid') +
      '</b><span>Live samples in category</span></div>' +
      '</div>' +
      '<div class="eq">' + esc(eq) + '</div>' +
      '<p class="sub" style="margin-top:10px">The ×' + r.category_multiple.toFixed(2) + ' multiple is the sample-weighted geometric blend of the ' +
      esc(cal.category) + ' raw median market-cap / TVL (×' + cal.median_ratio.toFixed(2) + ', from ' + cal.samples + ' live-token protocol' +
      (cal.samples === 1 ? '' : 's') + ') with the global median (×' + DATA.calibration.global_multiple.toFixed(2) + '): the category\u2019s own signal carries ' +
      Math.round((100 * cal.samples) / (cal.samples + 4)) + '% of the weight.' +
      (cal.samples < 3 ? ' That is thin evidence — this price leans mostly on the market-wide median, and the board marks the row thin.' : '') +
      ' Either way the row is priced from its traded peers\u2019 numbers, not by a guess at its name.</p>' +
      '<h3>Farm plan — what to do, what it costs, how long it takes</h3><ol class="farm">' + steps + '</ol></section>'
    );
  }

  function render() {
    readHash();
    var categories = [], chains = [], seenC = {}, seenCh = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Uncategorized';
      if (!seenC[c]) { seenC[c] = 1; categories.push(c); }
      r.chains.forEach(function (ch) { if (!seenCh[ch]) { seenCh[ch] = 1; chains.push(ch); } });
    });
    categories.sort(); chains.sort();
    var detailRow = null;
    if (state.detail) {
      DATA.rows.forEach(function (r) { if (r.slug === state.detail) detailRow = r; });
    }
    // In detail view the masthead shrinks and the model box steps aside, so the
    // protocol's own breakdown and farm plan are what fills the screen.
    var html = masthead(!!detailRow) + (detailRow ? '' : modelBox());
    if (detailRow) html += detail(detailRow);
    var rows = filtered();
    html += controls(categories, chains, rows.length, DATA.rows.length) + boardTable(rows) + liveTable() +
      '<footer>Source: ' + esc(DATA.source) + '. Snapshot floor: ' + fmtUsd(DATA.floor_usd) + ' TVL. ' +
      'An implied value is this model\u2019s claim about a launch that may never happen — it is not a prediction that a token will be issued, ' +
      'and it is not financial advice. Farm plans carry real cost and real smart-contract risk; sizes are starting points, not recommendations.</footer>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire(rows);
  }

  function wire(rows) {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; state.shown = PAGE; render(); var nq = document.getElementById('q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; state.shown = PAGE; render(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; state.shown = PAGE; render(); });
    var watch = document.getElementById('watch');
    if (watch) watch.addEventListener('change', function () { state.watch = watch.checked; state.shown = PAGE; render(); });
    var more = document.getElementById('more');
    if (more) more.addEventListener('click', function () { state.shown += PAGE * 2; render(); });
    var back = document.getElementById('back');
    if (back) back.addEventListener('click', function () { state.detail = null; location.hash = ''; render(); });
    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var s = th.getAttribute('data-sort');
        if (state.sort === s) state.dir = state.dir === -1 ? 1 : -1; else { state.sort = s; state.dir = -1; }
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('tbody tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { location.hash = 'detail=' + tr.getAttribute('data-slug'); state.detail = tr.getAttribute('data-slug'); render(); window.scrollTo(0, 0); });
    });
  }

  window.addEventListener('hashchange', render);
  render();
})();
