/* Virtual Stem Desk 2: a console-style stem mixer that runs entirely in the browser. Apache-2.0 licence. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var AUDIO_EXT = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac|aif|aiff)$/i, ABC_EXT = /\.abc$/i;
  var COLORS = ['--g0', '--g1', '--g2', '--g3', '--g4', '--g5', '--g6', '--g7'];
  var PEAK_BINS = 2000, N_DCA = 4, N_SCENES = 8, LAYER = 16;
  var LAW = [[0, -90], [0.1, -50], [0.25, -30], [0.5, -10], [0.75, 0], [1, 10]];      // fader position -> dB
  var EQ_DEF = [{ type: 'lowshelf', f: 100, g: 0, q: 0.7 }, { type: 'peaking', f: 400, g: 0, q: 1 }, { type: 'peaking', f: 2500, g: 0, q: 1 }, { type: 'highshelf', f: 8000, g: 0, q: 0.7 }];
  var EQ_NAME = ['LF', 'LM', 'HM', 'HF'];

  var S = {
    ctx: null, out: null, masterGain: null, anL: null, anR: null, clickGain: null,
    tracks: [], song: null, duration: 0, beats: [], groups: {}, sel: null,
    master: { db: 0, mute: false }, dcas: [], scenes: [], storeArmed: false,
    playing: false, pos: 0, startCtx: 0, startPos: 0, rate: 1,
    loop: { on: false, a: null, b: null }, click: { on: false, db: -6 },
    sources: [], clickTimer: null, nextBeat: 0, raf: 0, score: null, loadToken: 0, ovPeaks: null,
    markers: [], countT: 0, countOsc: [],
    midi: { access: null, mode: 'off', learn: false, target: null, map: {} }
  };
  for (var i0 = 0; i0 < N_DCA; i0++) S.dcas.push({ name: 'DCA ' + (i0 + 1), db: 0, mute: false });
  for (var i1 = 0; i1 < N_SCENES; i1++) S.scenes.push(null);

  /* ---------- helpers ---------- */
  function status(msg, err) { var el = $('status'); el.textContent = msg; el.className = 'status' + (err ? ' err' : ''); }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function db2g(db) { return db <= -89 ? 0 : Math.pow(10, db / 20); }
  function fmt(t) { t = Math.max(0, t); var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function baseName(f) { return f.replace(/^.*[\\/]/, ''); }
  function stemName(f) { return baseName(f).replace(/\.[^.]+$/, ''); }
  function dbTxt(db) { return db <= -89 ? '-inf' : (db > 0 ? '+' : '') + db.toFixed(1); }
  function pos2db(p) { p = clamp(p, 0, 1); for (var i = 1; i < LAW.length; i++) if (p <= LAW[i][0]) { var a = LAW[i - 1], b = LAW[i]; return a[1] + (b[1] - a[1]) * (p - a[0]) / (b[0] - a[0]); } return 10; }
  function db2pos(db) { db = clamp(db, -90, 10); for (var i = 1; i < LAW.length; i++) if (db <= LAW[i][1]) { var a = LAW[i - 1], b = LAW[i]; return a[0] + (b[0] - a[0]) * (db - a[1]) / (b[1] - a[1]); } return 1; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function ensureCtx() {
    if (S.ctx) return S.ctx;
    var AC = window.AudioContext || window.webkitAudioContext; try { S.ctx = S.wantRate ? new AC({ sampleRate: S.wantRate }) : new AC(); } catch (e) { S.ctx = new AC(); }
    S.out = S.ctx.createGain(); S.masterGain = S.ctx.createGain(); S.out.connect(S.masterGain); S.masterGain.connect(S.ctx.destination);
    var split = S.ctx.createChannelSplitter(2); S.anL = S.ctx.createAnalyser(); S.anR = S.ctx.createAnalyser(); S.anL.fftSize = S.anR.fftSize = 512;
    S.masterGain.connect(split); split.connect(S.anL, 0); split.connect(S.anR, 1);
    try { var kc = kCoef(S.ctx.sampleRate), k1 = S.ctx.createIIRFilter(kc[0].b, kc[0].a), k2 = S.ctx.createIIRFilter(kc[1].b, kc[1].a), ks = S.ctx.createChannelSplitter(2); S.kL = S.ctx.createAnalyser(); S.kR = S.ctx.createAnalyser(); S.kL.fftSize = S.kR.fftSize = 2048;
      S.masterGain.connect(k1); k1.connect(k2); k2.connect(ks); ks.connect(S.kL, 0); ks.connect(S.kR, 1); } catch (e) { S.kL = null; }
    S.clickGain = S.ctx.createGain(); S.clickGain.connect(S.ctx.destination);
    S.probe = EQ_DEF.map(function () { return S.ctx.createBiquadFilter(); }); S.probeHp = S.ctx.createBiquadFilter(); S.probeHp.type = 'highpass';
    return S.ctx;
  }
  function sniffRate(ab) {            // the file's own sample rate (WAV and FLAC headers), so the desk can run at it instead of resampling
    try { var v = new DataView(ab), tag = function (o) { return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); };
      if (tag(0) === 'fLaC') return (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4);
      if (tag(0) === 'RIFF' && tag(8) === 'WAVE') { var o = 12; while (o + 8 < v.byteLength) { var n = v.getUint32(o + 4, true); if (tag(o) === 'fmt ') return v.getUint32(o + 12, true); o += 8 + n + (n & 1); } }
      var p = 0; if (tag(0).slice(0, 3) === 'ID3') p = 10 + ((v.getUint8(6) & 127) << 21 | (v.getUint8(7) & 127) << 14 | (v.getUint8(8) & 127) << 7 | (v.getUint8(9) & 127));      // MP3: skip the tag, read the first frame header
      for (var end = Math.min(v.byteLength - 4, p + 8192); p < end; p++) if (v.getUint8(p) === 255 && (v.getUint8(p + 1) & 224) === 224) { var ver = (v.getUint8(p + 1) >> 3) & 3, layer = (v.getUint8(p + 1) >> 1) & 3, si = (v.getUint8(p + 2) >> 2) & 3; if (ver !== 1 && layer === 1 && si < 3) return [44100, 48000, 32000][si] >> (ver === 3 ? 0 : ver === 2 ? 1 : 2); }
    } catch (e) {} return 0;
  }
  function matchRate(ab) { var r = sniffRate(ab); if (r >= 44100 && r <= 96000 && !S.tracks.length && (!S.ctx || S.ctx.sampleRate !== r)) { if (S.ctx) { try { S.ctx.close(); } catch (e) {} S.ctx = null; } S.wantRate = r; } return ab; }
  function decode(ab) { return new Promise(function (res, rej) { var p = ensureCtx().decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); }); }

  /* ---------- collecting files ---------- */
  function readEntries(entry) {
    return new Promise(function (resolve) {
      if (entry.isFile) { entry.file(function (f) { resolve([f]); }, function () { resolve([]); }); return; }
      var reader = entry.createReader(), all = [];
      (function next() { reader.readEntries(function (list) {
        if (!list.length) { Promise.all(all.map(readEntries)).then(function (r) { resolve([].concat.apply([], r)); }); return; }
        all = all.concat(Array.prototype.slice.call(list)); next();
      }, function () { resolve([]); }); })();
    });
  }
  function filesFromDrop(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [], entries = items.map(function (i) { return i.webkitGetAsEntry ? i.webkitGetAsEntry() : null; }).filter(Boolean);
    if (!entries.length) return Promise.resolve(Array.prototype.slice.call(dt.files || []));
    return Promise.all(entries.map(readEntries)).then(function (r) { return [].concat.apply([], r); });
  }
  function textOf(file) { return file.text ? file.text() : new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsText(file); }); }
  function bufOf(file) { return file.arrayBuffer ? file.arrayBuffer() : new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); }); }

  /* ---------- loading ---------- */
  function at(t) { return t.offset + t.lead; }     // where the track's audio starts on the song's clock: the user's timing nudge plus any silence trimmed from its head
  function trimSilence(buf) {        // stems are often silent for most of the song; keeping only the part that sounds can halve the memory. The cut is on whole samples and the timing is kept.
    var n = buf.length, sr = buf.sampleRate, chs = [], c, i, TH = 1e-6; for (c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    var head = n, tail = 0; for (c = 0; c < chs.length; c++) { var x = chs[c]; for (i = 0; i < head; i++) if (x[i] > TH || x[i] < -TH) { head = i; break; } for (i = n - 1; i >= tail; i--) if (x[i] > TH || x[i] < -TH) { tail = i + 1; break; } }
    if (head >= tail) return { buf: buf, lead: 0, cut: 0 };
    var pad = Math.round(0.05 * sr); head = Math.max(0, head - pad); tail = Math.min(n, tail + pad); if (n - (tail - head) < 2 * sr) return { buf: buf, lead: 0, cut: 0 };
    var out = S.ctx.createBuffer(chs.length, tail - head, sr); for (c = 0; c < chs.length; c++) out.getChannelData(c).set(chs[c].subarray(head, tail));
    return { buf: out, lead: head / sr, cut: (n - (tail - head)) / sr, full: n / sr };
  }
  function newTrack(file, buf, sp) {
    var tr = trimSilence(buf); buf = tr.buf;
    return { file: file, lead: tr.lead, cut: tr.cut, fullDur: tr.full || buf.duration, name: sp.name || stemName(file), group: sp.group || '', buffer: buf, peaks: peaksOf(buf), db: sp.gainDb || 0, pan: sp.pan || 0, mute: !!sp.mute, solo: false, offset: +sp.offset || 0,
      dca: [false, false, false, false], hpf: { on: false, f: 80 }, eqOn: false, eq: EQ_DEF.map(function (b) { return { type: b.type, f: b.f, g: 0, q: b.q }; }),
      comp: { on: false, thr: -18, ratio: 3, att: 10, rel: 150, trim: 0 }, nodes: null, peak: -90, hold: -90, holdT: 0, link: false, snap: null, def: { order: S.tracks.length, db: sp.gainDb || 0, pan: sp.pan || 0, mute: !!sp.mute, offset: +sp.offset || 0 } };
  }
  function loadFiles(files, append) {
    files = files.filter(function (f) { return !/^\./.test(f.name); });
    var audio = files.filter(function (f) { return AUDIO_EXT.test(f.name); }), jsonF = files.filter(function (f) { return /\.json$/i.test(f.name); }), abcF = files.filter(function (f) { return ABC_EXT.test(f.name); })[0];
    if (!audio.length) { status('No audio files found. Supported: WAV, MP3, FLAC, OGG, M4A.', true); return Promise.resolve(); }
    var token = ++S.loadToken; if (!append) closeSong(true); else stopPlayback();
    status('Reading ' + audio.length + ' audio file' + (audio.length === 1 ? '' : 's') + '…');
    return Promise.all(jsonF.map(function (f) { return textOf(f).then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } }); })).then(function (objs) {
      var song = objs.filter(function (o) { return o && (o.tracks || o.bpm || o.sections || o.beats) && o.app !== 'virtual-stem-desk'; })[0];
      if (!append || !S.song) S.song = song || {}; else if (song) S.song = song;
      return (abcF ? textOf(abcF) : Promise.resolve(null)).then(function (abc) { if (abc) S.song._abcText = abc; return addAudio(audio, S.song, token); });
    }).then(function () { if (token === S.loadToken) finishLoad(); });
  }
  function addAudio(files, song, token) {
    var spec = {}; (song.tracks || []).forEach(function (t, i) { spec[baseName(t.file || '').toLowerCase()] = { t: t, i: i }; });
    files.sort(function (a, b) { var sa = spec[a.name.toLowerCase()], sb = spec[b.name.toLowerCase()]; if (sa && sb) return sa.i - sb.i; if (sa) return -1; if (sb) return 1; return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var done = 0, bytes = S.tracks.reduce(function (a, t) { return a + t.buffer.length * t.buffer.numberOfChannels * 4; }, 0);
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        if (token !== S.loadToken) return;
        return bufOf(f).then(matchRate).then(decode).then(function (buf) {
          if (token !== S.loadToken) return;
          S.tracks.push(newTrack(f.name, buf, (spec[f.name.toLowerCase()] || {}).t || {}));
          done++; var kept = S.tracks[S.tracks.length - 1].buffer; bytes += kept.length * kept.numberOfChannels * 4; status('Decoded ' + done + ' of ' + files.length + ' (' + f.name + '). About ' + Math.round(bytes / 1048576) + ' MB of audio in memory.');
        }).catch(function () { status('Could not decode ' + f.name + '. It was skipped.', true); });
      });
    }, Promise.resolve());
  }
  function peaksOf(buf) {
    var n = buf.length, per = Math.max(1, Math.floor(n / PEAK_BINS)), bins = Math.ceil(n / per), out = new Float32Array(bins), chs = [];
    for (var c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    for (var b = 0; b < bins; b++) { var m = 0, e = Math.min(n, (b + 1) * per); for (var i = b * per; i < e; i += 4) for (var k = 0; k < chs.length; k++) { var v = Math.abs(chs[k][i]); if (v > m) m = v; } out[b] = m; }
    return out;
  }
  function finishLoad(noRestore) {
    if (!S.tracks.length) { status('No audio could be decoded.', true); return; }
    var song = S.song || (S.song = {}); S.duration = Math.max.apply(null, S.tracks.map(function (t) { return t.offset + t.fullDur; })); S.groups = {};
    S.tracks.forEach(function (t) { if (!(t.group in S.groups)) S.groups[t.group] = COLORS[Object.keys(S.groups).length % COLORS.length]; });
    if (!S.sel || S.tracks.indexOf(S.sel) < 0) S.sel = S.tracks[0];
    if (!S.tracks.some(function (t) { return t.dca.some(Boolean); })) {      // nothing assigned yet: give each of the first four groups of two or more tracks its own DCA
      var gs = Object.keys(S.groups).filter(function (g) { return g && S.tracks.filter(function (t) { return t.group === g; }).length > 1; }).slice(0, N_DCA);
      S.dcas.forEach(function (d, i) { d.name = gs[i] || 'DCA ' + (i + 1); }); S.tracks.forEach(function (t) { var k = gs.indexOf(t.group); if (k >= 0) t.dca[k] = true; });
    }
    buildBeats(); buildStrips(); buildSections(); buildScore(); buildOverviewPeaks();
    $('songTitle').textContent = song.title || (S.tracks.length + (S.tracks.length === 1 ? ' stem' : ' stems')); document.title = (song.title ? song.title + ' · ' : '') + 'Virtual Stem Desk';
    ['play', 'stop', 'loopBtn', 'rate', 'saveMix', 'loadMix', 'exportWav', 'clearAll', 'resetDesk', 'markBtn', 'countIn', 'repeatBtn'].forEach(function (id) { $(id).disabled = false; });
    $('clickBtn').disabled = $('clickVol').disabled = !S.beats.length;
    $('drop').hidden = true; $('deskMain').hidden = false; fitStrips(); S.ready = false; var back = !noRestore && restoreSaved(); S.ready = true; applyMix(); showSelected(); drawOverview(); tickUI();
    status((back ? 'Your last desk for this song was restored (More > Reset desk goes back to the song defaults). ' : '') + 'Loaded ' + S.tracks.length + ' stem' + (S.tracks.length === 1 ? '' : 's') + ', ' + fmt(S.duration) + (S.beats.length ? ', ' + (song.bpm ? song.bpm + ' bpm' : 'beat grid from song.json') : '. No tempo given, so the metronome is off: add a song.json with "bpm" to enable it') + '.');
  }
  function closeSong(quiet) {
    S.ready = false; stopPlayback(); S.markers = []; buildMarkers(); S.dcas.forEach(function (d, i) { d.name = 'DCA ' + (i + 1); d.db = 0; d.mute = false; }); S.tracks = []; S.song = null; S.duration = 0; S.beats = []; S.pos = 0; S.loop = { on: false, a: null, b: null }; S.score = null; S.sel = null;
    $('strips').innerHTML = ''; $('groups').innerHTML = ''; $('sections').innerHTML = ''; $('paper').innerHTML = ''; showPage('proc'); $('deskMain').hidden = true; $('drop').hidden = false;
    $('selTag').textContent = ''; $('songTitle').textContent = 'No song loaded'; $('loopBtn').setAttribute('aria-pressed', 'false'); $('loopBox').hidden = true;
    ['play', 'stop', 'loopBtn', 'rate', 'saveMix', 'loadMix', 'exportWav', 'clearAll', 'clickBtn', 'clickVol', 'markBtn', 'countIn', 'resetDesk', 'repeatBtn'].forEach(function (id) { $(id).disabled = true; });
    if (!quiet) status('Song closed.');
  }
  function removeTrack(t) {
    var i = S.tracks.indexOf(t); if (i < 0) return; var p = curPos(); stopPlayback(); if (S.tracks[i - 1]) S.tracks[i - 1].link = false; S.tracks.splice(i, 1);
    if (!S.tracks.length) { closeSong(true); status('Removed ' + t.name + '. The desk is empty.'); return; }
    S.sel = S.tracks[Math.min(i, S.tracks.length - 1)]; finishLoad(); S.pos = Math.min(p, S.duration); tickUI();
    status('Removed ' + t.name + '. ' + S.tracks.length + ' track' + (S.tracks.length === 1 ? '' : 's') + ' left. The file on your disk is untouched.');
  }

  /* ---------- tempo grid ---------- */
  function buildBeats() {
    var s = S.song, out = [];
    if (Array.isArray(s.beats) && s.beats.length) out = s.beats.map(function (b) { return Array.isArray(b) ? { t: +b[0], bar: b[1], n: b[2] || 1 } : { t: +b.time, bar: b.bar, n: b.beat || 1 }; });
    else if (s.bpm > 0) {
      var per = parseInt(String(s.meter || '4/4').split('/')[0], 10) || 4, beat = 60 / s.bpm, d0 = +s.firstDownbeat || 0, k0 = -Math.floor(d0 / beat + 1e-9);
      for (var k = k0; d0 + k * beat < S.duration; k++) { var n = ((k % per) + per) % per; out.push({ t: d0 + k * beat, bar: Math.floor(k / per) + 1, n: n + 1 }); }
    }
    S.beats = out.filter(function (b) { return b.t >= -1e-6 && b.t < S.duration; });
  }
  function beatAt(t) { var b = S.beats, lo = 0, hi = b.length - 1, r = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (b[m].t <= t + 1e-6) { r = m; lo = m + 1; } else hi = m - 1; } return r; }

  /* ---------- the mix: who is heard, at what level ---------- */
  function dcaMuted(t) { return t.dca.some(function (on, i) { return on && S.dcas[i].mute; }); }
  function dcaDb(t) { return t.dca.reduce(function (a, on, i) { return a + (on ? S.dcas[i].db : 0); }, 0); }
  function audible(t) { var anySolo = S.tracks.some(function (x) { return x.solo; }); return !t.mute && !dcaMuted(t) && (anySolo ? t.solo : true); }
  function levelOf(t) { return audible(t) ? db2g(t.db + dcaDb(t)) : 0; }
  function setParam(p, v) { if (S.ctx) p.setTargetAtTime(v, S.ctx.currentTime, 0.012); else p.value = v; }
  function applyProc(t, n) {            // write a track's processing settings into its nodes (n = live nodes or offline nodes)
    var imm = !n.live, set = function (p, v) { if (imm) p.value = v; else setParam(p, v); };
    set(n.hpf.frequency, t.hpf.on ? t.hpf.f : 10);
    t.eq.forEach(function (b, i) { var f = n.eq[i]; f.type = b.type; set(f.frequency, b.f); set(f.Q, b.q); set(f.gain, t.eqOn ? b.g : 0); });
    var c = t.comp; set(n.comp.threshold, c.on ? c.thr : 0); set(n.comp.ratio, c.on ? c.ratio : 1); set(n.comp.knee, c.on ? 6 : 0); set(n.comp.attack, c.att / 1000); set(n.comp.release, c.rel / 1000);
    set(n.trim.gain, c.on ? db2g(c.trim) : 1);
  }
  var LINKED = ['db', 'mute', 'solo', 'dca', 'hpf', 'eqOn', 'eq', 'comp'];
  function linkSnap(t) { return JSON.stringify(LINKED.map(function (k) { return t[k]; })); }
  function syncLinks() {             // a linked pair moves as one: whichever side was just changed is copied to the other
    S.tracks.forEach(function (a, i) {
      var b = S.tracks[i + 1]; if (!a.link || !b) { a.link = false; a.snap = null; return; }
      var sa = linkSnap(a), sb = linkSnap(b), src = a.snap == null || sa !== a.snap ? a : (sb !== a.snap ? b : null);
      if (src) { var dst = src === a ? b : a, v = JSON.parse(linkSnap(src)); LINKED.forEach(function (k, n) { dst[k] = v[n]; }); }
      a.snap = linkSnap(a);
    });
  }
  function moveTrack(t, dir) {
    var i = S.tracks.indexOf(t), j = i + dir; if (i < 0 || j < 0 || j >= S.tracks.length) return;
    [i - 1, i, j - 1, j].forEach(function (k) { if (S.tracks[k]) { S.tracks[k].link = false; S.tracks[k].snap = null; } });
    S.tracks[i] = S.tracks[j]; S.tracks[j] = t; buildStrips(); applyMix(); showSelected(); t.ui.root.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function orderLike(list) { var pos = {}; (list || []).forEach(function (x, i) { pos[String(x.file).toLowerCase()] = i; }); var at = function (t) { var p = pos[t.file.toLowerCase()]; return p == null ? 1e6 + S.tracks.indexOf(t) : p; }; S.tracks = S.tracks.slice().sort(function (a, b) { return at(a) - at(b); }); }
  function applyMix() {
    syncLinks();
    S.tracks.forEach(function (t) {
      if (t.nodes) { setParam(t.nodes.fader.gain, levelOf(t)); if (t.nodes.pan) setParam(t.nodes.pan.pan, t.pan); applyProc(t, t.nodes); }
      if (t.ui) { t.ui.dbt.textContent = dbTxt(t.db); var ix = S.tracks.indexOf(t); t.ui.root.className = 'strip' + (t.link ? ' linkL' : '') + (ix > 0 && S.tracks[ix - 1].link ? ' linkR' : '') + (t.gfirst ? ' gfirst' : '') + (t === S.sel ? ' selected' : '') + (audible(t) ? '' : ' off'); t.ui.m.setAttribute('aria-pressed', t.mute ? 'true' : 'false'); t.ui.s.setAttribute('aria-pressed', t.solo ? 'true' : 'false'); t.ui.sel.setAttribute('aria-pressed', t === S.sel ? 'true' : 'false'); t.ui.fader.set(t.db); t.ui.pan.value = t.pan; }
    });
    S.dcas.forEach(function (d, i) { if (d.ui) { var k = S.tracks.filter(function (t) { return t.dca[i]; }).length; d.ui.num.textContent = 'D' + (i + 1) + ' · ' + (k ? k + ' ch' : 'empty'); d.ui.fader.set(d.db); d.ui.m.setAttribute('aria-pressed', d.mute ? 'true' : 'false'); } });
    if (S.master.ui) { S.master.ui.fader.set(S.master.db); S.master.ui.m.setAttribute('aria-pressed', S.master.mute ? 'true' : 'false'); }
    if (S.masterGain) setParam(S.masterGain.gain, S.master.mute ? 0 : db2g(S.master.db));
    var ns = S.tracks.filter(function (t) { return t.solo; }).length, nm = S.tracks.filter(function (t) { return t.mute; }).length;
    $('soloClear').disabled = !ns; $('soloClear').classList.toggle('lit', ns > 0); $('soloClear').textContent = ns ? 'Solo clear (' + ns + ')' : 'Solo clear'; $('muteClear').disabled = !nm; $('muteClear').textContent = nm ? 'Unmute all (' + nm + ')' : 'Unmute all';
    buildOverviewPeaks(); drawOverview(); saveSoon();
  }
  /* ---------- the desk remembers each song in this browser ---------- */
  function songKey() { return 'vsd2:' + ((S.song && S.song.title) || '') + '|' + S.tracks.map(function (t) { return t.file; }).sort().join(','); }
  function saveSoon() { if (!S.ready) return; clearTimeout(S.saveT); S.saveT = setTimeout(function () { try { var st = deskState(); st.scenes = S.scenes; localStorage.setItem(songKey(), JSON.stringify(st)); } catch (e) {} }, 400); }
  function restoreSaved() { try { var raw = localStorage.getItem(songKey()); if (!raw) return false; var m = JSON.parse(raw); if (Array.isArray(m.scenes)) { S.scenes = m.scenes.slice(0, N_SCENES); while (S.scenes.length < N_SCENES) S.scenes.push(null); } if (Array.isArray(m.dcaNames)) m.dcaNames.forEach(function (n, i) { if (S.dcas[i] && n) S.dcas[i].name = n; }); orderLike(m.tracks); buildStrips(); applyState(m); return true; } catch (e) { return false; } }
  function resetDesk() {
    try { localStorage.removeItem(songKey()); } catch (e) {} S.ready = false;
    S.tracks.sort(function (a, b) { return a.def.order - b.def.order; });
    S.tracks.forEach(function (t) { var d = t.def; t.link = false; t.snap = null; t.db = d.db; t.pan = d.pan; t.mute = d.mute; t.solo = false; t.offset = d.offset; t.dca = [false, false, false, false]; t.hpf = { on: false, f: 80 }; t.eqOn = false; t.eq = EQ_DEF.map(function (b) { return { type: b.type, f: b.f, g: 0, q: b.q }; }); t.comp = { on: false, thr: -18, ratio: 3, att: 10, rel: 150, trim: 0 }; });
    S.dcas.forEach(function (d, i) { d.name = 'DCA ' + (i + 1); d.db = 0; d.mute = false; }); S.master.db = 0; S.master.mute = false; S.scenes = S.scenes.map(function () { return null; }); S.markers = []; buildMarkers();
    var p = curPos(); stopPlayback(); finishLoad(true); S.pos = Math.min(p, S.duration); tickUI(); status('The desk is back to the way the song loads: levels from song.json, no processing, no scenes.');
  }

  /* ---------- console strips ---------- */
  function Fader(get, set, label) {      // a vertical fader: drag, wheel, arrow keys, double-click for 0 dB
    var root = el('div', 'fader'), cap = el('div', 'cap'), zero = el('div', 'zero'); [[10, '10'], [5, ''], [0, '0'], [-5, ''], [-10, '10'], [-20, ''], [-30, '30'], [-40, ''], [-50, '50']].forEach(function (k) { var tk = el('i', 'tick' + (k[1] ? ' lab' : ''), k[1]); tk.style.top = 'calc(6px + (100% - 12px) * ' + (1 - db2pos(k[0])).toFixed(4) + ')'; root.appendChild(tk); });
    root.appendChild(zero); root.appendChild(cap); root.tabIndex = 0;
    root.setAttribute('role', 'slider'); root.setAttribute('aria-label', label); root.setAttribute('aria-orientation', 'vertical'); root.setAttribute('aria-valuemin', '-90'); root.setAttribute('aria-valuemax', '10');
    function place(db) { var p = db2pos(db); cap.style.top = (6 + (1 - p) * (root.clientHeight - 12 || 178)) + 'px'; zero.style.top = (6 + (1 - 0.75) * (root.clientHeight - 12 || 178)) + 'px'; root.setAttribute('aria-valuenow', db.toFixed(1)); root.setAttribute('aria-valuetext', dbTxt(db) + ' dB'); }
    function fromY(e) { var r = root.getBoundingClientRect(); return pos2db(1 - clamp((e.clientY - r.top - 6) / (r.height - 12), 0, 1)); }
    var drag = null;                 // drag is relative: grabbing the fader anywhere never makes it jump; hold Shift for fine moves
    root.addEventListener('pointerdown', function (e) { root.setPointerCapture(e.pointerId); root.focus(); drag = { y: e.clientY, p: db2pos(get()) }; root.classList.add('drag'); midiTouch(label, set); });
    root.addEventListener('pointermove', function (e) { if (!drag) return; var h = root.getBoundingClientRect().height - 12, d = (drag.y - e.clientY) / h * (e.shiftKey ? 0.2 : 1); drag.p = clamp(drag.p + d, 0, 1); drag.y = e.clientY; set(Math.round(pos2db(drag.p) * 10) / 10); });
    var end = function () { drag = null; root.classList.remove('drag'); }; root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
    root.addEventListener('dblclick', function () { set(0); });
    root.addEventListener('wheel', function (e) { if (document.activeElement !== root) return; e.preventDefault(); set(clamp(get() + (e.deltaY < 0 ? 0.5 : -0.5), -90, 10)); }, { passive: false });
    root.addEventListener('keydown', function (e) { var d = { ArrowUp: 1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); set(clamp(get() + d, -90, 10)); } else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); set(0); } });
    return { root: root, set: place };
  }
  function keyBtn(cls, txt, label, fn) { var b = el('button', 'key ' + cls, txt); b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', 'false'); b.onclick = fn; return b; }
  function buildStrips() {
    var host = $('strips'); host.innerHTML = '';
    S.tracks.forEach(function (t, i) {
      var root = el('div', 'strip'); root.setAttribute('role', 'listitem'); t.gfirst = i > 0 && S.tracks[i - 1].group !== t.group; var plate = el('button', 'plate'); plate.appendChild(el('span', '', t.name)); plate.style.background = 'var(' + S.groups[t.group] + ')'; plate.title = t.name + (t.group ? ' · ' + t.group : '') + ' · ' + t.file; plate.onclick = function () { select(t, true); };
      var num = el('span', 'num', String(i + 1)), panw = el('div', 'panwrap'), pan = document.createElement('input'); pan.type = 'range'; pan.min = -1; pan.max = 1; pan.step = 0.05; pan.value = t.pan; pan.setAttribute('aria-label', t.name + ' pan'); pan.title = 'Pan (double-click to centre)';
      pan.oninput = function () { t.pan = +pan.value; applyMix(); }; pan.ondblclick = function () { t.pan = 0; applyMix(); }; panw.appendChild(pan);
      var fz = el('div', 'fz'), meter = el('canvas', 'meter'); meter.width = 12; meter.height = 190;
      var fader = Fader(function () { return t.db; }, function (db) { t.db = db; dbt.textContent = dbTxt(db); applyMix(); }, t.name + ' fader');
      var dbt = el('span', 'dbtxt', dbTxt(t.db)), keys = el('div', 'keys');
      var m = keyBtn('m', 'M', 'Mute ' + t.name, function () { t.mute = !t.mute; applyMix(); }), s = keyBtn('s', 'S', 'Solo ' + t.name, function () { t.solo = !t.solo; applyMix(); }), sel = keyBtn('sel wide', 'Sel', 'Select ' + t.name, function () { select(t); });
      fz.appendChild(meter); fz.appendChild(fader.root); keys.appendChild(sel); keys.appendChild(m); keys.appendChild(s);
      [plate, num, panw, fz, dbt, keys].forEach(function (x) { root.appendChild(x); }); host.appendChild(root);
      t.ui = { root: root, m: m, s: s, sel: sel, fader: fader, pan: pan, meter: meter, dbt: dbt };
    });
    var g = $('groups'); g.innerHTML = '';
    S.dcas.forEach(function (d, i) {
      var root = el('div', 'strip dca'), plate = el('div', 'plate', d.name); plate.style.background = 'var(' + (S.groups[d.name] || '--accent') + ')'; var num = el('span', 'num', 'DCA ' + (i + 1)), sp = el('div', 'panwrap none'), fz = el('div', 'fz'), blank = el('div', 'meter'); plate.title = 'DCA ' + (i + 1) + ': one fader and one Mute for every channel assigned to it. Assign channels with the DCA keys of the selected channel (Processing page).';
      var dbt = el('span', 'dbtxt', dbTxt(d.db)), fader = Fader(function () { return d.db; }, function (db) { d.db = db; dbt.textContent = dbTxt(db); applyMix(); }, d.name + ' fader'), keys = el('div', 'keys');
      var m = keyBtn('m wide', 'Mute', 'Mute ' + d.name, function () { d.mute = !d.mute; applyMix(); });
      fz.appendChild(blank); fz.appendChild(fader.root); keys.appendChild(m); [plate, num, sp, fz, dbt, keys].forEach(function (x) { root.appendChild(x); }); g.appendChild(root); d.ui = { fader: fader, m: m, dbt: dbt, num: num };
    });
    var mr = el('div', 'strip master'), mp = el('div', 'plate', 'Main LR'); mp.style.background = 'var(--mute)'; mp.style.color = '#fff'; var mn = el('span', 'num', 'master'), msp = el('div', 'panwrap none'), mfz = el('div', 'fz'), mm = el('canvas', 'meter'); mm.width = 16; mm.height = 190;
    var mdb = el('span', 'dbtxt', dbTxt(S.master.db)), mf = Fader(function () { return S.master.db; }, function (db) { S.master.db = db; mdb.textContent = dbTxt(db); applyMix(); }, 'Main fader'), mk = el('div', 'keys');
    var mmute = keyBtn('m wide', 'Mute', 'Mute main', function () { S.master.mute = !S.master.mute; applyMix(); });
    mfz.appendChild(mm); mfz.appendChild(mf.root); mk.appendChild(mmute); [mp, mn, msp, mfz, mdb, mk].forEach(function (x) { mr.appendChild(x); }); g.appendChild(mr); S.master.ui = { fader: mf, m: mmute, meter: mm, dbt: mdb };
    fitStrips();
    var L = $('layers'); L.innerHTML = '';
    for (var a = 0; a < S.tracks.length; a += LAYER) (function (a) { var b = el('button', 'key', (a + 1) + '–' + Math.min(S.tracks.length, a + LAYER)); b.onclick = function () { S.tracks[a].ui.root.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' }); }; L.appendChild(b); })(a);
    var sc = $('scenes'); sc.innerHTML = '';
    S.scenes.forEach(function (_, i) { var b = el('button', 'key d', String(i + 1)); b.setAttribute('aria-label', 'Scene ' + (i + 1)); b.setAttribute('aria-pressed', S.scenes[i] ? 'true' : 'false'); b.title = 'Scene ' + (i + 1) + (S.scenes[i] ? ': stored. Click to recall.' : ': empty.'); b.onclick = function () { sceneKey(i); }; sc.appendChild(b); });
    var da = $('dcaAssign'); da.innerHTML = ''; da.appendChild(el('span', 'lab', 'DCA'));
    S.dcas.forEach(function (d, i) { var b = keyBtn('d', String(i + 1), 'Assign to ' + d.name, function () { if (!S.sel) return; S.sel.dca[i] = !S.sel.dca[i]; showSelected(); applyMix(); }); da.appendChild(b); d.assignBtn = b; });
  }
  function fitStrips() {             // make every strip visible when the window allows it; otherwise keep a usable width and scroll
    var host = $('strips'), n = S.tracks.length; if (!n) return; var seps = S.tracks.filter(function (t) { return t.gfirst; }).length, avail = host.clientWidth - 12 - seps * 9;
    var w = clamp(Math.floor(avail / n) - 2, 56, 78); host.style.setProperty('--strip-w', w + 'px'); host.classList.remove('scrolls'); host.classList.toggle('scrolls', host.scrollWidth > host.clientWidth + 1);
    S.tracks.forEach(function (t) { if (t.ui) t.ui.fader.set(t.db); });
  }
  function select(t, keepPage) { S.sel = t; applyMix(); if (!keepPage && S.page !== 'wave') showPage('proc'); showSelected(); if (S.page === 'wave') drawWave(curPos()); }

  /* ---------- selected channel: processing ---------- */
  function hz(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz'; }
  function bindRange(id, read, write, show) { var r = $(id), o = $(id + 'Txt'); r.oninput = function () { if (!S.sel) return; write(S.sel, +r.value); if (o) o.textContent = show(+r.value); applyMix(); drawEq(); }; return function () { if (!S.sel) return; r.value = read(S.sel); if (o) o.textContent = show(+r.value); }; }
  var syncers = [];
  function buildChannelPanel() {
    syncers.push(bindRange('hpfF', function (t) { return t.hpf.f; }, function (t, v) { t.hpf.f = v; }, hz));
    syncers.push(bindRange('cThr', function (t) { return t.comp.thr; }, function (t, v) { t.comp.thr = v; }, function (v) { return v + ' dB'; }));
    syncers.push(bindRange('cRat', function (t) { return t.comp.ratio; }, function (t, v) { t.comp.ratio = v; }, function (v) { return v.toFixed(1) + ':1'; }));
    syncers.push(bindRange('cAtt', function (t) { return t.comp.att; }, function (t, v) { t.comp.att = v; }, function (v) { return v + ' ms'; }));
    syncers.push(bindRange('cRel', function (t) { return t.comp.rel; }, function (t, v) { t.comp.rel = v; }, function (v) { return v + ' ms'; }));
    syncers.push(bindRange('cMk', function (t) { return t.comp.trim; }, function (t, v) { t.comp.trim = v; }, function (v) { return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'; }));
    $('hpfOn').onclick = function () { if (S.sel) { S.sel.hpf.on = !S.sel.hpf.on; showSelected(); applyMix(); } };
    $('eqOn').onclick = function () { if (S.sel) { S.sel.eqOn = !S.sel.eqOn; showSelected(); applyMix(); } };
    $('compOn').onclick = function () { if (S.sel) { S.sel.comp.on = !S.sel.comp.on; showSelected(); applyMix(); } };
    $('removeTrack').onclick = function () { if (S.sel) removeTrack(S.sel); };
    $('moveL').onclick = function () { if (S.sel) moveTrack(S.sel, -1); }; $('moveR').onclick = function () { if (S.sel) moveTrack(S.sel, 1); };
    $('linkBtn').onclick = function () { var t = S.sel, i = S.tracks.indexOf(t); if (!t) return; if (i > 0 && S.tracks[i - 1].link && !t.link) { t = S.tracks[i - 1]; i--; } if (!S.tracks[i + 1]) { status('There is no channel to the right to link with.'); return; }
      t.link = !t.link; t.snap = null; if (t.link && S.tracks[i + 2]) { S.tracks[i + 1].link = false; } if (t.link && i > 0) S.tracks[i - 1].link = false; applyMix(); showSelected(); status(t.link ? 'Linked ' + t.name + ' and ' + S.tracks[i + 1].name + ': fader, mute, solo, DCA and processing now move together. Pan and timing stay separate.' : 'Link removed.'); };
    var host = $('eqBands');
    EQ_DEF.forEach(function (d, i) {
      var band = el('div', 'band'); band.appendChild(el('b', '', EQ_NAME[i] + (d.type === 'peaking' ? '' : ' shelf')));
      [['F', 'f', 0, 1000, 1, function (v) { return hz(lin2f(v)); }], ['G', 'g', -15, 15, 0.5, function (v) { return (v > 0 ? '+' : '') + v.toFixed(1); }], ['Q', 'q', 0.3, 8, 0.1, function (v) { return v.toFixed(1); }]].forEach(function (p) {
        if (p[1] === 'q' && d.type !== 'peaking') { band.appendChild(el('div', 'knob')); return; }
        var lab = el('label', 'knob', p[0]), r = document.createElement('input'), o = el('output'); r.type = 'range'; r.min = p[2]; r.max = p[3]; r.step = p[4]; r.setAttribute('aria-label', EQ_NAME[i] + ' ' + { f: 'frequency', g: 'gain', q: 'width' }[p[1]]);
        r.oninput = function () { if (!S.sel) return; var v = +r.value; S.sel.eq[i][p[1]] = p[1] === 'f' ? lin2f(v) : v; o.textContent = p[5](v); if (p[1] === 'g' && v !== 0 && !S.sel.eqOn) { S.sel.eqOn = true; $('eqOn').setAttribute('aria-pressed', 'true'); } applyMix(); drawEq(); };
        r.ondblclick = function () { r.value = p[1] === 'f' ? f2lin(d.f) : (p[1] === 'g' ? 0 : d.q); r.oninput(); };
        lab.appendChild(r); lab.appendChild(o); band.appendChild(lab);
        syncers.push(function () { if (!S.sel) return; var v = S.sel.eq[i][p[1]]; r.value = p[1] === 'f' ? f2lin(v) : v; o.textContent = p[5](+r.value); });
      });
      host.appendChild(band);
    });
  }
  function lin2f(v) { return 20 * Math.pow(1000, v / 1000); }       // 0..1000 -> 20 Hz..20 kHz
  function f2lin(f) { return 1000 * Math.log(f / 20) / Math.log(1000); }
  function showSelected() {
    var t = S.sel; if (!t) { $('selName').textContent = 'No channel selected'; $('selFile').textContent = ''; return; }
    $('selTag').textContent = (S.tracks.indexOf(t) + 1) + ' · ' + t.name; $('selTag').style.borderColor = 'var(' + S.groups[t.group] + ')';
    $('selName').textContent = (S.tracks.indexOf(t) + 1) + ' · ' + t.name; $('selFile').textContent = (t.group ? t.group + ' · ' : '') + t.file + ' · ' + (t.buffer.numberOfChannels === 1 ? 'mono' : 'stereo') + ', ' + t.buffer.sampleRate + ' Hz' + (t.cut ? ', ' + Math.round(t.cut) + ' s of silence not kept in memory' : '');
    $('selChip').style.background = 'var(' + S.groups[t.group] + ')'; $('hpfOn').setAttribute('aria-pressed', t.hpf.on ? 'true' : 'false'); $('eqOn').setAttribute('aria-pressed', t.eqOn ? 'true' : 'false'); $('compOn').setAttribute('aria-pressed', t.comp.on ? 'true' : 'false');
    S.dcas.forEach(function (d, i) { if (d.assignBtn) d.assignBtn.setAttribute('aria-pressed', t.dca[i] ? 'true' : 'false'); });
    var si = S.tracks.indexOf(t), inPair = t.link || (si > 0 && S.tracks[si - 1].link); $('linkBtn').setAttribute('aria-pressed', inPair ? 'true' : 'false'); $('linkBtn').textContent = inPair ? 'Linked' : 'Link with next'; $('moveL').disabled = si <= 0; $('moveR').disabled = si >= S.tracks.length - 1;
    syncers.forEach(function (f) { f(); }); drawEq();
    $('nudgeTxt').textContent = (t.offset > 0 ? '+' : '') + Math.round(t.offset * 1000) + ' ms'; $('waveName').textContent = (S.tracks.indexOf(t) + 1) + ' · ' + t.name; $('waveChip').style.background = 'var(' + S.groups[t.group] + ')';
  }
  function drawEq() {
    var cv = $('eqCurve'), t = S.sel; if (!t || !S.ctx) return; var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); } var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var n = 160, fr = new Float32Array(n), mag = new Float32Array(n), ph = new Float32Array(n), tot = new Float32Array(n); for (var i = 0; i < n; i++) fr[i] = 20 * Math.pow(1000, i / (n - 1));
    if (t.eqOn) t.eq.forEach(function (b, k) { var f = S.probe[k]; f.type = b.type; f.frequency.value = b.f; f.Q.value = b.q; f.gain.value = b.g; f.getFrequencyResponse(fr, mag, ph); for (var j = 0; j < n; j++) tot[j] += 20 * Math.log10(mag[j] || 1e-6); });
    if (t.hpf.on) { S.probeHp.frequency.value = t.hpf.f; S.probeHp.getFrequencyResponse(fr, mag, ph); for (var j2 = 0; j2 < n; j2++) tot[j2] += 20 * Math.log10(mag[j2] || 1e-6); }
    var y = function (db) { return h / 2 - db / 18 * (h / 2 - 4); }; g.strokeStyle = css('--line'); g.lineWidth = 1; g.fillStyle = css('--muted'); g.font = '10px ui-monospace, monospace';
    [100, 1000, 10000].forEach(function (f) { var x = Math.log(f / 20) / Math.log(1000) * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, h - 3); });
    [-12, 0, 12].forEach(function (d) { g.beginPath(); g.moveTo(0, y(d)); g.lineTo(w, y(d)); g.stroke(); }); g.fillText('+12', 3, y(12) + 10); g.fillText('-12', 3, y(-12) - 3);
    g.strokeStyle = (t.eqOn || t.hpf.on) ? css('--ok') : css('--muted'); g.lineWidth = 2; g.beginPath(); for (var k2 = 0; k2 < n; k2++) { var x2 = k2 / (n - 1) * w, yy = clamp(y(tot[k2]), 1, h - 1); if (k2) g.lineTo(x2, yy); else g.moveTo(x2, yy); } g.stroke();
  }

  /* ---------- waveform page: the selected track against the beat grid, with a time nudge ---------- */
  function nudge(ms) {
    var t = S.sel; if (!t) return; t.offset = Math.round((t.offset * 1000 + ms)) / 1000; if (Math.abs(t.offset) < 0.0005) t.offset = 0;
    S.duration = Math.max.apply(null, S.tracks.map(function (x) { return x.offset + x.fullDur; })); showSelected(); buildOverviewPeaks(); drawOverview();
    if (S.playing) startPlayback(curPos()); else drawWave(curPos());
  }
  function drawWave(p) {
    var cv = $('waveCv'), t = S.sel; if (!t || $('paneWave').hidden) return; var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var z = +$('waveZoom').value, span = z || S.duration, t0 = z ? Math.floor(p / (span * 0.8)) * span * 0.8 - span * 0.1 : 0; S.wv = { t0: t0, span: span };   // page by page, so the picture stands still while you read it
    var X = function (tt) { return (tt - t0) / span * w; }, mid = h / 2 + 4, amp = h / 2 - 20;
    g.font = '10px ui-monospace, monospace'; g.textBaseline = 'top';
    var bpx = S.beats.length > 1 ? (S.beats[1].t - S.beats[0].t) / span * w : 99;
    S.beats.forEach(function (b) { if (b.t < t0 || b.t > t0 + span) return; var x = X(b.t), bar = b.n === 1; if (!bar && bpx < 5) return; g.fillStyle = bar ? '#4a5568' : css('--line'); g.fillRect(x, bar ? 0 : 14, 1, h); if (bar && (bpx * 6 > 26 || b.bar % 4 === 1)) { g.fillStyle = css('--muted'); g.fillText(String(b.bar), x + 3, 2); } });
    if (!S.beats.length) { var st = [0.5, 1, 2, 5, 10, 30, 60].filter(function (q) { return span / q <= 16; })[0] || 60; g.fillStyle = css('--muted'); for (var q = Math.ceil(t0 / st) * st; q < t0 + span; q += st) { if (q < 0) continue; g.fillRect(X(q), 0, 1, h); g.fillText(fmt(q), X(q) + 3, 2); } }
    var chs = []; for (var c = 0; c < t.buffer.numberOfChannels; c++) chs.push(t.buffer.getChannelData(c)); var sr = t.buffer.sampleRate, n = t.buffer.length, gain = Math.min(8, 0.9 / (t.pmax || (t.pmax = Math.max.apply(null, Array.prototype.slice.call(t.peaks).concat([1e-4])))));
    g.fillStyle = css(S.groups[t.group]) || css('--accent');
    for (var x = 0; x < w; x++) {
      var a = Math.floor((t0 + x / w * span - at(t)) * sr), b2 = Math.floor((t0 + (x + 1) / w * span - at(t)) * sr); if (b2 <= 0 || a >= n) continue; a = Math.max(0, a); b2 = Math.min(n, Math.max(a + 1, b2));
      var lo = 0, hi = 0, step = Math.max(1, Math.floor((b2 - a) / 512)); for (var i = a; i < b2; i += step) for (var k = 0; k < chs.length; k++) { var v = chs[k][i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      var y1 = mid - Math.min(1, hi * gain) * amp, y2 = mid - Math.max(-1, lo * gain) * amp; g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.fillStyle = '#fff'; g.fillRect(X(p), 0, 2, h);
    $('waveInfo').textContent = fmt(Math.max(0, t0)) + ' to ' + fmt(Math.min(S.duration, t0 + span)) + ' · display gain +' + (20 * Math.log10(gain)).toFixed(0) + ' dB';
  }

  /* ---------- scenes, sections, score ---------- */
  function deskState() { return { app: 'virtual-stem-desk', version: 2, markers: S.markers.map(function (m) { return { t: m.t, name: m.name }; }), dcaNames: S.dcas.map(function (d) { return d.name; }), title: (S.song && S.song.title) || '', master: { db: S.master.db, mute: S.master.mute }, click: { on: S.click.on, db: S.click.db }, dcas: S.dcas.map(function (d) { return { db: d.db, mute: d.mute }; }),
    tracks: S.tracks.map(function (t) { return { file: t.file, link: !!t.link, offset: t.offset, db: t.db, pan: t.pan, mute: t.mute, solo: t.solo, dca: t.dca.slice(), hpf: { on: t.hpf.on, f: t.hpf.f }, eqOn: t.eqOn, eq: t.eq.map(function (b) { return { f: b.f, g: b.g, q: b.q }; }), comp: JSON.parse(JSON.stringify(t.comp)) }; }) }; }
  function applyState(m, isScene) {
    if (!isScene && Array.isArray(m.markers)) { S.markers = m.markers.filter(function (x) { return x && isFinite(x.t); }).map(function (x) { return { t: +x.t, name: String(x.name || 'Marker') }; }); buildMarkers(); }
    var by = {}, hit = 0; (m.tracks || []).forEach(function (t) { by[String(t.file).toLowerCase()] = t; });
    S.tracks.forEach(function (t) { var s = by[t.file.toLowerCase()]; if (!s) return; hit++; t.db = s.db != null ? +s.db : (+s.gainDb || 0); t.pan = +s.pan || 0; if (!isScene) { t.link = !!s.link; t.snap = null; } if (s.offset != null) t.offset = +s.offset || 0; t.mute = !!s.mute; t.solo = !!s.solo; if (s.dca) t.dca = s.dca.slice(0, N_DCA); if (s.hpf) t.hpf = { on: !!s.hpf.on, f: +s.hpf.f || 80 }; if (s.eq) { t.eqOn = !!s.eqOn; s.eq.forEach(function (b, i) { if (t.eq[i]) { t.eq[i].f = +b.f; t.eq[i].g = +b.g; t.eq[i].q = +b.q; } }); } if (s.comp) t.comp = JSON.parse(JSON.stringify(s.comp)); t.ui.dbt.textContent = dbTxt(t.db); });
    if (m.master) { S.master.db = +m.master.db || 0; S.master.mute = !!m.master.mute; S.master.ui.dbt.textContent = dbTxt(S.master.db); } else if (m.masterDb != null) S.master.db = +m.masterDb;
    (m.dcas || []).forEach(function (d, i) { if (S.dcas[i]) { S.dcas[i].db = +d.db || 0; S.dcas[i].mute = !!d.mute; S.dcas[i].ui.dbt.textContent = dbTxt(S.dcas[i].db); } });
    S.duration = Math.max.apply(null, S.tracks.map(function (x) { return x.offset + x.fullDur; })); applyMix(); showSelected(); if (S.playing) startPlayback(curPos()); return hit;
  }
  function sceneKey(i) {
    if (S.storeArmed) { S.scenes[i] = deskState(); S.storeArmed = false; $('sceneStore').setAttribute('aria-pressed', 'false'); $('scenes').children[i].setAttribute('aria-pressed', 'true'); $('scenes').children[i].title = 'Scene ' + (i + 1) + ': stored. Click to recall.'; status('Scene ' + (i + 1) + ' stored.'); return; }
    if (!S.scenes[i]) { status('Scene ' + (i + 1) + ' is empty. Press Store, then ' + (i + 1) + ', to store the desk as it is now.'); return; }
    applyState(S.scenes[i], true); status('Scene ' + (i + 1) + ' recalled.');
  }
  function sectionEnd(i) { var secs = S.song.sections || [], n = secs[i + 1]; return n ? +n.time : S.duration; }
  function loopSection(i) { var secs = S.song.sections || [], a = +secs[i].time || 0, b = sectionEnd(i); if (b - a < 0.3) return; S.loop.a = a; S.loop.b = b; S.loop.on = true; S.loop.sec = i; $('loopBtn').setAttribute('aria-pressed', 'true'); updateLoopBox(); markSections(); seek(a); status('Looping "' + secs[i].name + '": ' + fmt(a) + ' to ' + fmt(b) + '. Press Loop to stop looping.'); }
  function markSections() { Array.prototype.forEach.call($('sections').children, function (b, i) { b.classList.toggle('looping', S.loop.on && S.loop.sec === i); }); }
  function buildSections() { var nav = $('sections'); nav.innerHTML = ''; (S.song.sections || []).forEach(function (s, i) { var b = el('button', 'btn', s.name); b.title = 'Click: go to ' + s.name + '. Double-click, or click while Loop is on: loop it.'; b.onclick = function () { if (S.loop.on) loopSection(i); else seek(+s.time || 0); }; b.ondblclick = function () { loopSection(i); }; nav.appendChild(b); }); markSections(); }
  /* ---------- markers ---------- */
  function addMarker() { if (!S.tracks.length) return; var t = Math.round(curPos() * 100) / 100; S.markers.push({ t: t, name: 'Marker ' + (S.markers.length + 1) }); S.markers.sort(function (a, b) { return a.t - b.t; }); buildMarkers(); drawOverview(); saveSoon(); status('Marker added at ' + fmt(t) + '. Double-click its name to rename it.'); }
  function buildMarkers() {
    var host = $('markers'); host.innerHTML = ''; host.hidden = !S.markers.length;
    S.markers.forEach(function (m, i) {
      var chip = el('span', 'mk'), go = el('button', 'mk-go', fmt(m.t).replace(/\.\d$/, '') + '  ' + m.name), x = el('button', 'mk-x', '\u00d7'); go.title = 'Go to this marker. Double-click to rename.'; x.setAttribute('aria-label', 'Delete marker ' + m.name);
      go.onclick = function () { seek(m.t); };
      go.ondblclick = function () { var inp = document.createElement('input'); inp.value = m.name; inp.className = 'mk-in'; inp.maxLength = 60; chip.replaceChild(inp, go); inp.focus(); inp.select(); var done = function () { m.name = inp.value.trim() || m.name; buildMarkers(); saveSoon(); }; inp.onblur = done; inp.onkeydown = function (e) { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { inp.value = m.name; inp.blur(); } }; };
      x.onclick = function () { S.markers.splice(i, 1); buildMarkers(); drawOverview(); saveSoon(); };
      chip.appendChild(go); chip.appendChild(x); host.appendChild(chip);
    });
  }
  function showPage(p) {            // the display has two pages, like a console screen
    var has = !!S.score; if (p === 'score' && !has) p = 'proc'; S.page = p;
    $('tabScore').hidden = !has; [['tabScore', 'score'], ['tabProc', 'proc'], ['tabWave', 'wave']].forEach(function (x) { $(x[0]).setAttribute('aria-selected', p === x[1] ? 'true' : 'false'); });
    $('scorePanel').hidden = p !== 'score'; $('paneProc').hidden = p !== 'proc'; $('paneWave').hidden = p !== 'wave'; $('followWrap').hidden = $('paperWrap').hidden = $('sizeWrap').hidden = $('wrapWrap').hidden = $('zoomWrap').hidden = p !== 'score';
    if (p !== 'score') $('screenInfo').textContent = '';
    if (p === 'proc') drawEq(); else if (p === 'wave') { showSelected(); drawWave(curPos()); } else if (S.score) { S.score.last = null; S.score.line = -1; scoreFollow(curPos()); }
  }
  function buildScore() {
    var abc = S.song._abcText; S.score = null; $('paper').innerHTML = ''; $('cursor').style.display = 'none'; if (!abc || !window.ABCJS) { showPage('proc'); return; }
    try {
      $('scorePanel').hidden = false;                    // abcjs needs a visible box to size itself
      var wr = $('scoreWrap').value, zoom = +$('scoreZoom').value || 1, body = abc.replace(/^[TC]:.*\r?\n/gm, ''), strip = wr === 'scroll';
      var opt = { add_classes: true, staffwidth: Math.round(980 / zoom), paddingtop: 6, paddingbottom: 6 };
      if (strip) {                    // one long line at a comfortable spacing; the display scrolls sideways under a steady cursor, so no bar is ever squeezed
        var notes = (body.slice(body.search(/^K:.*$/m)).replace(/"[^"]*"/g, '').replace(/^[A-Za-z]:.*$/gm, '').match(/[A-Ga-gz]/g) || []).length;
        opt.staffwidth = Math.max(900, notes * 46); opt.scale = zoom; opt.wrap = { minSpacing: 1, maxSpacing: 100, preferredMeasuresPerLine: 9999 };
      } else { opt.responsive = 'resize'; if (wr !== 'file') opt.wrap = { minSpacing: 1.6, maxSpacing: 2.8, preferredMeasuresPerLine: wr === 'auto' ? 4 : +wr }; }
      $('paperBox').classList.toggle('strip', strip); $('paperBox').scrollLeft = 0; $('sizeWrap').classList.toggle('na', strip);
      $('paper').removeAttribute('style');
      var vis = ABCJS.renderAbc('paper', body, opt)[0];
      if (strip) { var sv0 = $('paper').querySelector('svg').getBoundingClientRect(); $('paper').setAttribute('style', 'display:block;overflow:visible;width:' + Math.ceil(sv0.width + $('paperBox').clientWidth * 0.7) + 'px;height:' + Math.ceil(sv0.height + 8) + 'px'); }
      var q = (abc.match(/^Q:\s*(?:\d+\/\d+\s*=\s*)?(\d+(?:\.\d+)?)/m) || [])[1], qpm = +q || S.song.bpm || 100; vis.setTiming(qpm);
      var all = vis.noteTimings || [], ev = all.filter(function (e) { return e.type === 'event' && e.elements; });
      if (ev.length) {
        var total = all[all.length - 1].milliseconds, avg = S.beats.length > 1 ? (S.beats[S.beats.length - 1].t - S.beats[0].t) / (S.beats.length - 1) : 60 / (S.song.bpm || qpm);
        var den = parseInt(String(S.song.meter || (abc.match(/^M:\s*\d+\/(\d+)/m) || [])[0] || '4/4').split('/')[1], 10) || 4;
        var quarters = vis.getTotalBeats && vis.getBeatLength ? vis.getTotalBeats() * vis.getBeatLength() * 4 : 0;      // the score's own length, in quarter notes
        var msPerBeat = quarters > 0 ? total / quarters * 4 / den : 60000 / qpm;                                     // score milliseconds per beat of the song
        var cyc = +S.song.scoreBeats || Math.round(S.song.scoreLength ? S.song.scoreLength / avg : total / msPerBeat);
        S.score = { strip: strip, ev: ev, total: total, msPerBeat: msPerBeat, cycle: Math.max(1, cyc), last: null, line: -1, svg: $('paper').querySelector('svg') };
      }
    } catch (e) { status('The ABC file could not be drawn: ' + e.message, true); }
    showPage(S.score ? 'score' : 'proc');
  }
  function beatPos(t) {             // time in seconds -> position in beats along the song's own beat grid (follows every tempo change)
    var b = S.beats, n = b.length; if (n < 2) return t * (S.song.bpm || 100) / 60;
    var i = clamp(beatAt(t), 0, n - 2); return i + (t - b[i].t) / (b[i + 1].t - b[i].t);
  }
  function scoreFollow(t) {
    var sc = S.score; if (!sc || S.page !== 'score') return;
    var start = S.song.scoreStart != null ? +S.song.scoreStart : (S.beats.length ? S.beats[0].t : 0), rel = beatPos(t) - Math.round(beatPos(start)), rep = S.song.scoreRepeats, pass = Math.floor(rel / sc.cycle);
    var on = rel >= 0 && (rep === true ? true : pass < (+rep || 1)); if (on && pass > 0) rel -= pass * sc.cycle;
    var st = on ? rel * sc.msPerBeat : -1, k = -1; if (on) for (var i = sc.ev.length - 1; i >= 0; i--) if (sc.ev[i].milliseconds <= st + 1) { k = i; break; }
    var cur = k >= 0 ? sc.ev[k] : null, cu = $('cursor');
    $('screenInfo').textContent = on ? (rep && rep !== 1 ? 'Pass ' + (pass + 1) + (rep === true ? '' : ' of ' + rep) + ' · ' : '') + 'score beat ' + (Math.floor(rel) + 1) + ' of ' + sc.cycle : '';
    if (cur !== sc.last) {
      if (sc.last) sc.last.elements.forEach(function (g) { g.forEach(function (e) { e.classList.remove('vsd-now'); }); });
      if (cur) cur.elements.forEach(function (g) { g.forEach(function (e) { e.classList.add('vsd-now'); }); });
      sc.last = cur;
    }
    if (!cur || !sc.svg) { cu.style.display = 'none'; return; }
    var vb = sc.svg.viewBox.baseVal, scale = vb && vb.width ? sc.svg.clientWidth / vb.width : 1, nx = sc.ev[k + 1], endMs = nx ? nx.milliseconds : sc.total;
    if (sc.strip) { var rw = sc.svg.getBoundingClientRect().width; scale = rw / (parseFloat(sc.svg.getAttribute('width')) || rw); }
    var x1 = nx && nx.top === cur.top ? nx.left : cur.left + cur.width + 14, f = clamp((st - cur.milliseconds) / Math.max(1, endMs - cur.milliseconds), 0, 1);
    cu.style.display = 'block'; cu.style.left = ((cur.left + (x1 - cur.left) * f) * scale - 1) + 'px'; cu.style.top = (cur.top * scale) + 'px'; cu.style.height = (cur.height * scale) + 'px';
    if (sc.strip) { if ($('follow').checked) { var bx = $('paperBox'); bx.scrollLeft = Math.max(0, parseFloat(cu.style.left) - bx.clientWidth * 0.3); } return; }
    if ($('follow').checked && cur.top !== sc.line) { sc.line = cur.top; var box = $('paperBox'), y = cur.top * scale; if (box.scrollHeight > box.clientHeight + 2) box.scrollTo({ top: Math.max(0, y - 34), behavior: S.playing ? 'smooth' : 'auto' }); }   // the line being played sits at the top, the lines to come stay in view below it
  }

  /* ---------- audio graph and transport ---------- */
  function makeChain(ctx, t, dest, live) {
    var n = { live: live, hpf: ctx.createBiquadFilter(), eq: t.eq.map(function () { return ctx.createBiquadFilter(); }), comp: ctx.createDynamicsCompressor(), trim: ctx.createGain(), fader: ctx.createGain(), pan: ctx.createStereoPanner ? ctx.createStereoPanner() : null, an: null };
    n.hpf.type = 'highpass'; n.hpf.Q.value = 0.707; var last = n.hpf; n.eq.forEach(function (f) { last.connect(f); last = f; }); last.connect(n.comp); n.comp.connect(n.trim); n.trim.connect(n.fader);
    if (n.pan) { n.fader.connect(n.pan); n.pan.connect(dest); n.pan.pan.value = t.pan; } else n.fader.connect(dest);
    n.fader.gain.value = levelOf(t); n.live = false; applyProc(t, n); n.live = live;
    if (live) { n.an = ctx.createAnalyser(); n.an.fftSize = 256; n.fader.connect(n.an); }
    return n;
  }
  function curPos() { return S.playing ? Math.min(S.duration, S.startPos + (S.ctx.currentTime - S.startCtx) * S.rate) : S.pos; }
  function stopSources() {
    S.sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }); S.sources = [];
    S.tracks.forEach(function (t) { if (t.nodes) { try { t.nodes.fader.disconnect(); if (t.nodes.pan) t.nodes.pan.disconnect(); } catch (e) {} t.nodes = null; } });
    if (S.clickTimer) { clearInterval(S.clickTimer); S.clickTimer = null; }
  }
  function startPlayback(from) {
    var ctx = ensureCtx(); if (ctx.state === 'suspended') ctx.resume();
    stopSources(); from = clamp(from, 0, Math.max(0, S.duration - 0.02)); var when = ctx.currentTime + 0.08;
    S.tracks.forEach(function (t) {
      t.nodes = makeChain(ctx, t, S.out, true); var local = from - at(t); if (local >= t.buffer.duration) return;
      var src = ctx.createBufferSource(); src.buffer = t.buffer; src.playbackRate.value = S.rate; src.connect(t.nodes.hpf);
      if (local >= 0) src.start(when, local); else src.start(when + (-local) / S.rate, 0); S.sources.push(src);
    });
    S.masterGain.gain.value = S.master.mute ? 0 : db2g(S.master.db); S.clickGain.gain.value = db2g(S.click.db); S.startCtx = when; S.startPos = from; S.playing = true; $('play').textContent = 'Pause';
    S.nextBeat = Math.max(0, beatAt(from - 1e-4) + 1);
    if (S.click.on && S.beats.length) { scheduleClicks(); S.clickTimer = setInterval(scheduleClicks, 40); }
    cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(tick);
  }
  function scheduleClicks() {
    var ctx = S.ctx, horizon = ctx.currentTime + 0.25;
    while (S.nextBeat < S.beats.length) {
      var b = S.beats[S.nextBeat], at = S.startCtx + (b.t - S.startPos) / S.rate; if (at > horizon) break;
      if (at >= ctx.currentTime - 0.005) { var o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = b.n === 1 ? 1760 : 1175; g.gain.setValueAtTime(b.n === 1 ? 0.6 : 0.36, at); g.gain.exponentialRampToValueAtTime(0.0008, at + 0.035); o.connect(g); g.connect(S.clickGain); o.start(at); o.stop(at + 0.045); }
      S.nextBeat++;
    }
  }
  function countInThen(at) {          // one bar of clicks, then the music from 'at'
    stopPlayback(); S.pos = at; tickUI(); var i = clamp(beatAt(at + 0.01), 0, S.beats.length - 2), iv = (S.beats[i + 1].t - S.beats[i].t) / S.rate, per = parseInt(String(S.song.meter || '4/4').split('/')[0], 10) || 4, ctx = S.ctx, t0 = ctx.currentTime + 0.05;
    S.clickGain.gain.value = db2g(S.click.db);
    for (var k = 0; k < per; k++) { var o = ctx.createOscillator(), g = ctx.createGain(), at2 = t0 + k * iv; o.frequency.value = k === 0 ? 1760 : 1175; g.gain.setValueAtTime(k === 0 ? 0.6 : 0.36, at2); g.gain.exponentialRampToValueAtTime(0.0008, at2 + 0.035); o.connect(g); g.connect(S.clickGain); o.start(at2); o.stop(at2 + 0.045); S.countOsc.push(o); }
    $('play').textContent = 'Pause'; status('Count-in: ' + per + ' beats, then back to ' + fmt(at) + '.'); S.countT = setTimeout(function () { S.countT = 0; S.countOsc = []; startPlayback(at); }, (per * iv + 0.05 - 0.08) * 1000);
  }
  function cancelCount() { if (!S.countT) return false; clearTimeout(S.countT); S.countT = 0; S.countOsc.forEach(function (o) { try { o.stop(); } catch (e) {} }); S.countOsc = []; $('play').textContent = 'Play'; return true; }
  function stopPlayback() { cancelCount(); if (S.playing) S.pos = curPos(); S.playing = false; stopSources(); cancelAnimationFrame(S.raf); $('play').textContent = 'Play'; S.tracks.forEach(function (t) { t.peak = t.hold = -90; }); }
  function seek(t) { t = clamp(t, 0, S.duration); if (S.playing) startPlayback(t); else { S.pos = t; tickUI(); } }
  function tick() {
    if (!S.playing) return; var p = curPos();
    if (S.loop.on && S.loop.b != null && p >= S.loop.b) { if ($('countIn').checked && S.beats.length) countInThen(S.loop.a); else startPlayback(S.loop.a); return; }
    if (p >= S.duration - 0.005) { if (S.repeat) { S.passes = (S.passes || 1) + 1; startPlayback(0); status('Repeat: playing the song again (time ' + S.passes + ').'); return; } stopPlayback(); S.pos = 0; tickUI(); status('Reached the end.'); return; }
    tickUI(); S.raf = requestAnimationFrame(tick);
  }
  var mbuf = new Float32Array(512);
  function peakDb(an) { var n = an.fftSize; an.getFloatTimeDomainData(mbuf); var m = 0; for (var i = 0; i < n; i++) { var v = Math.abs(mbuf[i]); if (v > m) m = v; } return m > 0 ? 20 * Math.log10(m) : -90; }
  var MC = null;
  function drawMeter(cv, db, hold, x0, bw, keep) {
    if (!MC) MC = { ok: css('--ok'), warn: css('--warn'), clip: css('--clip') };
    var g = cv.getContext('2d'), w = bw || cv.width, x = x0 || 0, h = cv.height, y = function (d) { return h - clamp((d + 60) / 66, 0, 1) * h; }; if (!keep) g.clearRect(0, 0, cv.width, h);
    var top = y(db); if (db > -60) { g.fillStyle = MC.ok; g.fillRect(x, Math.max(top, y(-12)), w, h - Math.max(top, y(-12))); if (db > -12) { g.fillStyle = MC.warn; g.fillRect(x, Math.max(top, y(0)), w, y(-12) - Math.max(top, y(0))); } if (db > 0) { g.fillStyle = MC.clip; g.fillRect(x, top, w, y(0) - top); } }
    if (hold > -60) { g.fillStyle = hold > 0 ? MC.clip : '#fff'; g.fillRect(x, y(hold), w, 2); }
  }
  function tickUI() {
    var p = curPos(); $('clock').textContent = fmt(p) + ' / ' + fmt(S.duration); $('playhead').style.left = ((S.duration ? p / S.duration : 0) * 100) + '%';
    var i = beatAt(p); $('barBeat').textContent = i >= 0 && S.beats[i].bar != null ? 'bar ' + S.beats[i].bar + ' · beat ' + S.beats[i].n : ''; scoreFollow(p); if (S.page === 'wave') drawWave(p);
    var now = performance.now();
    S.tracks.forEach(function (t) { var db = S.playing && t.nodes && t.nodes.an ? peakDb(t.nodes.an) : -90; t.peak = Math.max(db, t.peak - 1.2); if (db >= t.hold || now - t.holdT > 1500) { t.hold = db; t.holdT = now; } if (t.ui) drawMeter(t.ui.meter, t.peak, t.hold); });
    if (S.master.ui && S.anL) {
      var M = S.master, lr = [S.playing ? peakDb(S.anL) : -90, S.playing ? peakDb(S.anR) : -90]; if (!M.pk) { M.pk = [-90, -90]; M.hd = [-90, -90]; M.ht = [0, 0]; }
      lr.forEach(function (d, c) { M.pk[c] = Math.max(d, M.pk[c] - 1.2); if (d >= M.hd[c] || now - M.ht[c] > 1500) { M.hd[c] = d; M.ht[c] = now; } drawMeter(M.ui.meter, M.pk[c], M.hd[c], c * 9, 7, c === 1); });
      if (S.playing) loudTick(now, Math.max(lr[0], lr[1]));
    }
    var gr = S.playing && S.sel && S.sel.nodes && S.sel.comp.on ? -S.sel.nodes.comp.reduction : 0; $('grBar').style.setProperty('--gr', clamp(gr / 20, 0, 1)); $('grTxt').textContent = (gr >= 0.05 ? '-' : '') + gr.toFixed(1) + ' dB';
  }


  /* ---------- loudness (ITU-R BS.1770: K-weighting, 400 ms blocks, gating) ---------- */
  function kCoef(sr) {
    var A = Math.pow(10, 4 / 40), w = 2 * Math.PI * 1500 / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), q = 2 * Math.sqrt(A) * al;
    var sh = { b: [A * ((A + 1) + (A - 1) * c + q), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - q)], a: [(A + 1) - (A - 1) * c + q, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - q] };
    var w2 = 2 * Math.PI * 38 / sr, c2 = Math.cos(w2), a2 = Math.sin(w2) / (2 * 0.5);
    var hp = { b: [(1 + c2) / 2, -(1 + c2), (1 + c2) / 2], a: [1 + a2, -2 * c2, 1 - a2] };
    return [sh, hp].map(function (f) { var a0 = f.a[0]; return { b: f.b.map(function (x) { return x / a0; }), a: f.a.map(function (x) { return x / a0; }) }; });
  }
  function gated(blocks) {           // blocks: mean-square sums (all channels) of 400 ms windows -> integrated LUFS
    var L = function (z) { return -0.691 + 10 * Math.log10(z); }, a = blocks.filter(function (z) { return z > 0 && L(z) > -70; }); if (!a.length) return -Infinity;
    var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length, thr = L(m) - 10, b = a.filter(function (z) { return L(z) > thr; }); if (!b.length) return -Infinity;
    return L(b.reduce(function (x, y) { return x + y; }, 0) / b.length);
  }
  function lufsOf(chs, sr) {         // exact measurement of a rendered buffer
    var k = kCoef(sr), n = chs[0].length, win = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), nb = Math.max(0, Math.floor((n - win) / hop) + 1), hops = Math.ceil(n / hop), acc = new Float64Array(hops);
    chs.forEach(function (x) {
      var s1 = k[0], s2 = k[1], x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
      for (var i = 0; i < n; i++) { var xi = x[i], y = s1.b[0] * xi + s1.b[1] * x1 + s1.b[2] * x2 - s1.a[1] * y1 - s1.a[2] * y2; x2 = x1; x1 = xi; y2 = y1; y1 = y;
        var v = s2.b[0] * y + s2.b[1] * u1 + s2.b[2] * u2 - s2.a[1] * v1 - s2.a[2] * v2; u2 = u1; u1 = y; v2 = v1; v1 = v; acc[(i / hop) | 0] += v * v; }
    });
    var blocks = []; for (var b = 0; b < nb; b++) blocks.push((acc[b] + acc[b + 1] + acc[b + 2] + acc[b + 3]) / win);
    return gated(blocks);
  }
  var TP_TAPS = (function () { var out = []; for (var p = 1; p < 4; p++) { var t = []; for (var j = -5; j <= 6; j++) { var x = j - p / 4, w = 0.5 + 0.5 * Math.cos(Math.PI * x / 6.5); t.push(Math.sin(Math.PI * x) / (Math.PI * x) * w); } out.push(t); } return out; })();
  function truePeakOf(chs) {         // 4x oversampled peak, computed only near the loudest samples
    var pk = 0; chs.forEach(function (x) { for (var i = 0; i < x.length; i++) { var a = Math.abs(x[i]); if (a > pk) pk = a; } }); var tp = pk, lim = pk * 0.7;
    chs.forEach(function (x) { for (var i = 5; i < x.length - 6; i++) { if (Math.abs(x[i]) < lim && Math.abs(x[i + 1]) < lim) continue; for (var p = 0; p < 3; p++) { var t = TP_TAPS[p], s = 0; for (var j = 0; j < 12; j++) s += x[i + j - 5] * t[j]; if (s < 0) s = -s; if (s > tp) tp = s; } } });
    return tp > 0 ? 20 * Math.log10(tp) : -Infinity;
  }
  var LD = { blocks: [], sum: 0, cnt: 0, t0: 0, recent: [], pk: -90 }, kbuf = new Float32Array(2048);
  function loudReset() { LD.blocks = []; LD.sum = 0; LD.cnt = 0; LD.t0 = 0; LD.recent = []; LD.pk = -90; showLoud(); }
  function loudTick(now, peakNow) {  // live reading from the K-weighted master: momentary 0.4 s, short-term 3 s, integrated since reset
    if (!S.kL) return; var z = 0; [S.kL, S.kR].forEach(function (an) { an.getFloatTimeDomainData(kbuf); var q = 0; for (var i = 0; i < 2048; i++) q += kbuf[i] * kbuf[i]; z += q / 2048; });
    LD.recent.push([now, z]); while (LD.recent.length && now - LD.recent[0][0] > 3000) LD.recent.shift(); if (peakNow > LD.pk) LD.pk = peakNow;
    if (!LD.t0) LD.t0 = now; LD.sum += z; LD.cnt++; if (now - LD.t0 >= 400) { LD.blocks.push(LD.sum / LD.cnt); LD.sum = 0; LD.cnt = 0; LD.t0 = now; }
    showLoud(now);
  }
  function showLoud(now) {
    var f = function (v) { return isFinite(v) && v > -99 ? v.toFixed(1) : '--.-'; }, L = function (a) { if (!a.length) return -Infinity; var m = a.reduce(function (x, y) { return x + y[1]; }, 0) / a.length; return m > 0 ? -0.691 + 10 * Math.log10(m) : -Infinity; };
    var mom = now ? L(LD.recent.filter(function (r) { return now - r[0] <= 400; })) : -Infinity, st = now ? L(LD.recent) : -Infinity;
    $('ldM').textContent = f(mom); $('ldS').textContent = f(st); $('ldI').textContent = f(gated(LD.blocks)); $('ldP').textContent = f(LD.pk); $('ldP').className = LD.pk > -1 ? 'hot' : '';
  }

  /* ---------- overview ---------- */
  function buildOverviewPeaks() {
    if (!S.tracks.length) return; var out = new Float32Array(PEAK_BINS), dur = S.duration;
    S.tracks.forEach(function (t) { var g = levelOf(t); if (!g) return; var pk = t.peaks, td = t.buffer.duration; for (var b = 0; b < PEAK_BINS; b++) { var tt = (b + 0.5) / PEAK_BINS * dur - at(t); if (tt < 0 || tt >= td) continue; var v = pk[Math.min(pk.length - 1, Math.floor(tt / td * pk.length))] * g; if (v > out[b]) out[b] = v; } });
    S.ovPeaks = out;
  }
  function drawOverview() {
    var cv = $('overview'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !S.tracks.length) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var g = cv.getContext('2d'), dur = S.duration; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); g.font = '10px ui-monospace, monospace'; g.textBaseline = 'top';
    var bars = S.beats.filter(function (b) { return b.n === 1; }), step = Math.max(1, Math.ceil(bars.length / (w / 44)));
    if (bars.length) bars.forEach(function (b, i) { var x = b.t / dur * w; g.fillStyle = css('--line'); g.fillRect(x, 14, 1, h - 14); if (i % step === 0) { g.fillStyle = css('--muted'); g.fillText(String(b.bar), x + 3, h - 12); } });
    else { var st = [1, 2, 5, 10, 15, 30, 60].filter(function (s) { return dur / s <= w / 60; })[0] || 120; g.fillStyle = css('--muted'); for (var t = 0; t < dur; t += st) { var x2 = t / dur * w, lb = fmt(t).replace(/\.\d$/, ''); g.fillRect(x2, h - 14, 1, 14); if (x2 + 3 + g.measureText(lb).width <= w) g.fillText(lb, x2 + 3, h - 12); } }
    var pk = S.ovPeaks, mid = h / 2 + 2, amp = h / 2 - 16; g.fillStyle = css('--accent'); g.globalAlpha = 0.85;
    if (pk) for (var x = 0; x < w; x++) { var a = Math.floor(x / w * pk.length), b2 = Math.max(a + 1, Math.floor((x + 1) / w * pk.length)), m = 0; for (var i = a; i < b2; i++) if (pk[i] > m) m = pk[i]; var hh = Math.max(0.5, Math.min(amp, m * amp)); g.fillRect(x, mid - hh, 1, 2 * hh); }
    g.globalAlpha = 1; g.fillStyle = css('--solo'); S.markers.forEach(function (m) { var xm = m.t / dur * w; g.fillRect(xm, 12, 2, h - 12); g.beginPath(); g.moveTo(xm, 12); g.lineTo(xm + 8, 16); g.lineTo(xm, 20); g.fill(); });
    g.fillStyle = css('--ink'); var lastX = -1e9; (S.song.sections || []).forEach(function (s) { var x3 = (+s.time || 0) / dur * w; g.fillRect(x3, 0, 1, 12); if (x3 - lastX > 8) { g.fillText(s.name, x3 + 4, 2); lastX = x3 + g.measureText(s.name).width; } });
    updateLoopBox();
  }
  function updateLoopBox() { var box = $('loopBox'), L = S.loop; if (L.a == null || L.b == null || !S.duration) { box.hidden = true; return; } box.hidden = false; box.style.left = (L.a / S.duration * 100) + '%'; box.style.width = Math.max(0.2, (L.b - L.a) / S.duration * 100) + '%'; box.style.opacity = L.on ? 1 : 0.45; }
  function snap(t) { if (!S.beats.length) return t; var i = beatAt(t), c = [S.beats[i], S.beats[i + 1]].filter(Boolean); return c.reduce(function (best, b) { return Math.abs(b.t - t) < Math.abs(best - t) ? b.t : best; }, c[0].t); }
  function bindOverview() {
    var cv = $('overview'), drag = null; function tAt(e) { var r = cv.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * S.duration; }
    cv.addEventListener('pointerdown', function (e) { if (!S.duration) return; cv.setPointerCapture(e.pointerId); drag = { t0: tAt(e), loop: e.shiftKey }; if (!drag.loop) seek(drag.t0); });
    cv.addEventListener('pointermove', function (e) { if (!drag) return; var t = tAt(e); if (drag.loop) { S.loop.a = Math.min(drag.t0, t); S.loop.b = Math.max(drag.t0, t); updateLoopBox(); } else if (!S.playing) seek(t); });
    cv.addEventListener('pointerup', function () { if (drag && drag.loop && S.loop.b - S.loop.a > 0.2) { var a = snap(S.loop.a), b = snap(S.loop.b); if (b - a > 0.2) { S.loop.a = a; S.loop.b = b; } S.loop.on = true; S.loop.sec = -1; $('loopBtn').setAttribute('aria-pressed', 'true'); updateLoopBox(); markSections(); status('Loop: ' + fmt(S.loop.a) + ' to ' + fmt(S.loop.b) + '.'); } drag = null; });
  }

  /* ---------- save, load, export ---------- */
  function download(blob, name) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  function exportWav() {
    var on = S.tracks.filter(audible); if (!on.length || S.master.mute) { status('Nothing is audible, so there is nothing to export.', true); return; }
    var sr = S.ctx ? S.ctx.sampleRate : 48000, OC = window.OfflineAudioContext || window.webkitOfflineAudioContext, oc = new OC(2, Math.ceil(S.duration * sr), sr), mg = oc.createGain(); mg.gain.value = db2g(S.master.db); mg.connect(oc.destination);
    on.forEach(function (t) { var n = makeChain(oc, t, mg, false), s = oc.createBufferSource(); s.buffer = t.buffer; s.connect(n.hpf); s.start(Math.max(0, at(t)), Math.max(0, -at(t))); });
    status('Rendering the mix with all processing…'); $('exportWav').disabled = true;
    oc.startRendering().then(function (buf) {
      var L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length, i, lu = lufsOf([L, R], sr), tp = truePeakOf([L, R]), target = +$('normTo').value, g = 0, note = '';
      if (target && isFinite(lu)) { g = target - lu; if (tp + g > -1) { g = -1 - tp; note = ' The true-peak ceiling of -1 dBTP was reached first, so it is quieter than the ' + target + ' LUFS asked for.'; } }
      var k = db2g(g), ab = new ArrayBuffer(44 + n * 6), v = new DataView(ab), o = 44; function w(p, s) { for (var k2 = 0; k2 < s.length; k2++) v.setUint8(p + k2, s.charCodeAt(k2)); }
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 6, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true); w(36, 'data'); v.setUint32(40, n * 6, true);
      function put(x) { var y = Math.round(clamp(x * k, -1, 1) * 8388607); if (y < 0) y += 16777216; v.setUint8(o, y & 255); v.setUint8(o + 1, (y >> 8) & 255); v.setUint8(o + 2, (y >> 16) & 255); o += 3; }
      for (i = 0; i < n; i++) { put(L[i]); put(R[i]); }
      download(new Blob([ab], { type: 'audio/wav' }), ((S.song.title || 'mix').replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '_') || 'mix') + '_mix.wav');
      var clip = tp + g > 0; S.lastExport = { lufs: lu + g, tp: tp + g, gain: g };
      status('Exported ' + fmt(S.duration) + ', 24-bit, ' + sr + ' Hz: ' + (lu + g).toFixed(1) + ' LUFS integrated, true peak ' + (tp + g).toFixed(1) + ' dBTP' + (g ? ' (gain ' + (g > 0 ? '+' : '') + g.toFixed(1) + ' dB applied, no limiter).' : '.') + note + (clip ? ' It clipped: lower the main fader, or choose a loudness target, and export again.' : ''), clip);
    }).catch(function (e) { status('Export failed: ' + e.message, true); }).then(function () { $('exportWav').disabled = false; });
  }
  function loadDemo(dir) {             // dir: a folder on the site that holds song.json and the files it names
    if (location.protocol === 'file:') { status('The demo is fetched over HTTP, which a page opened from disk cannot do. Drop the "demo" folder onto the page instead.', true); return; }
    dir = (dir || 'demo').replace(/\/$/, '') + '/'; status('Fetching the demo…');
    fetch(dir + 'song.json').then(function (r) { if (!r.ok) throw new Error(dir + 'song.json: ' + r.status); return r.json(); }).then(function (song) {
      var names = song.tracks.map(function (t) { return t.file; }).concat(song.abc ? [song.abc] : []), got = 0, bytes = 0;
      return Promise.all(names.map(function (n) { return fetch(dir + n).then(function (r) { if (!r.ok) throw new Error(n + ': ' + r.status); return r.blob(); }).then(function (b) { got++; bytes += b.size; status('Fetching the demo: ' + got + ' of ' + names.length + ' files, ' + (bytes / 1048576).toFixed(0) + ' MB…'); return new File([b], n.replace(/\.abc\.txt$/, '.abc')); }); }))
        .then(function (files) { return loadFiles(files.concat([new File([JSON.stringify(song)], 'song.json')])); });
    }).catch(function (e) { status('The demo could not be loaded: ' + e.message, true); });
  }

  /* ---------- MIDI ---------- */
  var MIDI_HELP = { off: 'MIDI input is ignored.', learn: 'Press "Learn next control", move a fader or press a Mute, Solo or Play key on this page, then move the control on your MIDI device. Bindings are kept in this browser.',
    sq: 'Follows the MIDI fader-strip layout of Allen & Heath SQ mixers: fader of strip n = control change n-1 (0 to 31), Mute keys = notes 0 to 31, Sel keys = notes 32 to 63, PAFL keys = notes 64 to 95 (used here as Solo). Strip 1 is the first track. Any MIDI channel is accepted.' };
  function midiTouch(label, setDb) { if (S.midi.learn) { S.midi.target = { kind: 'fader', label: label, set: setDb }; $('midiLast').textContent = 'Waiting for a MIDI control for: ' + label; } }
  function midiInit() {
    if (!navigator.requestMIDIAccess) { $('midiState').textContent = 'This browser has no Web MIDI. Chrome, Edge and Firefox support it.'; return; }
    navigator.requestMIDIAccess().then(function (acc) {
      S.midi.access = acc; function hook() { var names = []; acc.inputs.forEach(function (inp) { inp.onmidimessage = onMidi; names.push(inp.name); }); $('midiState').textContent = names.length ? 'Listening to: ' + names.join(', ') : 'No MIDI inputs found. Connect a device and it will appear here.'; }
      hook(); acc.onstatechange = hook;
    }, function () { $('midiState').textContent = 'MIDI access was refused by the browser.'; });
  }
  function onMidi(e) {
    var d = e.data, st = d[0] & 0xf0, a = d[1], b = d[2], M = S.midi; if (M.mode === 'off' || !S.tracks.length) return;
    var isCC = st === 0xb0, isOn = st === 0x90 && b > 0; if (!isCC && !isOn) return; $('midiLast').textContent = 'Last message: ' + (isCC ? 'CC ' + a + ' = ' + b : 'note ' + a);
    if (M.mode === 'sq') {
      var t; if (isCC && a < 32) { t = S.tracks[a]; if (t) { t.db = pos2db(b / 127); t.ui.dbt.textContent = dbTxt(t.db); applyMix(); } }
      else if (isOn && a < 96) { t = S.tracks[a % 32]; if (!t) return; if (a < 32) { t.mute = !t.mute; applyMix(); } else if (a < 64) select(t); else { t.solo = !t.solo; applyMix(); } }
      return;
    }
    var key = (isCC ? 'cc' : 'note') + a;
    if (M.learn && M.target) { M.map[key] = M.target; M.learn = false; $('midiLearn').setAttribute('aria-pressed', 'false'); $('midiLast').textContent = 'Bound ' + (isCC ? 'CC ' : 'note ') + a + ' to ' + M.target.label + '.'; M.target = null; return; }
    var tg = M.map[key]; if (!tg) return; if (tg.kind === 'fader' && isCC) tg.set(pos2db(b / 127)); else if (tg.kind === 'button' && (isOn || (isCC && b >= 64))) tg.el.click();
  }
  document.addEventListener('click', function (e) { if (!S.midi.learn) return; var b = e.target.closest && e.target.closest('.key.m, .key.s, #play, #stop'); if (b) { S.midi.target = { kind: 'button', label: b.getAttribute('aria-label') || b.textContent, el: b }; $('midiLast').textContent = 'Waiting for a MIDI control for: ' + S.midi.target.label; } }, true);

  /* ---------- wiring ---------- */
  buildChannelPanel(); bindOverview();
  $('openFolder').onclick = function () { $('pickFolder').click(); }; $('openFiles').onclick = function () { $('pickFiles').click(); };
  $('pickFolder').onchange = function (e) { loadFiles(Array.prototype.slice.call(e.target.files)); e.target.value = ''; };
  $('pickFiles').onchange = function (e) { var f = Array.prototype.slice.call(e.target.files); e.target.value = ''; loadFiles(f, S.tracks.length > 0 && !f.some(function (x) { return /\.json$/i.test(x.name); })); };
  $('tabScore').onclick = function () { showPage('score'); }; $('tabProc').onclick = function () { showPage('proc'); }; $('tabWave').onclick = function () { showPage('wave'); };
  $('waveZoom').onchange = function () { drawWave(curPos()); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-nudge]'), function (b) { b.onclick = function () { nudge(+b.getAttribute('data-nudge')); }; });
  $('nudgeZero').onclick = function () { if (S.sel) nudge(-S.sel.offset * 1000); };
  $('waveCv').addEventListener('pointerdown', function (e) { if (!S.duration || !S.wv) return; var r = this.getBoundingClientRect(); seek(S.wv.t0 + (e.clientX - r.left) / r.width * S.wv.span); });
  $('scoreSize').onchange = function () { $('paperBox').style.maxHeight = this.value === '0' ? 'none' : this.value + 'px'; if (S.score) { S.score.line = -1; scoreFollow(curPos()); } };
  $('scoreZoom').onchange = function () { if (S.song && S.song._abcText) buildScore(); try { localStorage.setItem('vsd2:zoom', this.value); } catch (e) {} };
  try { var z0 = localStorage.getItem('vsd2:zoom'); if (z0) $('scoreZoom').value = z0; } catch (e) {}
  $('scoreWrap').onchange = function () { if (S.song && S.song._abcText) { buildScore(); try { localStorage.setItem('vsd2:wrap', this.value); } catch (e) {} } };
  try { var w0 = localStorage.getItem('vsd2:wrap'); if (w0) $('scoreWrap').value = w0; } catch (e) {}
  $('lightPaper').onchange = function () { $('paperBox').classList.toggle('light', this.checked); };
  $('loud').onclick = loudReset;
  $('soloClear').onclick = function () { S.tracks.forEach(function (t) { t.solo = false; }); applyMix(); };
  $('muteClear').onclick = function () { S.tracks.forEach(function (t) { t.mute = false; }); applyMix(); };
  $('resetDesk').onclick = function () { $('moreMenu').open = false; if (S.tracks.length) resetDesk(); };
  $('helpBtn').onclick = function () { $('helpDlg').showModal(); }; $('helpClose').onclick = function () { $('helpDlg').close(); };
  $('loadDemo').onclick = function () { loadDemo('demo/amazing-grace'); }; $('loadSmall').onclick = function () { loadDemo('demo'); }; $('clearAll').onclick = function () { closeSong(); $('moreMenu').open = false; };
  $('play').onclick = function () { if (!S.tracks.length) return; if (cancelCount()) { tickUI(); return; } if (S.playing) { stopPlayback(); tickUI(); } else startPlayback(S.pos); };
  $('stop').onclick = function () { S.passes = 1; stopPlayback(); S.pos = 0; tickUI(); };
  $('rate').onchange = function () { var p = curPos(); S.rate = +this.value; if (S.playing) startPlayback(p); status(S.rate === 1 ? 'Normal speed.' : 'Speed ' + Math.round(S.rate * 100) + '%: the pitch drops with it.'); };
  $('loopBtn').onclick = function () { if (S.loop.a == null) { status('Shift-drag on the overview to choose what to loop.'); return; } S.loop.on = !S.loop.on; this.setAttribute('aria-pressed', S.loop.on ? 'true' : 'false'); updateLoopBox(); markSections(); };
  $('markBtn').onclick = addMarker;
  $('repeatBtn').onclick = function () { S.repeat = !S.repeat; S.passes = 1; this.setAttribute('aria-pressed', S.repeat ? 'true' : 'false'); try { localStorage.setItem('vsd2:repeat', S.repeat ? '1' : '0'); } catch (e) {} status(S.repeat ? 'Repeat is on: at the end, the song starts again from the beginning.' : 'Repeat is off: the song stops at the end.'); };
  try { if (localStorage.getItem('vsd2:repeat') === '1') { S.repeat = true; $('repeatBtn').setAttribute('aria-pressed', 'true'); } } catch (e) {}
  $('clickBtn').onclick = function () { S.click.on = !S.click.on; this.setAttribute('aria-pressed', S.click.on ? 'true' : 'false'); if (S.playing) startPlayback(curPos()); };
  $('clickVol').oninput = function () { S.click.db = +this.value; if (S.clickGain) S.clickGain.gain.value = db2g(S.click.db); };
  $('sceneStore').onclick = function () { S.storeArmed = !S.storeArmed; this.setAttribute('aria-pressed', S.storeArmed ? 'true' : 'false'); status(S.storeArmed ? 'Store is armed: press a scene number.' : 'Store cancelled.'); };
  $('saveMix').onclick = function () { var st = deskState(); st.scenes = S.scenes; download(new Blob([JSON.stringify(st, null, 2)], { type: 'application/json' }), 'desk-settings.json'); $('moreMenu').open = false; };
  $('loadMix').onclick = function () { $('pickMix').click(); $('moreMenu').open = false; };
  $('pickMix').onchange = function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) textOf(f).then(function (t) { try { var m = JSON.parse(t); if (!Array.isArray(m.tracks)) throw 0; orderLike(m.tracks); buildStrips(); var hit = applyState(m); if (Array.isArray(m.scenes)) { S.scenes = m.scenes.slice(0, N_SCENES); while (S.scenes.length < N_SCENES) S.scenes.push(null); buildStrips(); applyMix(); showSelected(); } status('Desk settings applied to ' + hit + ' of ' + S.tracks.length + ' tracks.'); } catch (x) { status('That file is not a desk settings file.', true); } }); };
  $('exportWav').onclick = function () { $('moreMenu').open = false; exportWav(); };
  $('midiBtn').onclick = function () { $('moreMenu').open = false; $('midiDlg').showModal(); if (!S.midi.access) midiInit(); $('midiHelp').textContent = MIDI_HELP[S.midi.mode]; };
  $('midiClose').onclick = function () { $('midiDlg').close(); };
  $('midiMode').onchange = function () { S.midi.mode = this.value; $('midiHelp').textContent = MIDI_HELP[S.midi.mode]; $('midiLearn').disabled = S.midi.mode !== 'learn'; };
  $('midiLearn').onclick = function () { S.midi.learn = !S.midi.learn; S.midi.target = null; this.setAttribute('aria-pressed', S.midi.learn ? 'true' : 'false'); if (S.midi.learn) { $('midiDlg').close(); status('MIDI learn: touch a fader, or press Mute, Solo, Play or Stop, then move the control on your MIDI device.'); } };
  $('midiClear').onclick = function () { S.midi.map = {}; $('midiLast').textContent = 'All bindings cleared.'; };
  $('midiLearn').disabled = true;
  var drop = $('drop');
  var hasFiles = function (e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; };   // only real files from outside count as a drop; dragging a control or a piece of the page does not
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });      // nothing on the desk is draggable as an object
  ['dragenter', 'dragover'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); if (hasFiles(e)) drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (e) { if (!hasFiles(e)) return; filesFromDrop(e.dataTransfer).then(function (f) { if (f.length) loadFiles(f); }); });
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || $('midiDlg').open || $('helpDlg').open) return; if (e.key === '?') { $('helpDlg').showModal(); return; } if (!S.tracks.length) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) $('play').click(); }   // Space is always play / pause, whatever button was clicked last
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
    else if (e.key === 'k' || e.key === 'K') addMarker();
    else if (e.key === 'l' || e.key === 'L') $('loopBtn').click();
    else if (e.key === 'r' || e.key === 'R') $('repeatBtn').click();
    else if (e.key === 'Escape') { if (S.tracks.some(function (t) { return t.solo; })) $('soloClear').click(); }
    else if (/^[123]$/.test(e.key)) showPage(['score', 'proc', 'wave'][+e.key - 1]);
    else if (e.key === '[' || e.key === ']') { var k = clamp(S.tracks.indexOf(S.sel) + (e.key === ']' ? 1 : -1), 0, S.tracks.length - 1); select(S.tracks[k], true); S.tracks[k].ui.root.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else if ((e.key === 'm' || e.key === 'M') && S.sel) { S.sel.mute = !S.sel.mute; applyMix(); }
    else if ((e.key === 's' || e.key === 'S') && S.sel) { S.sel.solo = !S.sel.solo; applyMix(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && S.beats.length) { e.preventDefault(); var i = beatAt(curPos()), j = e.key === 'ArrowRight' ? i + 1 : (curPos() - (S.beats[Math.max(0, i)].t) > 0.05 ? i : i - 1); seek(S.beats[clamp(j, 0, S.beats.length - 1)].t); }
  });
  window.addEventListener('resize', function () { if (S.tracks.length) { fitStrips(); drawOverview(); drawEq(); applyMix(); drawWave(curPos()); if (S.score) { S.score.line = -1; scoreFollow(curPos()); } } });
  window.VSD = { state: S, loadFiles: loadFiles, pos2db: pos2db, db2pos: db2pos };
})();
