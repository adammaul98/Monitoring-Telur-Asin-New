(function () {
  'use strict';
  /* ============ KONFIGURASI ============ */
  var CFG = {
    host: 'v28c2407.ala.asia-southeast1.emqxsl.com', port: 8084,   // WebSocket TLS
    user: 'Telur-asin', pass: 'TELURASIN12345',
    sub: 'telur/slave/+',               // data slave 1, 2, led, time, status
    cmd: 'telur/control/heater',        // perintah ON / OFF ke ESP32
    cycleDays: 7                        // lama siklus pengasinan (hari), bisa diubah dengan mengetuk teks siklus
  };
  /* Kartu di desain dicocokkan dengan nama kolom dari ESP32 lewat kata kunci.
     Kalau slave hanya mengirim angka tanpa nama, dipakai urutan kartu. */
  var SLOTS = {
    1: [{ id: 'garam', re: /garam|salin|salt|tds|kadar/i, unit: '' },
        { id: 'suhu1', re: /suhu|temp/i, unit: '°C' },
        { id: 'level', re: /tinggi|level|jarak|volume|water/i, unit: '%' }],
    2: [{ id: 'suhu2', re: /suhu|temp/i, unit: '°C' },
        { id: 'hum', re: /lembab|hum|rh/i, unit: '%' },
        { id: 'heater', re: /heater|pemanas|relay|lampu|led/i, unit: '' }]
  };

  function $(id) { return document.getElementById(id) || { style: {}, dataset: {}, textContent: '' }; }  /* aman jika elemen dihapus */
  function pad(n) { return String(n).padStart(2, '0'); }
  function hhmmss(d) { d = d || new Date(); return pad(d.getHours()) + '.' + pad(d.getMinutes()) + '.' + pad(d.getSeconds()); }

  /* ============ PARSER TEKS ESP32 ============ */
  function parsePairs(raw) {
    var out = []; raw = raw.trim();
    if (raw.charAt(0) === '{') {
      try { var o = JSON.parse(raw); Object.keys(o).forEach(function (k) { out.push([k, String(o[k])]); }); return out; } catch (e) {}
    }
    raw.split(/[,;|\n\r]+/).forEach(function (tok) {
      tok = tok.trim(); if (!tok) return;
      var multi = tok.match(/[A-Za-z_][\w.]*\s*(?:->|[:=])\s*-?\d/g);
      if (multi && multi.length > 1) {
        var re = /([A-Za-z_][\w.]*)\s*(?:->|[:=])\s*(-?\d+(?:[.,]\d+)?[^\s]*)/g, m;
        while ((m = re.exec(tok))) out.push([m[1], m[2]]);
        return;
      }
      var p = tok.match(/^(.+?)\s*(?:->|[:=])\s*(.+)$/);
      if (p) out.push([p[1].trim(), p[2].trim()]); else out.push(['Data ' + (out.length + 1), tok]);
    });
    return out;
  }
  function splitVal(v) {
    var m = v.match(/^(-?\d+(?:[.,]\d+)?)\s*(.*)$/);
    return m ? { num: m[1], unit: m[2].replace(/^C$/i, '°C'), n: parseFloat(m[1].replace(',', '.')) } : { num: v, unit: '', n: NaN };
  }
  function isOn(t) { return /NYALA|^\s*(on|1|true|high)\s*$/i.test(t); }

  /* ============ STATUS KONEKSI ============ */
  var mqttOk = false, espOnline = null, client = null;
  var PILL = {
    ok:   ['bg-emerald-950/80 border-emerald-500/50', 'bg-emerald-400', 'text-emerald-300'],
    wait: ['bg-amber-950/80 border-amber-500/50', 'bg-amber-400', 'text-amber-300'],
    bad:  ['bg-red-950/80 border-red-500/50', 'bg-red-400', 'text-red-300']
  };
  function pill() {
    var k, t;
    if (!mqttOk) { k = 'bad'; t = 'Broker Terputus'; }
    else if (espOnline) { k = 'ok'; t = 'Terhubung'; }
    else { k = 'wait'; t = espOnline === false ? 'Offline' : 'Menunggu'; }
    $('esp-pill').className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full border ' + PILL[k][0];
    $('esp-dot').className = 'relative inline-flex rounded-full h-2 w-2 ' + PILL[k][1];
    $('esp-text').className = 'text-[11px] font-semibold tracking-tight ' + PILL[k][2];
    $('esp-text').textContent = t;
    $('sub-status').textContent = !mqttOk ? 'Mencoba menyambung ke broker' : espOnline ? 'Data masuk' : 'Menunggu data';
  }

  var BADGE_BAD = ['bg-red-950/80', 'text-red-300', 'border-red-800/60'];
  function badge(n, ok) {
    var el = $('badge-s' + n);
    if (!el.dataset.orig) el.dataset.orig = el.className;
    el.className = ok ? el.dataset.orig : 'text-[10px] font-semibold px-2 py-0.5 rounded-full border ' + BADGE_BAD.join(' ');
    el.textContent = ok ? 'Aktif' : 'No Respon';
  }

  /* ============ HEATER ============ */
  var heaterOn = null;
  function setHeater(on) {
    heaterOn = on;
    var btn = $('toggle-heater-btn'), circ = $('toggle-circle');
    var A = ['bg-gradient-to-r', 'from-amber-500', 'to-orange-500', 'shadow-glow-amber'];
    if (on) {
      btn.classList.remove('bg-slate-700'); A.forEach(function (c) { btn.classList.add(c); });
      circ.classList.remove('translate-x-0'); circ.classList.add('translate-x-6');
      $('heater-status-text').textContent = 'MENYALA';
      $('heater-status-text').className = 'text-lg font-black tracking-tight text-amber-300';
      $('heater-bulb-indicator').className = 'w-2.5 h-2.5 rounded-full bg-amber-400 shadow-glow-amber animate-pulse';
      $('switch-subtitle').textContent = 'Kondisi: MENYALA';
      $('switch-subtitle').className = 'text-[11px] text-amber-400 font-medium';
      $('switch-icon-bg').className = 'w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-300 transition-colors';
    } else {
      A.forEach(function (c) { btn.classList.remove(c); }); btn.classList.add('bg-slate-700');
      circ.classList.remove('translate-x-6'); circ.classList.add('translate-x-0');
      $('heater-status-text').textContent = on === null ? '—' : 'MATI';
      $('heater-status-text').className = 'text-lg font-black tracking-tight text-slate-500';
      $('heater-bulb-indicator').className = 'w-2.5 h-2.5 rounded-full bg-slate-600';
      $('switch-subtitle').textContent = 'Kondisi: ' + (on === null ? '—' : 'MATI');
      $('switch-subtitle').className = 'text-[11px] text-slate-400 font-medium';
      $('switch-icon-bg').className = 'w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-500 transition-colors';
    }
  }
  $('toggle-heater-btn').addEventListener('click', function () {
    if (!mqttOk) { $('switch-subtitle').textContent = 'Tidak terhubung ke broker'; return; }
    var on = !heaterOn;
    var msg = new Paho.MQTT.Message(on ? 'ON' : 'OFF');
    msg.destinationName = CFG.cmd; msg.qos = 1;
    client.send(msg);
    setHeater(on);   // diperbarui lagi oleh respons slave (telur/slave/led)
  });

  /* ============ ISI KARTU ============ */
  function fill(slot, key, val) {
    if (slot.id === 'heater') { setHeater(isOn(val)); $('heater-note').textContent = key + ': ' + val; return; }
    var v = splitVal(val), unit = v.unit || slot.unit;
    var vEl = $('v-' + slot.id), uEl = $('u-' + slot.id), kEl = $('k-' + slot.id);
    vEl.textContent = v.num; if (uEl) uEl.textContent = unit;
    if (kEl) kEl.textContent = 'ESP32: ' + key;
    if (slot.id === 'level') {
      var pct = (unit === '%' && !isNaN(v.n)) ? Math.max(0, Math.min(100, v.n)) : 0;
      $('gauge-fill').style.height = pct + '%';
      $('gauge-text').textContent = v.num + (unit === '%' ? '%' : '');
    }
    if (slot.id === 'hum') $('hum-bar').style.width = (isNaN(v.n) ? 0 : Math.max(0, Math.min(100, v.n))) + '%';
  }
  var extras = {};
  function extra(n, key, val) {
    var id = 'x' + n + '_' + key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!extras[id]) {
      $('sec-extra').style.display = '';
      var el = document.createElement('article');
      el.className = 'glass-card p-3 rounded-2xl border border-slate-700/60';
      el.innerHTML = '<div class="text-[10px] font-medium text-slate-400 mb-1.5 truncate"></div>' +
        '<div class="flex items-baseline space-x-1"><span class="text-2xl font-extrabold text-white tracking-tight"></span>' +
        '<span class="text-xs font-semibold text-slate-400"></span></div><div class="mt-1 text-[9px] text-slate-500 font-mono">Slave ' + n + '</div>';
      el.children[0].textContent = key;
      $('extra-grid').appendChild(el); extras[id] = el;
    }
    var s = splitVal(val), e = extras[id];
    e.querySelector('span').textContent = s.num; e.querySelectorAll('span')[1].textContent = s.unit;
  }
  function handleSlave(n, raw) {
    $('raw-' + n).textContent = raw + '  (' + hhmmss() + ')';
    if (/^\s*NO RESPON\s*$/i.test(raw)) { badge(n, false); return; }
    badge(n, true); espOnline = true; pill();
    var used = {}, slots = SLOTS[n];
    parsePairs(raw).forEach(function (kv, i) {
      if (/^(hari|day)$/i.test(kv[0])) { var dn = parseInt(kv[1], 10); if (dn > 0) { espDay = dn; cycle(); } return; }
      var slot = null;
      if (/^Data \d+$/.test(kv[0])) { slot = slots[i] && !used[slots[i].id] ? slots[i] : null; }
      else { slot = slots.filter(function (s) { return !used[s.id] && s.re.test(kv[0]); })[0] || null; }
      if (slot) { used[slot.id] = 1; fill(slot, kv[0], kv[1]); } else extra(n, kv[0], kv[1]);
    });
  }

  /* ============ JAM ESP32 & SIKLUS ============ */
  var espOffset = null;
  function setEspTime(t) {
    var m = t.match(/(\d+):(\d+):(\d+)/); if (!m) return;
    var d = new Date();
    espOffset = (+m[1] * 3600 + +m[2] * 60 + +m[3]) - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
  }
  function tick() {
    var d = new Date();
    $('current-phone-time').textContent = pad(d.getHours()) + '.' + pad(d.getMinutes());
    $('live-header-clock').textContent = hhmmss(d) + ' WIB';
    if (espOffset !== null) {
      var s = ((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + espOffset) % 86400 + 86400) % 86400;
      $('live-footer-clock').textContent = pad(Math.floor(s / 3600)) + '.' + pad(Math.floor(s / 60) % 60) + '.' + pad(s % 60) + ' WIB';
    }
  }
  var espDay = null, totalDays = CFG.cycleDays;
  try { var sd = parseInt(localStorage.getItem('cycleDays'), 10); if (sd >= 1) totalDays = sd; } catch (e) {}
  function cycle() {
    var st; try { st = localStorage.getItem('cycleStart'); } catch (e) {}
    if (!st) { st = new Date().toDateString(); try { localStorage.setItem('cycleStart', st); } catch (e) {} }
    var day = espDay !== null ? espDay : Math.floor((new Date(new Date().toDateString()) - new Date(st)) / 864e5) + 1;
    $('day-badge').textContent = 'DAY - ' + day;
    $('cycle-text').textContent = 'Pengasinan Hari ke-' + day + '  dari  ' + totalDays;
    $('cycle-eta').textContent = day > totalDays ? 'Siklus selesai' : day === totalDays ? 'Estimasi Panen: hari ini' : 'Estimasi Panen: ' + (totalDays - day) + ' Hari Lagi';
  }
  $('day-badge').addEventListener('click', function () {
    var n = parseInt(prompt('Hari ke berapa sekarang? (1-' + totalDays + ')', $('day-badge').textContent.replace(/\D/g, '')), 10);
    if (!(n >= 1)) return;
    var d = new Date(); d.setDate(d.getDate() - (n - 1));
    try { localStorage.setItem('cycleStart', d.toDateString()); } catch (e) {}
    espDay = null; cycle();
  });

  $('cycle-text').addEventListener('click', function () {
    var n = parseInt(prompt('Lama siklus pengasinan (hari)?', totalDays), 10);
    if (!(n >= 1)) return;
    totalDays = n;
    try { localStorage.setItem('cycleDays', String(n)); } catch (e) {}
    cycle();
  });

  /* ============ MQTT ============ */
  function onMsg(m) {
    var tail = m.destinationName.split('/').pop(), t = m.payloadString;
    if (tail === 'status') { espOnline = /online/i.test(t); pill(); return; }
    if (m.retained) return;                       // abaikan data lama di broker
    if (tail === 'siklus') {
      var mm = t.match(/HARI:(\d+).*TARGET:(\d+)/i);
      if (mm) { espDay = parseInt(mm[1], 10); totalDays = parseInt(mm[2], 10); cycle(); }
      return;
    }
    if (tail === 'time') { setEspTime(t); return; }
    if (tail === 'led') { setHeater(isOn(t)); return; }
    if (tail === '1' || tail === '2') handleSlave(+tail, t);
  }
  function connect() {
    client = new Paho.MQTT.Client(CFG.host, CFG.port, 'web_' + Math.random().toString(16).slice(2, 10));
    client.onConnectionLost = function () { mqttOk = false; espOnline = null; pill(); setTimeout(connect, 5000); };
    client.onMessageArrived = onMsg;
    client.connect({
      useSSL: true, userName: CFG.user, password: CFG.pass, keepAliveInterval: 30, timeout: 10,
      onSuccess: function () { mqttOk = true; pill(); client.subscribe(CFG.sub, { qos: 0 }); },
      onFailure: function () { mqttOk = false; pill(); setTimeout(connect, 8000); }
    });
  }

  setHeater(null); pill(); cycle(); tick(); setInterval(tick, 1000); connect();
})();
