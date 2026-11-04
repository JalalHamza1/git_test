/* Valeo Forecast v2.0 — Google Apps Script V8.
 * One material/customer pair per build. No paid prediction API.
 * Leave blank for a spreadsheet-bound script; otherwise enter its spreadsheet ID.
 */
var SPREADSHEET_ID = '';

// Pure JavaScript engine. Kept in this file so installation needs only two files.
var ForecastEngine = (function () {
  'use strict';
  var WEEK = 604800000, MONDAY = Date.UTC(1970, 0, 5);
  var VERSION = '2.1.0';
  var FEATURES = ['Intercept', 'Horizon', 'Forecast / scale', '1-week revision / scale',
    '4-week revision / scale', 'Recent error / scale', 'Missing 1-week revision',
    'Missing 4-week revision', 'Missing recent error', 'Horizon × 1-week revision', 'Horizon × forecast'];
  var CANDIDATES = [];
  ['small', 'full'].forEach(function (kind) {
    [0.01, 0.1, 1].forEach(function (lambda) {
      CANDIDATES.push({id: kind + ':' + lambda, kind: kind, lambda: lambda, p: kind === 'small' ? 3 : 11});
    });
  });
  function fail(message) { throw new Error(message); }
  function assert(ok, message) { if (!ok) fail(message); }
  function blank(x) { return x === null || x === undefined || String(x).trim() === ''; }
  function norm(x) { return String(x == null ? '' : x).trim().toLowerCase().replace(/[\s_]+/g, ' '); }
  function mean(xs) { return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : 0; }
  function median(xs) { var a = xs.slice().sort(function (x, y) { return x - y; }); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : 0; }
  function finite(x) { return typeof x === 'number' && isFinite(x); }
  function number(x, where) {
    if (finite(x)) return x;
    assert(!blank(x), where + ': quantity is blank, not a confirmed zero.');
    var s = String(x).trim().replace(/[\s ']/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    if (/-$/.test(s)) s = '-' + s.slice(0, -1);
    if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.indexOf(',') >= 0) {
      // A single comma with three digits is ambiguous: ask for numeric Excel cells.
      assert(!/^[+-]?\d{1,3},\d{3}$/.test(s), where + ': ambiguous number "' + x + '". Use a numeric Excel cell or an unambiguous decimal.');
      s = /^[-+]?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    }
    assert(/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s) && isFinite(Number(s)), where + ': invalid quantity "' + x + '".');
    return Number(s);
  }
  function date(text) {
    if (finite(text)) { // Excel 1900 system; browser converts 1904 workbooks before sending.
      assert(text > 0 && text < 80000, 'Invalid Excel posting date.');
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(text) * 86400000).toISOString().slice(0, 10);
    }
    var s = String(text == null ? '' : text).trim(), m, y, mo, d;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) { y = +m[3]; mo = +m[2]; d = +m[1]; }
    else fail('Invalid posting date "' + s + '". Use Excel dates, YYYY-MM-DD or DD.MM.YYYY.');
    var t = new Date(Date.UTC(y, mo - 1, d));
    assert(y >= 2000 && y <= 2099 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d, 'Invalid posting date "' + s + '".');
    return t.toISOString().slice(0, 10);
  }
  function dateWeek(s) { return Math.floor((Date.parse(date(s) + 'T00:00:00Z') - MONDAY) / WEEK); }
  function label(w) {
    var thursday = new Date(MONDAY + w * WEEK + 3 * 86400000), year = thursday.getUTCFullYear();
    var jan4 = Date.UTC(year, 0, 4), start = Math.floor((jan4 - MONDAY) / WEEK);
    return year + '-W' + String(w - start + 1).padStart(2, '0');
  }
  function week(x, version, decade) {
    var s = String(x == null ? '' : x).trim(), m, y, n;
    if ((m = /^(20\d{2})-?W(\d{1,2})$/i.exec(s))) { y = +m[1]; n = +m[2]; }
    else if (!version && (m = /^(\d{1,2})\.(20\d{2})$/.exec(s))) { n = +m[1]; y = +m[2]; }
    else if (version && (m = /^(\d)(\d{2})$/.exec(s))) { y = decade + +m[1]; n = +m[2]; }
    else fail('Invalid ' + (version ? 'version' : 'week') + ' "' + s + '". Use YYYY-Www' + (version ? ' or a three-digit SAP version.' : ' or ww.YYYY.'));
    var first = Math.floor((Date.UTC(y, 0, 4) - MONDAY) / WEEK), w = first + n - 1;
    assert(n >= 1 && n <= 53 && label(w) === y + '-W' + String(n).padStart(2, '0'), 'Invalid ISO week "' + s + '".');
    return w;
  }
  function options(input) {
    input = input || {};
    var o = {decade: blank(input.decade) ? 2020 : +input.decade,
      actualFrom: input.actualFrom || '', actualThrough: input.actualThrough || '',
      missingZero: input.missingZero === true, signMode: input.signMode || 'sap',
      lag: blank(input.lag) ? 1 : +input.lag};
    assert(Number.isInteger(o.decade) && o.decade >= 2000 && o.decade <= 2090 && o.decade % 10 === 0, 'SAP version decade must be 2000, 2010, 2020, etc.');
    assert(o.signMode === 'sap' || o.signMode === 'positive', 'Invalid quantity convention.');
    assert(Number.isInteger(o.lag) && o.lag >= 1 && o.lag <= 8, 'Shipment availability lag must be 1–8 weeks.');
    assert(Boolean(o.actualFrom) === Boolean(o.actualThrough), 'Enter both the first and last complete shipment week, or leave both blank for preview.');
    if (o.actualFrom) {
      var from = week(o.actualFrom), through = week(o.actualThrough);
      assert(from <= through && through - from <= 520, 'Complete shipment range must be ordered and at most ten years.');
      o.actualFrom = label(from); o.actualThrough = label(through);
    }
    return o;
  }
  function table(grid, required, optional, type) {
    assert(Array.isArray(grid) && grid.length > 0 && grid.length <= 50000, type + ': expected 1–50,000 rows.');
    var hits = [], names = required.concat(optional), row, indices;
    grid.forEach(function (r, i) {
      assert(Array.isArray(r) && r.length <= 100, type + ': too many columns (maximum 100).');
      var ns = r.map(norm);
      if (required.every(function (h) { return ns.indexOf(norm(h)) >= 0; })) {
        var map = {};
        names.forEach(function (h) { var n = ns.indexOf(norm(h)); if (n >= 0) map[h] = n; });
        required.forEach(function (h) { assert(ns.indexOf(norm(h)) === ns.lastIndexOf(norm(h)), type + ': multiple tables in one header. Separate the intended table.'); });
        hits.push({row: i, map: map});
      }
    });
    assert(hits.length, type + ': headers not found. Required: ' + required.join(', ') + '.');
    indices = hits[0].map; row = hits[0].row;
    // Anchor to the first labeled table. A side table can even have its header on
    // the same row as a valid transaction in the main table: do not skip that row.
    var same = hits.filter(function (h) { return JSON.stringify(h.map) === JSON.stringify(indices); });
    var records = [], outside = 0, headers = new Set(same.map(function (h) { return h.row; }));
    grid.forEach(function (r, i) {
      if (headers.has(i)) return;
      var obj = {sourceRow: i + 1};
      names.forEach(function (n) { if (indices[n] !== undefined) obj[n] = r[indices[n]] == null ? '' : r[indices[n]]; });
      if (Object.keys(indices).every(function (k) { return blank(obj[k]); })) {
        if (r.some(function (v) { return !blank(v); })) outside++;
        return;
      }
      records.push(obj);
    });
    return {records: records, headerRow: row + 1, outside: outside, otherTables: hits.length - same.length};
  }
  function importGrids(request) {
    assert(request && request.forecastGrid && request.shipmentGrid, 'Choose both source files.');
    var o = options(request.options), warnings = [], fs = table(request.forecastGrid,
      ['Version', 'Week', 'Total Demand'], ['Material', 'Customer'], 'Forecast');
    var ss = table(request.shipmentGrid, ['Posting Date', 'Quantity'],
      ['Material', 'Customer', 'Movement Type', 'Material Document', 'Unit of Entry'], 'Shipments');
    var f = [], s = [], skipped = 0;
    fs.records.forEach(function (r) {
      // Permit a blank-key aggregate footer; never turn a blank quantity into zero.
      if (blank(r.Version) && blank(r.Week)) { skipped++; return; }
      try {
        f.push({origin: week(r.Version, true, o.decade), target: week(r.Week),
          forecast: number(r['Total Demand'], 'Forecast row ' + r.sourceRow), sourceRow: r.sourceRow,
          material: String(r.Material || '').trim(), customer: String(r.Customer || '').trim()});
      } catch (e) { fail('Forecast row ' + r.sourceRow + ': ' + e.message); }
    });
    ss.records.forEach(function (r) {
      if (blank(r['Posting Date'])) {
        assert(blank(r.Material) && blank(r.Customer) && blank(r['Material Document']) && blank(r['Movement Type']), 'Shipment row ' + r.sourceRow + ': transaction is missing its Posting Date.');
        skipped++; return;
      }
      try {
        s.push({date: date(r['Posting Date']), quantity: number(r.Quantity, 'Shipment row ' + r.sourceRow),
          material: String(r.Material || '').trim(), customer: String(r.Customer || '').trim(),
          movement: String(r['Movement Type'] || '').trim(), document: String(r['Material Document'] || '').trim(),
          unit: String(r['Unit of Entry'] || '').trim(), sourceRow: r.sourceRow});
      } catch (e) { fail('Shipment row ' + r.sourceRow + ': ' + e.message); }
    });
    warnings.push('Forecast headers: row ' + fs.headerRow + '; shipment headers: row ' + ss.headerRow + '. Read transactions above and below headers.');
    if (fs.otherTables || ss.otherTables) warnings.push((fs.otherTables + ss.otherTables) + ' additional labeled table(s) found in other columns. Only the first labeled table was imported; separate other tables into their own worksheets if needed.');
    if (fs.outside || ss.outside) warnings.push((fs.outside + ss.outside) + ' rows contained only data outside the labeled table and were not imported. Check the selected worksheet/table.');
    if (skipped) warnings.push(skipped + ' rows without transaction/forecast keys were skipped (for example, totals).');
    if (request.sourceNames) warnings.push('Sources: ' + String(request.sourceNames).slice(0, 500));
    return {schema: 2, forecast: f, shipments: s, options: o, importNotes: warnings};
  }
  function prepare(data) {
    assert(data && data.schema === 2, 'Unsupported build format.');
    assert(Array.isArray(data.forecast) && data.forecast.length && data.forecast.length <= 30000, 'Expected 1–30,000 forecast records.');
    assert(Array.isArray(data.shipments) && data.shipments.length && data.shipments.length <= 50000, 'Expected 1–50,000 shipment transactions.');
    var o = options(data.options), forecasts = new Map(), origins = new Set(), targets = new Set(), actual = new Map();
    var materials = new Set(), customers = new Set(), units = new Set(), notes = (data.importNotes || []).map(String).slice(0, 30);
    data.forecast.forEach(function (r) {
      assert(Number.isInteger(r.origin) && Number.isInteger(r.target) && r.origin >= 1565 && r.origin < 6780 && r.target >= 1565 && r.target < 6780, 'Invalid forecast week index.');
      assert(finite(r.forecast) && r.forecast >= 0 && r.forecast <= 1e12, 'Forecasts must be finite nonnegative quantities.');
      var key = r.origin + ':' + r.target;
      assert(!forecasts.has(key), 'Duplicate forecast for ' + label(r.origin) + ' / ' + label(r.target) + '. Keep one material/customer row per version and delivery week.');
      forecasts.set(key, r.forecast); origins.add(r.origin); targets.add(r.target);
      if (r.material) materials.add(r.material); if (r.customer) customers.add(r.customer);
    });
    data.shipments.forEach(function (r) {
      assert(finite(r.quantity) && Math.abs(r.quantity) <= 1e12, 'Invalid shipment quantity.');
      var w = dateWeek(r.date), q = r.quantity, m = String(r.movement || '');
      assert(!m || m === '601' || m === '602', 'Unsupported movement type ' + m + ' at row ' + r.sourceRow + '. Filter to 601/602 or supply a verified shipment extract.');
      if (o.signMode === 'sap') {
        assert(m !== '601' || q <= 0, '601 quantities should be negative in SAP-signed mode (row ' + r.sourceRow + '). Choose positive shipment mode if your extract uses the opposite signs.');
        assert(m !== '602' || q >= 0, '602 reversal quantities should be positive in SAP-signed mode (row ' + r.sourceRow + ').');
        q = -q;
      } else {
        assert(m !== '601' || q >= 0, '601 quantities should be positive in positive shipment mode.');
        assert(m !== '602' || q <= 0, '602 returns should be negative in positive shipment mode.');
      }
      actual.set(w, (actual.get(w) || 0) + q);
      if (r.material) materials.add(r.material); if (r.customer) customers.add(r.customer); if (r.unit) units.add(r.unit);
    });
    assert(materials.size <= 1 && customers.size <= 1, 'This build contains more than one material/customer pair. Filter both files to one matching pair.');
    assert(units.size <= 1, 'Multiple shipment units found. Convert quantities to one consistent unit before import.');
    actual.forEach(function (q, w) { assert(q >= 0, 'Net shipments are negative in ' + label(w) + '. Resolve returns or use a separate returns model; values were not made absolute.'); });
    var os = Array.from(origins).sort(function (a, b) { return a - b; });
    assert(os.length <= 208 && os[os.length - 1] - os[0] <= 520, 'Use at most 208 forecast versions spanning at most ten years per build.');
    var from = o.actualFrom ? week(o.actualFrom) : null, through = o.actualThrough ? week(o.actualThrough) : null;
    if (from === null) notes.push('No complete shipment interval confirmed. Predictions fall back to the customer forecast; no accuracy scores are computed.');
    if (!o.missingZero) notes.push('Weeks with no shipment rows remain unknown, including gaps inside the complete interval.');
    notes.push('Historical availability assumption: a completed shipment week becomes known ' + o.lag + ' week(s) later. Later SAP corrections cannot be reconstructed without archived extracts.');
    if (data.forecast.every(function (r) { return !r.material || !r.customer; })) notes.push('Forecast file has no complete material/customer key. Confirm that it belongs to the shipment pair shown.');
    function actualAt(w, asOf) {
      if (from === null || w < from || w > through || (asOf !== undefined && w + o.lag > asOf)) return null;
      return actual.has(w) ? actual.get(w) : (o.missingZero ? 0 : null);
    }
    return {data: data, options: o, forecasts: forecasts, actual: actual, actualAt: actualAt,
      origins: os, targets: Array.from(targets).sort(function (a, b) { return a - b; }), notes: notes,
      material: Array.from(materials)[0] || 'Unspecified', customer: Array.from(customers)[0] || 'Unspecified',
      unit: Array.from(units)[0] || 'units', from: from, through: through};
  }
  function autoImport(request, today) {
    var fs = table(request.forecastGrid, ['Version', 'Week', 'Total Demand'], [], 'Forecast');
    var compact = fs.records.filter(function (r) { return /^\d{3}$/.test(String(r.Version).trim()); });
    var decades = [];
    if (compact.length) {
      for (var d = 2000; d <= 2090; d += 10) {
        if (compact.every(function (r) {
          try { var delta = week(r.Week) - week(r.Version, true, d); return delta >= -52 && delta <= 104; }
          catch (e) { return false; }
        })) decades.push(d);
      }
      assert(decades.length === 1, 'SAP version year is ambiguous. Open Advanced settings, turn off automatic detection, and choose the decade.');
    }
    var ss = table(request.shipmentGrid, ['Posting Date', 'Quantity'], ['Movement Type'], 'Shipments');
    var conventions = new Set(), withoutCodes = new Set();
    ss.records.forEach(function (r) {
      if (blank(r['Posting Date'])) return;
      var q = number(r.Quantity, 'Shipment row ' + r.sourceRow), m = String(r['Movement Type'] || '').trim();
      if (!q) return;
      if (m === '601') conventions.add(q < 0 ? 'sap' : 'positive');
      else if (m === '602') conventions.add(q > 0 ? 'sap' : 'positive');
      else if (!m) withoutCodes.add(q < 0 ? 'sap' : 'positive');
    });
    assert(conventions.size <= 1, 'Shipment movement codes and quantity signs conflict. Check the extract.');
    if (!conventions.size) {
      assert(withoutCodes.size <= 1, 'Mixed shipment signs without movement codes are ambiguous. Open Advanced settings, turn off automatic detection, and select the quantity convention.');
      conventions = withoutCodes;
    }
    var remembered = request.options || {};
    var o = options({decade: compact.length ? decades[0] : (remembered.decade || 2020),
      signMode: Array.from(conventions)[0] || remembered.signMode || 'sap', lag: remembered.lag || 1});
    var data = importGrids(Object.assign({}, request, {options: o}));
    prepare(data); // Still reject mixed series, duplicates, unsupported movements, etc.
    var weeks = new Set(data.shipments.map(function (r) { return dateWeek(r.date); }));
    var ordered = Array.from(weeks).sort(function (a, b) { return a - b; });
    var from = ordered[0] + 1, through = Math.min(ordered[ordered.length - 1] - 1,
      dateWeek(today || new Date().toISOString().slice(0, 10)) - 1);
    var gaps = [];
    for (var w = from; w <= through; w++) if (!weeks.has(w)) gaps.push(label(w));
    data.detection = {suggestedFrom: from <= through ? label(from) : '', suggestedThrough: from <= through ? label(through) : '',
      firstPosting: data.shipments.map(function (r) { return r.date; }).sort()[0],
      lastPosting: data.shipments.map(function (r) { return r.date; }).sort().slice(-1)[0],
      gaps: gaps, confirmed: false, decade: o.decade, signMode: o.signMode};
    data.importNotes.push('Automatically detected SAP decade ' + o.decade + ' and ' + o.signMode + ' quantity convention. Reporting delay uses the saved/default setting, not an inferred timestamp.');
    data.importNotes.push('Suggested coverage excludes the first and last recorded shipment weeks and the current calendar week. It requires confirmation; gaps remain unknown.');
    return data;
  }
  function examples(ctx) {
    var rows = [];
    ctx.origins.forEach(function (origin) {
      var past = [], errs = [], current = [];
      for (var k = 0; k < 13; k++) {
        var w = origin - ctx.options.lag - k, a = ctx.actualAt(w, origin);
        if (a !== null) past.push(a);
        var old = ctx.forecasts.get((w - 1) + ':' + w);
        if (k < 4 && a !== null && old !== undefined) errs.push(a - old);
      }
      for (var h = 1; h <= 21; h++) {
        var c = ctx.forecasts.get(origin + ':' + (origin + h));
        if (c !== undefined && c > 0) current.push(c);
      }
      var scale = Math.max(1, past.length ? mean(past) : median(current));
      for (var j = 1; j <= 21; j++) {
        var target = origin + j, f = ctx.forecasts.get(origin + ':' + target);
        if (f === undefined) continue;
        var prev1 = ctx.forecasts.get((origin - 1) + ':' + target), prev4 = ctx.forecasts.get((origin - 4) + ':' + target);
        var u = (j - 1) / 20, z = f / scale, r1 = prev1 === undefined ? 0 : (f - prev1) / scale;
        var r4 = prev4 === undefined ? 0 : (f - prev4) / scale, b = errs.length ? mean(errs) / scale : 0;
        rows.push({origin: origin, target: target, h: j, f: f, s: scale,
          x: [1, u, z, r1, r4, b, prev1 === undefined ? 1 : 0, prev4 === undefined ? 1 : 0, errs.length ? 0 : 1, u * r1, u * z],
          y: ctx.actualAt(target)});
      }
    });
    return rows;
  }
  function solveSPD(a, b) {
    // Cholesky solve; no matrix inversion. Ridge guarantees positive definiteness.
    var n = b.length, L = Array.from({length: n}, function () { return Array(n).fill(0); });
    for (var i = 0; i < n; i++) for (var j = 0; j <= i; j++) {
      var t = a[i][j];
      for (var k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      if (i === j) { if (!(t > 0) || !isFinite(t)) return null; L[i][j] = Math.sqrt(t); }
      else L[i][j] = t / L[j][j];
    }
    var z = Array(n).fill(0), beta = Array(n).fill(0);
    for (i = 0; i < n; i++) { t = b[i]; for (j = 0; j < i; j++) t -= L[i][j] * z[j]; z[i] = t / L[i][i]; }
    for (i = n - 1; i >= 0; i--) { t = z[i]; for (j = i + 1; j < n; j++) t -= L[j][i] * beta[j]; beta[i] = t / L[i][i]; }
    return beta.every(isFinite) ? beta : null;
  }
  function fit(train, candidate) {
    var counts = new Map(), origins = new Set();
    train.forEach(function (r) { counts.set(r.target, (counts.get(r.target) || 0) + 1); origins.add(r.origin); });
    var minTargets = candidate.kind === 'small' ? 12 : 26;
    if (counts.size < minTargets || origins.size < 8) return null;
    var p = candidate.p, rms = Array(p).fill(0), total = counts.size;
    train.forEach(function (r) { var w = 1 / counts.get(r.target); for (var j = 0; j < p; j++) rms[j] += w * r.x[j] * r.x[j]; });
    rms = rms.map(function (x) { return Math.sqrt(x / total) || 1; });
    var a = Array.from({length: p}, function () { return Array(p).fill(0); }), b = Array(p).fill(0);
    train.forEach(function (r) {
      var w = 1 / counts.get(r.target) / total, y = (r.y - r.f) / r.s;
      for (var i = 0; i < p; i++) {
        var xi = r.x[i] / rms[i]; b[i] += w * xi * y;
        for (var j = 0; j <= i; j++) a[i][j] += w * xi * r.x[j] / rms[j];
      }
    });
    for (var i = 0; i < p; i++) { for (var j = 0; j < i; j++) a[j][i] = a[i][j]; a[i][i] += candidate.lambda; }
    var beta = solveSPD(a, b);
    return beta ? {id: candidate.id, kind: candidate.kind, lambda: candidate.lambda, beta: beta, rms: rms, targets: counts.size, rows: train.length} : null;
  }
  function predict(r, model) {
    if (!model) return null;
    var correction = 0;
    for (var j = 0; j < model.beta.length; j++) correction += r.x[j] / model.rms[j] * model.beta[j];
    var p = r.f + r.s * correction;
    return isFinite(p) ? Math.max(0, p) : null;
  }
  function band(h) { return h <= 3 ? 0 : h <= 8 ? 1 : 2; }
  function select(history, asOf, lag, whichBand) {
    // Only already issued forecasts whose actual labels had matured by this origin.
    var past = history.filter(function (r) { return r.origin < asOf && r.origin >= asOf - 52 && r.target + lag <= asOf && r.y !== null && band(r.h) === whichBand; });
    var baseline = past.reduce(function (a, r) { return a + Math.abs(r.f - r.y); }, 0);
    var best = {index: -1, alpha: 0, validationCases: past.length, improvement: null, reason: 'Customer forecast: not enough earlier validation evidence.'};
    if (!past.length || baseline === 0) { if (past.length) best.reason = 'Customer forecast: zero error on earlier validation cases.'; return best; }
    var bestLoss = baseline;
    CANDIDATES.forEach(function (candidate, index) {
      var supported = past.filter(function (r) { return r.candidates[index] !== null; });
      if (new Set(supported.map(function (r) { return r.target; })).size < 8 || new Set(supported.map(function (r) { return r.origin; })).size < 6 || supported.length < 16) return;
      [0.25, 0.5, 1].forEach(function (alpha) {
        var loss = past.reduce(function (sum, r) {
          var m = r.candidates[index] === null ? r.f : r.candidates[index];
          return sum + Math.abs(r.f + alpha * (m - r.f) - r.y);
        }, 0);
        if (loss < baseline * 0.98 && loss < bestLoss - 1e-9) {
          bestLoss = loss; best = {index: index, alpha: alpha, validationCases: past.length,
            improvement: 1 - loss / baseline, reason: 'Validated correction (' + candidate.kind + ', λ=' + candidate.lambda + ', blend=' + alpha + ').'};
        }
      });
    });
    if (best.index < 0 && past.length >= 16) best.reason = 'Customer forecast: correction has not met the evidence and 2% improvement gate.';
    return best;
  }
  function horizonSupported(history, asOf, lag, h, rule) {
    if (rule.index < 0) return false;
    // A pooled horizon band must not authorize an untested farther horizon.
    var past = history.filter(function (r) { return r.h === h && r.origin < asOf && r.origin >= asOf - 52 && r.target + lag <= asOf && r.y !== null && r.candidates[rule.index] !== null; });
    if (past.length < 6) return false; // One case per origin at a fixed horizon.
    var base = 0, loss = 0;
    past.forEach(function (r) { base += Math.abs(r.f - r.y); loss += Math.abs(r.f + rule.alpha * (r.candidates[rule.index] - r.f) - r.y); });
    return base > 0 && loss < 0.98 * base;
  }
  function metrics(rows) {
    if (!rows.length) return {cases: 0, targets: 0, origins: 0, customerMAE: null, modelMAE: null, improvement: null,
      customerRMSE: null, modelRMSE: null, customerWAPE: null, modelWAPE: null, customerBias: null, modelBias: null, corrected: 0};
    var ca = 0, ma = 0, cs = 0, ms = 0, cb = 0, mb = 0, den = 0, corrected = 0;
    rows.forEach(function (r) {
      var c = r.f - r.y, m = r.prediction - r.y;
      ca += Math.abs(c); ma += Math.abs(m); cs += c * c; ms += m * m; cb += c; mb += m; den += Math.abs(r.y);
      if (r.alpha > 0) corrected++;
    });
    return {cases: rows.length, targets: new Set(rows.map(function (r) { return r.target; })).size,
      origins: new Set(rows.map(function (r) { return r.origin; })).size, customerMAE: ca / rows.length, modelMAE: ma / rows.length,
      improvement: ca ? 1 - ma / ca : null, customerRMSE: Math.sqrt(cs / rows.length), modelRMSE: Math.sqrt(ms / rows.length),
      customerWAPE: den ? ca / den : null, modelWAPE: den ? ma / den : null, customerBias: cb / rows.length, modelBias: mb / rows.length, corrected: corrected};
  }
  function totalCases(history, horizon) {
    var groups = new Map(), out = [];
    history.forEach(function (r) { if (r.h <= horizon) { if (!groups.has(r.origin)) groups.set(r.origin, []); groups.get(r.origin).push(r); } });
    groups.forEach(function (rs, origin) {
      if (rs.length !== horizon || rs.some(function (r) { return r.y === null; })) return;
      out.push({origin: origin, target: origin + horizon, h: horizon, f: rs.reduce(function (v, r) { return v + r.f; }, 0),
        y: rs.reduce(function (v, r) { return v + r.y; }, 0), prediction: rs.reduce(function (v, r) { return v + r.prediction; }, 0),
        alpha: rs.some(function (r) { return r.alpha > 0; }) ? 1 : 0});
    });
    return out;
  }
  function analyze(data) {
    var started = Date.now(), ctx = prepare(data), rows = examples(ctx), history = [], finalModels, finalRules, last = ctx.origins[ctx.origins.length - 1];
    ctx.origins.forEach(function (origin) {
      assert(Date.now() - started < 240000, 'Analysis exceeded four minutes. Reduce the number of historical versions and try again.');
      var train = rows.filter(function (r) { return r.origin < origin && r.target + ctx.options.lag <= origin && r.target >= origin - 104 && r.y !== null; });
      var models = CANDIDATES.map(function (candidate) { return fit(train, candidate); });
      var rules = [0, 1, 2].map(function (b) { return select(history, origin, ctx.options.lag, b); });
      if (ctx.from === null) rules.forEach(function (r) { r.reason = 'Customer forecast: complete shipment coverage has not been confirmed.'; });
      rows.filter(function (r) { return r.origin === origin; }).forEach(function (r) {
        var preds = models.map(function (m) { return predict(r, m); }), rule = rules[band(r.h)];
        var fitted = rule.index >= 0 && preds[rule.index] !== null;
        var use = fitted && horizonSupported(history, origin, ctx.options.lag, r.h, rule), m = use ? preds[rule.index] : r.f;
        history.push(Object.assign({}, r, {candidates: preds, prediction: use ? r.f + rule.alpha * (m - r.f) : r.f,
          alpha: use ? rule.alpha : 0, model: use ? CANDIDATES[rule.index].id : 'customer',
          reason: use ? rule.reason : (fitted ? 'Customer forecast: earlier tests at this exact horizon do not yet support the correction.' : (rule.index >= 0 ? 'Customer forecast: current fit has insufficient history.' : rule.reason))}));
      });
      if (origin === last) { finalModels = models; finalRules = rules; }
    });
    var latest = history.filter(function (r) { return r.origin === last; }), predictions = [];
    for (var h = 1; h <= 21; h++) {
      var r = latest.find(function (a) { return a.h === h; });
      predictions.push(r ? {week: label(r.target), horizon: h, customer: r.f, prediction: r.prediction, change: r.prediction - r.f,
        model: r.model, alpha: r.alpha, reason: r.reason, scale: r.s} : {week: label(last + h), horizon: h, customer: null, prediction: null, change: null,
        model: 'missing', alpha: 0, reason: 'No customer forecast for this delivery week.', scale: null});
    }
    var scored = history.filter(function (r) { return r.y !== null; });
    var byHorizon = Array.from({length: 21}, function (_, i) { return Object.assign({horizon: i + 1}, metrics(scored.filter(function (r) { return r.h === i + 1; }))); });
    var actualWeeks = Array.from(ctx.actual.keys());
    if (ctx.from !== null) for (var w = ctx.from; w <= ctx.through; w++) if (!ctx.actual.has(w)) actualWeeks.push(w);
    actualWeeks.sort(function (a, b) { return a - b; });
    var actualRows = actualWeeks.map(function (w) {
      return {week: label(w), quantity: ctx.actual.has(w) ? ctx.actual.get(w) : null, verified: ctx.actualAt(w),
        status: ctx.actualAt(w) === null ? 'Unverified / unknown' : (ctx.actual.has(w) ? 'Complete' : 'Confirmed zero')};
    });
    var waterfallWeeks = Array.from(new Set(ctx.targets.concat(actualWeeks))).sort(function (a, b) { return a - b; });
    assert(waterfallWeeks.length <= 650, 'Waterfall spans more than 650 weeks. Filter the input range.');
    var waterfall = {headers: ['Version / delivery'].concat(waterfallWeeks.map(label)), rows: []};
    waterfall.rows.push({label: 'Actual — complete only', kind: 'actual', values: waterfallWeeks.map(function (w) { return ctx.actualAt(w); })});
    ctx.origins.forEach(function (o) { waterfall.rows.push({label: label(o), kind: 'forecast', values: waterfallWeeks.map(function (t) { var v = ctx.forecasts.get(o + ':' + t); return v === undefined ? null : v; })}); });
    var backtest = scored.map(function (r) { return {origin: label(r.origin), week: label(r.target), horizon: r.h, customer: r.f, actual: r.y,
      prediction: r.prediction, alpha: r.alpha, model: r.model, reason: r.reason}; });
    var totals = totalCases(history, 21);
    return {version: VERSION, options: ctx.options, material: ctx.material, customer: ctx.customer, unit: ctx.unit, origin: label(last),
      importNotes: ctx.notes, forecastRows: data.forecast.length, shipmentRows: data.shipments.length, versions: ctx.origins.length,
      verifiedWeeks: actualRows.filter(function (r) { return r.verified !== null; }).length, predictions: predictions, waterfall: waterfall, actuals: actualRows,
      backtest: backtest, overall: metrics(scored), byHorizon: byHorizon,
      recent: metrics(scored.filter(function (r) { return r.origin >= last - 7; })),
      totals: totals.map(function (r) { return {origin: label(r.origin), through: label(r.target), customer: r.f, actual: r.y, prediction: r.prediction}; }),
      totalMetrics: metrics(totals), models: finalModels, rules: finalRules, featureNames: FEATURES, durationMs: Date.now() - started};
  }
  return {version: VERSION, importGrids: importGrids, autoImport: autoImport, analyze: analyze, prepare: prepare, options: options,
    week: week, label: label, date: date, dateWeek: dateWeek, number: number, examples: examples,
    fit: fit, predict: predict, select: select, horizonSupported: horizonSupported, solveSPD: solveSPD, metrics: metrics, totalCases: totalCases, candidates: CANDIDATES};
}());

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index').setTitle('Valeo • Demand Forecast')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function getUserEmail() { return Session.getActiveUser().getEmail(); }
function importAndAnalyze(request) {
  var data = request.auto === true ? ForecastEngine.autoImport(request) : ForecastEngine.importGrids(request);
  return {data: data, analysis: ForecastEngine.analyze(data)};
}
function analyzeBuild(data) { return ForecastEngine.analyze(data); }

// Persistence: append complete new revision first; switch one metadata row last.
// Old revisions and legacy sheets are retained. A failed staging write cannot erase the active build.
var BUILD_HEADERS_ = ['ID', 'Name', 'Created', 'Updated', 'Revision', 'Archived'];
var DATA_HEADERS_ = ['Revision', 'Chunk', 'Count', 'Payload'];
function spreadsheet_() {
  var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Bind this script to a Google Sheet, or set SPREADSHEET_ID at the top of Code.gs.');
  return ss;
}
function lock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is in progress. Try again shortly.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function size_(s, rows, cols) {
  if (s.getMaxRows() < rows) s.insertRowsAfter(s.getMaxRows(), rows - s.getMaxRows());
  if (s.getMaxColumns() < cols) s.insertColumnsAfter(s.getMaxColumns(), cols - s.getMaxColumns());
}
function safeCell_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // Spreadsheet formula injection protection. Numeric quantities remain numbers.
  return typeof v === 'string' && /^[\s]*[=+\-@]/.test(v) ? "'" + v : v;
}
function dbSheet_(ss, name, headers) {
  var s = ss.getSheetByName(name) || ss.insertSheet(name);
  if (!s.getLastRow()) s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  else if (JSON.stringify(s.getRange(1, 1, 1, headers.length).getValues()[0]) !== JSON.stringify(headers)) throw new Error(name + ' has unexpected columns. Restore the database headers.');
  return s;
}
function setup() {
  return lock_(function () {
    var ss = spreadsheet_();
    ['Prediction', 'Waterfall v2', 'Comparison v2', 'Backtest v2', 'Actuals v2', 'Forecast v2', 'Expedice v2', 'Model v2', 'Settings v2'].forEach(function (n) { if (!ss.getSheetByName(n)) ss.insertSheet(n); });
    dbSheet_(ss, '_VF_Builds', BUILD_HEADERS_).hideSheet();
    dbSheet_(ss, '_VF_Data', DATA_HEADERS_).hideSheet();
    SpreadsheetApp.flush();
    return 'Ready. Legacy sheets were preserved.';
  });
}
function values_(ss, name) { var s = ss.getSheetByName(name); return s && s.getLastRow() ? s.getDataRange().getValues() : []; }
function savedList_(ss) {
  var current = values_(ss, '_VF_Builds').slice(1).filter(function (r) { return r[0] && r[5] !== true; }).map(function (r) {
    return {id: String(r[0]), name: String(r[1]), date: String(r[3]), revision: String(r[4]), legacy: false};
  });
  var legacy = values_(ss, 'Saved').slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    return {id: 'legacy:' + r[0], name: String(r[1]), date: String(safeCell_(r[2])), revision: '', legacy: true};
  });
  return current.sort(function (a, b) { return b.date.localeCompare(a.date); }).concat(legacy);
}
function getSavedBuilds() { return savedList_(spreadsheet_()); }
function saveBuild(request) {
  if (!request || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 150) throw new Error('Enter a build name (1–150 characters).');
  // Recompute on the server and retain the issued predictions, so a later code
  // change cannot silently rewrite a saved prospective forecast.
  var analysis = ForecastEngine.analyze(request.data);
  var snapshot = {engine: analysis.version, savedAt: new Date().toISOString(), origin: analysis.origin,
    material: analysis.material, customer: analysis.customer, options: analysis.options,
    predictions: analysis.predictions, rules: analysis.rules, models: analysis.models};
  var json = JSON.stringify({format: 'VF_BUILD_2', data: request.data, snapshot: snapshot});
  if (json.length > 12000000) throw new Error('Build is too large to save (12 MB JSON limit).');
  var encoded = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json')).getBytes());
  return lock_(function () {
    var ss = spreadsheet_(), builds = dbSheet_(ss, '_VF_Builds', BUILD_HEADERS_), store = dbSheet_(ss, '_VF_Data', DATA_HEADERS_);
    var rows = builds.getDataRange().getValues(), index = -1;
    if (request.id) {
      index = rows.findIndex(function (r, i) { return i > 0 && r[0] === request.id; });
      if (index < 0 || rows[index][5] === true) throw new Error('Build is missing or archived. Save as a new build.');
      if (rows[index][4] !== request.revision) throw new Error('This build changed since you loaded it. Load the latest copy or save as a new build.');
    }
    var id = request.id || 'VF-' + Utilities.getUuid(), revision = Utilities.getUuid(), now = new Date().toISOString(), chunks = [];
    var count = Math.ceil(encoded.length / 40000);
    for (var i = 0; i < count; i++) chunks.push([revision, i, count, 'z:' + encoded.slice(i * 40000, (i + 1) * 40000)]);
    size_(store, store.getLastRow() + count, 4);
    store.getRange(store.getLastRow() + 1, 1, count, 4).setValues(chunks);
    SpreadsheetApp.flush();
    var row = [id, request.name.trim(), index >= 0 ? rows[index][2] : now, now, revision, false];
    var targetRow = index >= 0 ? index + 1 : builds.getLastRow() + 1;
    size_(builds, targetRow, 6);
    builds.getRange(targetRow, 1, 1, 6).setValues([row.map(safeCell_)]);
    SpreadsheetApp.flush();
    return {id: id, revision: revision, name: request.name.trim(), snapshot: snapshot, builds: savedList_(ss)};
  });
}
function loadBuild(id) {
  var ss = spreadsheet_(), item = savedList_(ss).find(function (r) { return r.id === id; });
  if (!item) throw new Error('Build not found.');
  var data, snapshot = null;
  if (item.legacy) {
    var oldId = id.slice(7);
    function legacyGrid(name) {
      var a = values_(ss, name); if (!a.length) throw new Error('Legacy ' + name + ' data is missing.');
      var col = a[0].indexOf('Build ID'); if (col < 0) throw new Error('Legacy ' + name + ' has no Build ID column.');
      return [a[0]].concat(a.slice(1).filter(function (r) { return r[col] === oldId; }).map(function (r) {
        return r.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v; });
      }));
    }
    data = ForecastEngine.importGrids({forecastGrid: legacyGrid('Forecast'), shipmentGrid: legacyGrid('Expedice'), options: {}});
    data.importNotes.push('Legacy build loaded for migration. Confirm shipment coverage and quantity convention, then save as a new build. Original legacy build is retained.');
  } else {
    var chunks = values_(ss, '_VF_Data').slice(1).filter(function (r) { return r[0] === item.revision; }).sort(function (a, b) { return a[1] - b[1]; });
    if (!chunks.length || chunks.length !== chunks[0][2] || chunks.some(function (r, i) { return r[1] !== i || r[2] !== chunks.length || String(r[3]).slice(0, 2) !== 'z:'; })) throw new Error('Saved revision is incomplete. Previous revisions remain in _VF_Data.');
    var encoded = chunks.map(function (r) { return r[3].slice(2); }).join('');
    var payload = JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(encoded))).getDataAsString('UTF-8'));
    data = payload.format === 'VF_BUILD_2' ? payload.data : payload;
    if (payload.format === 'VF_BUILD_2') snapshot = payload.snapshot;
  }
  return {id: item.legacy ? null : id, revision: item.revision, name: item.name, data: data, snapshot: snapshot, analysis: ForecastEngine.analyze(data), legacy: item.legacy};
}
function archiveBuild(id, revision) {
  return lock_(function () {
    var ss = spreadsheet_(), s = dbSheet_(ss, '_VF_Builds', BUILD_HEADERS_), rows = s.getDataRange().getValues();
    var i = rows.findIndex(function (r, j) { return j > 0 && r[0] === id; });
    if (i < 0) throw new Error('Select a v2 build to archive. Legacy builds are read-only here.');
    if (rows[i][4] !== revision) throw new Error('Build changed. Reload it before archiving.');
    s.getRange(i + 1, 6).setValue(true); SpreadsheetApp.flush();
    return savedList_(ss);
  });
}
function exportMatrices_(data, a) {
  function rows(headers, items, fields) { return [headers].concat(items.map(function (x) { return fields.map(function (f) { return x[f] == null ? '' : x[f]; }); })); }
  var tables = {};
  tables.Prediction = rows(['Delivery week', 'Horizon', 'Customer forecast', 'Model prediction', 'Change', 'Model', 'Blend', 'Reason'], a.predictions,
    ['week', 'horizon', 'customer', 'prediction', 'change', 'model', 'alpha', 'reason']);
  tables['Waterfall v2'] = [a.waterfall.headers].concat(a.waterfall.rows.map(function (r) { return [r.label].concat(r.values); }));
  tables['Comparison v2'] = rows(['Horizon', 'Cases', 'Distinct target weeks', 'Origins', 'Customer MAE', 'Model MAE', 'MAE improvement (fraction)', 'Customer RMSE', 'Model RMSE', 'Customer WAPE (fraction)', 'Model WAPE (fraction)', 'Customer bias', 'Model bias', 'Corrected cases'], a.byHorizon,
    ['horizon', 'cases', 'targets', 'origins', 'customerMAE', 'modelMAE', 'improvement', 'customerRMSE', 'modelRMSE', 'customerWAPE', 'modelWAPE', 'customerBias', 'modelBias', 'corrected']);
  tables['Backtest v2'] = rows(['Forecast version', 'Delivery week', 'Horizon', 'Customer', 'Actual', 'Model', 'Blend', 'Selected model', 'Reason'], a.backtest,
    ['origin', 'week', 'horizon', 'customer', 'actual', 'prediction', 'alpha', 'model', 'reason']);
  tables['21-week totals v2'] = rows(['Forecast version', 'Through', 'Customer total', 'Actual total', 'Model total'], a.totals, ['origin', 'through', 'customer', 'actual', 'prediction']);
  tables['Actuals v2'] = rows(['Week', 'Imported net quantity', 'Verified quantity', 'Status'], a.actuals, ['week', 'quantity', 'verified', 'status']);
  tables['Forecast v2'] = [['Version', 'Week', 'Total Demand', 'Material', 'Customer', 'Source row']].concat(data.forecast.map(function (r) { return [ForecastEngine.label(r.origin), ForecastEngine.label(r.target), r.forecast, r.material || '', r.customer || '', r.sourceRow]; }));
  tables['Expedice v2'] = rows(['Posting Date', 'Quantity', 'Material', 'Customer', 'Movement Type', 'Material Document', 'Unit of Entry', 'Source row'], data.shipments,
    ['date', 'quantity', 'material', 'customer', 'movement', 'document', 'unit', 'sourceRow']);
  tables['Model v2'] = [['Candidate', 'Training targets', 'Training rows', 'Lambda', 'Feature', 'RMS scale', 'Coefficient (scaled feature)', 'Coefficient (original feature)']];
  a.models.forEach(function (m, i) {
    if (!m) tables['Model v2'].push([ForecastEngine.candidates[i].id, '', '', '', 'Insufficient history', '', '', '']);
    else m.beta.forEach(function (b, j) { tables['Model v2'].push([m.id, m.targets, m.rows, m.lambda, a.featureNames[j], m.rms[j], b, b / m.rms[j]]); });
  });
  tables['Settings v2'] = [['Setting', 'Value'], ['Engine', a.version], ['As of forecast version', a.origin], ['Material', a.material], ['Customer', a.customer], ['Unit', a.unit],
    ['Complete from', a.options.actualFrom], ['Complete through', a.options.actualThrough], ['Missing weeks are confirmed zero', a.options.missingZero],
    ['Quantity convention', a.options.signMode], ['Availability lag (weeks)', a.options.lag], ['SAP decade', a.options.decade],
    ['Training window (weeks)', 104], ['Validation window (weeks)', 52], ['Selection margin', 0.02], ['Minimum training targets (small/full)', '12 / 26'],
    ['Minimum exact-horizon validation cases', 6], ['Exact-horizon validation margin', 0.02],
    ['All-case customer MAE', a.overall.customerMAE], ['All-case model MAE', a.overall.modelMAE], ['Scored cases', a.overall.cases],
    ['Last 8 origins customer MAE', a.recent.customerMAE], ['Last 8 origins model MAE', a.recent.modelMAE],
    ['21-week total cases', a.totalMetrics.cases], ['21-week total customer MAE', a.totalMetrics.customerMAE], ['21-week total model MAE', a.totalMetrics.modelMAE],
    ['Interpretation', 'Walk-forward simulation; includes fallback cases. Overlapping cases are not independent. No guaranteed improvement.']];
  a.rules.forEach(function (r, i) { tables['Settings v2'].push(['Selected rule, weeks ' + ['1–3', '4–8', '9–21'][i], r.reason]); });
  a.importNotes.forEach(function (note, i) { tables['Settings v2'].push(['Data note ' + (i + 1), note]); });
  return tables;
}
function writeTables_(ss, tables) {
  Object.keys(tables).forEach(function (name) {
    var values = tables[name], s = ss.getSheetByName(name) || ss.insertSheet(name);
    size_(s, values.length, values[0].length);
    s.clearContents();
    s.getRange(1, 1, values.length, values[0].length).setValues(values.map(function (row) { return row.map(safeCell_); }));
    s.getRange(1, 1, 1, values[0].length).setFontWeight('bold').setBackground('#163b36').setFontColor('#ffffff');
    s.setFrozenRows(1); s.setColumnWidth(1, 170);
    if (name === 'Waterfall v2') { s.setFrozenColumns(1); s.getRange(2, 1, 1, values[0].length).setBackground('#dcfce7'); }
  });
  SpreadsheetApp.flush();
}
function publishTabs(data) {
  var a = ForecastEngine.analyze(data), tables = exportMatrices_(data, a);
  return lock_(function () { var ss = spreadsheet_(); writeTables_(ss, tables); return ss.getUrl(); });
}
function exportToGoogleSheet(data) {
  var a = ForecastEngine.analyze(data), tables = exportMatrices_(data, a);
  var ss = SpreadsheetApp.create('Valeo Forecast — ' + a.material + ' — ' + a.origin);
  ss.getSheets()[0].setName('Prediction'); writeTables_(ss, tables);
  return ss.getUrl();
}
