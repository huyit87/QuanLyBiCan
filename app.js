'use strict';
/*
 * Quản lý bị can — ứng dụng web cài trên iPhone (PWA).
 * Toàn bộ dữ liệu nằm trong IndexedDB của máy, mỗi hồ sơ được mã hoá AES-GCM
 * bằng khoá dẫn xuất từ mật khẩu (PBKDF2). Không có máy chủ, không gửi dữ liệu đi đâu.
 */
(() => {
  // ---------- Hằng số nghiệp vụ ----------
  const BIEN_PHAP = {
    tamgiam: 'Tạm giam',
    tamgiu: 'Tạm giữ',
    camdi: 'Cấm đi khỏi nơi cư trú',
    baolinh: 'Bảo lĩnh',
    dattien: 'Đặt tiền để bảo đảm',
    truyna: 'Đang truy nã',
    khac: 'Khác / chưa áp dụng',
  };
  const GIAI_DOAN = {
    dieutra: 'Đang điều tra',
    ketluan: 'Đã kết luận điều tra',
    dtbs: 'Điều tra bổ sung',
    truyto: 'Truy tố',
    xetxu: 'Xét xử',
    tamdinhchi: 'Tạm đình chỉ',
    dinhchi: 'Đình chỉ',
  };
  const CO_QUAN_TRA = { vks: 'Viện kiểm sát trả', toa: 'Toà án trả' };
  const GIAM_GIU = ['tamgiam', 'tamgiu'];
  const TAI_NGOAI = ['camdi', 'baolinh', 'dattien'];
  // Bảng tra số ngày theo loại thời hạn (sửa được trong Cài đặt).
  // Đến ngày = từ ngày + số ngày − 1, tương đương công thức Excel =B4+VLOOKUP(A4;bảng;2;0)-1
  const DEFAULT_TERMS = [
    { ten: 'Tạm giữ 3 ngày', ngay: 3 },
    { ten: '1 tháng', ngay: 30 },
    { ten: '2 tháng', ngay: 60 },
    { ten: '3 tháng', ngay: 90 },
    { ten: '4 tháng', ngay: 120 },
  ];
  // statDay/statMonth: ngày bắt đầu kỳ thống kê năm (mặc định 15/11: năm 2026 là 15/11/2025 – 14/11/2026).
  const defaultSettings = () => ({ alertDays: 10, statDay: 15, statMonth: 11, terms: DEFAULT_TERMS.map((t) => ({ ...t })) });
  const APP_VERSION = '9'; // tăng cùng lúc với VERSION trong sw.js
  const PBKDF2_ITER = 310000;
  const AUTO_LOCK_MS = 60 * 1000;

  // ---------- Tiện ích ----------
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const pad2 = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = () => iso(new Date());
  const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  const addDays = (s, n) => { const d = new Date(toUTC(s) + n * 86400000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
  const vn = (s) => (s ? s.split('-').reverse().join('/') : '');
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const initials = (name) => { const p = String(name || '?').trim().split(/\s+/); return (p[p.length - 1][0] || '?').toUpperCase(); };

  function b64(bytes) {
    const u = new Uint8Array(bytes); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- IndexedDB ----------
  let db;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('qlbc', 2);
      r.onupgradeneeded = () => {
        const d = r.result; const has = (n) => d.objectStoreNames.contains(n);
        if (!has('meta')) d.createObjectStore('meta');
        if (!has('bican')) d.createObjectStore('bican', { keyPath: 'id' });
        if (!has('vuan')) d.createObjectStore('vuan', { keyPath: 'id' });   // vụ án (từ phiên bản 6)
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => res(rq ? rq.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Giao dịch bị huỷ'));
    });
  }
  const metaGet = (k) => tx('meta', 'readonly', (s) => s.get(k));
  const metaSet = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));

  // ---------- Mã hoá ----------
  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(k, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj))));
    return { iv, ct };
  }
  async function unseal(k, box) {
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, k, box.ct)));
  }
  async function makeAuth(pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const k = await deriveKey(pass, salt, PBKDF2_ITER);
    return { key: k, auth: { salt, iter: PBKDF2_ITER, check: await seal(k, { ok: true }) } };
  }
  async function keyFromAuth(pass, auth) {
    const k = await deriveKey(pass, auth.salt, auth.iter);
    try { await unseal(k, auth.check); } catch { return null; }
    return k;
  }

  // ---------- Trạng thái ----------
  let key = null;            // khoá AES, chỉ giữ trong bộ nhớ khi đã mở khoá
  let auth = null;           // { salt, iter, check }
  let records = [];          // hồ sơ đã giải mã
  let settings = defaultSettings();
  let cases = [];            // vụ án đã giải mã
  const ui = { tab: 'home', page: null, q: '', filter: 'all', draft: null, cdraft: null, lockErr: '', scan: null,
    st: { nam: String(new Date().getFullYear()), vuAn: '', dtv: '', ksv: '', toiDanh: '', bienPhap: '', giaiDoan: '' } };

  async function loadRecords() {
    const rows = await tx('bican', 'readonly', (s) => s.getAll());
    const out = [];
    for (const row of rows) out.push(normalize(await unseal(key, row)));
    records = out;
    const crows = await tx('vuan', 'readonly', (s) => s.getAll());
    const cs = [];
    for (const row of crows) cs.push(normCase(await unseal(key, row)));
    cases = cs;
    await syncCases(); await refreshAllCases();
  }
  // Bổ sung các trường mới cho hồ sơ tạo từ phiên bản cũ.
  function normalize(r) {
    r.giaHan = r.giaHan || []; r.dtbs = r.dtbs || [];
    for (const k of ['loaiHan', 'soKLDT', 'ngayKLDT', 'soDC', 'ngayDC', 'soTDC', 'ngayTDC']) r[k] = r[k] || '';
    return r;
  }
  function normCase(c) { for (const k of ['diaBan', 'dauVu', 'soKLDT', 'ngayKLDT', 'soDC', 'ngayDC', 'soTDC', 'ngayTDC', 'ghiChu']) c[k] = c[k] || ''; return c; }
  // Ghi ngày đình chỉ / tạm đình chỉ mới thì chuyển giai đoạn tương ứng.
  function stageFromStop(r, old) {
    if (r.ngayDC && (!old || old.ngayDC !== r.ngayDC)) r.giaiDoan = 'dinhchi';
    else if (r.ngayTDC && (!old || old.ngayTDC !== r.ngayTDC)) r.giaiDoan = 'tamdinhchi';
  }
  // ---------- Kỳ thống kê ----------
  const pad = (n) => String(n).padStart(2, '0');
  const statMD = () => `${pad(settings.statMonth || 1)}-${pad(settings.statDay || 1)}`;
  const fromJan = () => statMD() === '01-01';
  // Kỳ năm Y: [bắt đầu, kết thúc) — ví dụ mốc 15/11: 15/11/(Y-1) đến hết 14/11/Y.
  const periodStart = (y) => `${fromJan() ? y : y - 1}-${statMD()}`;
  const periodOf = (d) => { const y = Number(d.slice(0, 4)); return fromJan() || d < `${y}-${statMD()}` ? y : y + 1; };
  // Tự đặt giai đoạn theo kết luận điều tra / điều tra bổ sung (không đụng tới đình chỉ, tạm đình chỉ).
  function autoStage(r) {
    if (['dinhchi', 'tamdinhchi'].includes(r.giaiDoan)) return;
    const last = r.dtbs[r.dtbs.length - 1];
    if (last && !last.ngayKL) r.giaiDoan = 'dtbs';
    else if (['dieutra', 'dtbs'].includes(r.giaiDoan) && (r.ngayKLDT || last)) r.giaiDoan = 'ketluan';
  }
  async function putRecord(r) {
    const box = await seal(key, r);
    await tx('bican', 'readwrite', (s) => s.put({ id: r.id, iv: box.iv, ct: box.ct }));
    const i = records.findIndex((x) => x.id === r.id);
    if (i >= 0) records[i] = r; else records.push(r);
  }
  async function removeRecord(id) {
    await tx('bican', 'readwrite', (s) => s.delete(id));
    records = records.filter((x) => x.id !== id);
  }

  // ---------- Vụ án ----------
  const normName = (v) => fold(String(v || '')).replace(/\s+/g, ' ').trim();
  const clone = (o) => JSON.parse(JSON.stringify(o));
  async function putCase(c) {
    const box = await seal(key, c);
    await tx('vuan', 'readwrite', (s) => s.put({ id: c.id, iv: box.iv, ct: box.ct }));
    const i = cases.findIndex((x) => x.id === c.id);
    if (i >= 0) cases[i] = c; else cases.push(c);
  }
  async function removeCase(id) {
    await tx('vuan', 'readwrite', (s) => s.delete(id));
    cases = cases.filter((x) => x.id !== id);
  }
  // Tìm vụ theo tên hiện tại, hoặc theo tên cũ (tên trước khi được đặt lại theo quy ước).
  const caseByName = (name) => {
    const k = normName(name); if (!k) return undefined;
    return cases.find((c) => normName(c.ten) === k) || cases.find((c) => (c.tenCu || []).some((t) => normName(t) === k));
  };
  function blankCase(ten = '') {
    return { id: uid(), ten, tuDat: true, soQDKTVA: '', ngayKTVA: '', toiDanh: '', dieuKhoan: '', diaBan: '', dauVu: '', dtv: '', soKLDT: '', ngayKLDT: '', soDC: '', ngayDC: '', soTDC: '', ngayTDC: '', ghiChu: '', createdAt: Date.now(), updatedAt: Date.now() };
  }
  const CASE_SEED = ['soQDKTVA', 'ngayKTVA', 'toiDanh', 'dieuKhoan', 'dtv'];
  // Bảo đảm tên vụ án ghi trong hồ sơ bị can luôn có trong danh sách vụ án.
  async function ensureCase(name, seed = {}) {
    name = String(name || '').trim(); if (!name) return null;
    let c = caseByName(name); let changed = false;
    if (!c) { c = blankCase(name); changed = true; }
    for (const k of CASE_SEED) if (!c[k] && seed[k]) { c[k] = seed[k]; changed = true; }
    if (changed) { c.updatedAt = Date.now(); await putCase(c); }
    return c;
  }
  async function syncCases() { for (const r of records) if (normName(r.vuAn) && !caseByName(r.vuAn)) await ensureCase(r.vuAn, r); }
  // Gắn bị can vào vụ án đã có: theo tên, hoặc theo số quyết định khởi tố vụ án.
  // So khớp số quyết định: giống hệt, hoặc cùng số đứng đầu (27 ~ 27/QĐ-CSMT) mà ngày không mâu thuẫn.
  const soKey = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  const soNum = (v) => (/\d+/.exec(String(v || '')) || [''])[0].replace(/^0+/, '');
  function caseBySo(so, ngay) {
    if (!so) return undefined;
    return cases.find((c) => c.soQDKTVA && soKey(c.soQDKTVA) === soKey(so))
      || cases.find((c) => c.soQDKTVA && soNum(c.soQDKTVA) && soNum(c.soQDKTVA) === soNum(so) && (!ngay || !c.ngayKTVA || ngay === c.ngayKTVA));
  }
  // Gắn bị can vào vụ án đã có: theo tên, hoặc theo số quyết định khởi tố vụ án.
  function linkCase(r) {
    let c = caseByName(r.vuAn);
    if (!c && !normName(r.vuAn)) c = caseBySo(r.soQDKTVA, r.ngayKTVA);
    if (!c) return;
    r.vuAn = c.ten;
    for (const k of ['soQDKTVA', 'ngayKTVA']) if (c[k]) r[k] = c[k];
  }
  const casePeople = (c) => records.filter((r) => normName(r.vuAn) === normName(c.ten));
  const first = (list, k) => list.map((r) => r[k]).filter(Boolean).sort()[0] || '';
  const byKTBC = (a, b) => (a.ngayKTBC || '9999').localeCompare(b.ngayKTBC || '9999') || byName(a, b);
  // Bị can đầu vụ: người được chọn trong vụ án, nếu chưa chọn thì là bị can bị khởi tố sớm nhất.
  const leadOf = (c, rs) => rs.find((r) => r.id === c.dauVu) || [...rs].sort(byKTBC)[0];
  // ---------- Quy ước tên vụ án: đối tượng chính + hành vi + phường xảy ra ----------
  function wardOf(diaBan) {
    const m = /(phường|xã|thị trấn|đặc khu)\s+[^,;.()]+/i.exec(diaBan || '');
    return (m ? m[0] : String(diaBan || '')).trim().replace(/^[PXTĐ]/, (ch) => ch.toLowerCase());
  }
  function conventionName(c, rs) {
    const lead = leadOf(c, rs); const toi = (c.toiDanh || first(rs, 'toiDanh')).trim(); const ward = wardOf(c.diaBan);
    if (!lead && !toi) return '';
    const act = lead && toi ? toi.charAt(0).toLowerCase() + toi.slice(1) : toi;
    return [lead ? lead.hoTen : '', act, ward ? 'tại ' + ward : ''].filter(Boolean).join(' ');
  }
  function rememberName(c) {
    if (!c.ten) return;
    c.tenCu = [c.ten, ...(c.tenCu || []).filter((t) => normName(t) !== normName(c.ten))].slice(0, 8);
  }
  function uniqueName(name, c) {
    if (!cases.some((x) => x.id !== c.id && (normName(x.ten) === normName(name) || (x.tenCu || []).some((t) => normName(t) === normName(name))))) return name;
    return `${name} (QĐ ${c.soQDKTVA || c.id.slice(0, 4)})`;
  }
  // Đặt lại tên vụ theo quy ước (trừ vụ người dùng chọn tự nhập tên) và cập nhật tên vụ trong hồ sơ các bị can.
  async function refreshCaseName(c) {
    if (!c || c.tuDat === false) return;
    const rs = casePeople(c); const conv = conventionName(c, rs);
    if (!conv) return;
    const name = uniqueName(conv, c);
    if (name === c.ten) return;
    for (const r of rs) { r.vuAn = name; await putRecord(r); }
    rememberName(c); c.ten = name; c.updatedAt = Date.now(); await putCase(c);
  }
  async function refreshAllCases() { for (const c of [...cases]) await refreshCaseName(c); }
  const caseDate = (c, rs) => c.ngayKTVA || first(rs || casePeople(c), 'ngayKTVA');
  function caseStatus(c, rs) {
    const any = (...g) => rs.some((r) => g.includes(r.giaiDoan));
    if (any('dtbs')) return 'dtbs';
    if (!rs.length && c.ngayDC) return 'dinhchi';
    if (!rs.length && c.ngayTDC) return 'tamdinhchi';
    if (any('dieutra') || (!rs.length && !c.ngayKLDT)) return 'dieutra';
    if (any('ketluan', 'truyto', 'xetxu') || c.ngayKLDT) return 'ketluan';
    if (any('tamdinhchi')) return 'tamdinhchi';
    return 'dinhchi';
  }

  // ---------- Hồ sơ trùng ----------
  // Hai hồ sơ là một người nếu trùng CCCD; hoặc trùng họ tên và ngày sinh;
  // hoặc trùng họ tên, thiếu ngày sinh, và không thuộc hai vụ án khác nhau.
  function samePerson(a, b) {
    if (a.cccd && b.cccd) return a.cccd === b.cccd;
    const na = normName(a.hoTen); if (!na || na.startsWith('(') || na !== normName(b.hoTen)) return false;
    if (a.ngaySinh && b.ngaySinh) return a.ngaySinh === b.ngaySinh;
    return !normName(a.vuAn) || !normName(b.vuAn) || normName(a.vuAn) === normName(b.vuAn);
  }
  const findExisting = (got, exceptId) => records.find((r) => r.id !== exceptId && samePerson(r, got));
  function dupGroups() {
    const used = new Set(); const out = [];
    records.forEach((r, i) => {
      if (used.has(r.id)) return;
      const g = [r];
      for (let j = i + 1; j < records.length; j++) if (!used.has(records[j].id) && g.some((x) => samePerson(x, records[j]))) { g.push(records[j]); used.add(records[j].id); }
      if (g.length > 1) { used.add(r.id); out.push(g); }
    });
    return out;
  }
  function mergeGroup(g) {
    const filled = (r) => Object.values(r).filter((v) => (Array.isArray(v) ? v.length : v)).length;
    const sorted = [...g].sort((a, b) => filled(b) - filled(a));
    const base = clone(sorted[0]);
    for (const o of sorted.slice(1)) {
      for (const [k, v] of Object.entries(o)) {
        if (Array.isArray(v)) { base[k] = base[k] || []; for (const it of v) if (!base[k].some((x) => JSON.stringify(x) === JSON.stringify(it))) base[k].push(it); }
        else if (!base[k] && v) base[k] = v;
      }
      base.createdAt = Math.min(base.createdAt || Date.now(), o.createdAt || Date.now());
    }
    base.updatedAt = Date.now(); autoStage(base);
    return base;
  }

  // ---------- Nghiệp vụ: thời hạn tạm giữ / tạm giam ----------
  function deadlineOf(r) {
    if (!GIAM_GIU.includes(r.bienPhap) || r.giaiDoan === 'dinhchi') return null;
    const ds = [r.tgDen, ...(r.giaHan || []).map((g) => g.den)].filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : null;
  }
  function termDays(ten) {
    const t = (settings.terms || []).find((x) => x.ten === ten);
    return t && t.ngay > 0 ? t.ngay : 0;
  }
  function termOpts(cur) {
    const o = { '': '— Tự nhập "đến ngày" —' };
    for (const t of settings.terms || []) if (t.ten) o[t.ten] = `${t.ten} — ${t.ngay} ngày`;
    if (cur && !(cur in o)) o[cur] = `${cur} (không còn trong bảng)`;
    return o;
  }
  function dlInfo(r) {
    const d = deadlineOf(r);
    if (!d) return null;
    const left = diffDays(today(), d);
    const level = left <= 0 ? 'red' : left <= settings.alertDays ? 'orange' : 'green';
    const text = left < 0 ? `Quá hạn ${-left} ngày` : left === 0 ? 'Hết hạn hôm nay' : `Còn ${left} ngày`;
    return { date: d, left, level, text };
  }
  const alerts = () => records.map((r) => ({ r, d: dlInfo(r) })).filter((x) => x.d && x.d.level !== 'green').sort((a, b) => a.d.left - b.d.left);
  function bpTag(r) {
    const cls = GIAM_GIU.includes(r.bienPhap) ? 'blue' : r.bienPhap === 'truyna' ? 'red' : TAI_NGOAI.includes(r.bienPhap) ? 'green' : '';
    return `<span class="tag ${cls}">${esc(BIEN_PHAP[r.bienPhap] || 'Chưa rõ')}</span>`;
  }
  const byName = (a, b) => fold(a.hoTen).localeCompare(fold(b.hoTen));

  // ---------- Giao diện: khung ----------
  const ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    list: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.900 1.900 6.500 5.500"/><path d="M16 5.500a3 3 0 010 5.500M18.500 15c1.700.800 2.700 2.500 3 5"/></svg>',
    cases: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg>',
    stats: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900l2.100 2.100M17 17l2.100 2.100M4.900 19.100L7 17M17 7l2.100-2.100"/></svg>',
  };
  function bar(title, left = '', right = '') {
    return `<header class="bar"><div class="side">${left}</div><h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
  }
  function tabs() {
    const n = alerts().length;
    const t = (id, label) => `<button data-act="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}">${ICON[id]}${label}${id === 'home' && n ? `<span class="dot">${n}</span>` : ''}</button>`;
    return `<nav class="tabs">${t('home', 'Tổng quan')}${t('list', 'Bị can')}${t('cases', 'Vụ án')}${t('stats', 'Thống kê')}${t('settings', 'Cài đặt')}</nav>`;
  }
  function avatar(r, big) {
    return r.anh
      ? `<img class="avatar ${big ? 'big' : ''}" src="${esc(r.anh)}" alt="">`
      : `<div class="avatar ${big ? 'big' : ''}">${esc(initials(r.hoTen))}</div>`;
  }
  function personRow(r, withDeadline) {
    const d = dlInfo(r);
    const sub = [r.toiDanh, r.vuAn].filter(Boolean).join(' · ') || (r.ngaySinh ? `Sinh ${vn(r.ngaySinh)}` : '');
    const bs = r.dtbs && r.dtbs[r.dtbs.length - 1];
    const right = withDeadline === 'dtbs' && bs
      ? `<span class="tag orange">Lần ${r.dtbs.length}</span><div class="sub">${bs.gd === 'toa' ? 'Toà án trả' : 'VKS trả'}${bs.ngayTra ? ' ' + vn(bs.ngayTra) : ''}</div>`
      : withDeadline && d
      ? `<span class="tag ${d.level}">${esc(d.text)}</span><div class="sub">${vn(d.date)}</div>`
      : `${bpTag(r)}${d && d.level !== 'green' ? `<div class="sub"><span class="tag ${d.level}">${esc(d.text)}</span></div>` : ''}`;
    return `<button class="row" data-act="open" data-id="${esc(r.id)}">${avatar(r)}<div class="main"><div class="name">${esc(r.hoTen)}</div><div class="sub">${esc(sub)}</div></div><div class="right">${right}</div></button>`;
  }

  // ---------- Giao diện: các tab ----------
  function viewHome() {
    const giam = records.filter((r) => GIAM_GIU.includes(r.bienPhap) && r.giaiDoan !== 'dinhchi');
    const ngoai = records.filter((r) => TAI_NGOAI.includes(r.bienPhap));
    const truyna = records.filter((r) => r.bienPhap === 'truyna');
    const kl = records.filter((r) => ['ketluan', 'truyto', 'xetxu'].includes(r.giaiDoan));
    const bs = records.filter((r) => r.giaiDoan === 'dtbs');
    const bsVks = bs.filter((r) => (r.dtbs[r.dtbs.length - 1] || {}).gd !== 'toa').length;
    const bsLan = {}; bs.forEach((r) => { const l = r.dtbs.length || 1; bsLan[l] = (bsLan[l] || 0) + 1; });
    const al = alerts();
    const upcoming = records.map((r) => ({ r, d: dlInfo(r) })).filter((x) => x.d && x.d.level === 'green').sort((a, b) => a.d.left - b.d.left);
    return `${bar('Quản lý bị can', '', '<button data-act="lock">Khoá</button>')}
    <main class="content">
      <div class="stats">
        <button class="stat" data-act="goFilter" data-filter="all"><b>${records.length}</b><span>Tổng số bị can</span></button>
        <button class="stat" data-act="goFilter" data-filter="giam"><b>${giam.length}</b><span>Đang tạm giữ, tạm giam</span></button>
        <button class="stat" data-act="goFilter" data-filter="ngoai"><b>${ngoai.length}</b><span>Tại ngoại</span></button>
        <button class="stat ${truyna.length ? 'red' : ''}" data-act="goFilter" data-filter="truyna"><b>${truyna.length}</b><span>Đang truy nã</span></button>
        <button class="stat" data-act="goFilter" data-filter="xong"><b>${kl.length}</b><span>Đã kết luận điều tra</span></button>
        <button class="stat ${bs.length ? 'orange' : ''}" data-act="goFilter" data-filter="dtbs"><b>${bs.length}</b><span>Điều tra bổ sung${bs.length ? ` (VKS trả ${bsVks}, Toà trả ${bs.length - bsVks})` : ''}</span></button>
      </div>
      ${bs.length ? `<h3 class="section-title">Đang điều tra bổ sung (${bs.length}) — ${Object.entries(bsLan).map(([l, n]) => `lần ${l}: ${n}`).join(', ')}</h3>
      <div class="card">${bs.map((r) => personRow(r, 'dtbs')).join('')}</div>` : ''}
      <h3 class="section-title">Hạn tạm giữ, tạm giam cần chú ý (${al.length})</h3>
      <div class="card">${al.length ? al.map((x) => personRow(x.r, true)).join('') : `<div class="empty">Không có hạn nào quá hạn hoặc sắp hết trong ${settings.alertDays} ngày tới.</div>`}</div>
      ${upcoming.length ? `<h3 class="section-title">Các hạn tiếp theo</h3><div class="card">${upcoming.map((x) => personRow(x.r, true)).join('')}</div>` : ''}
      <button class="btn" data-act="newScan">Thêm bị can từ văn bản (ảnh, PDF)</button>
      <button class="btn plain" data-act="new">Thêm bị can nhập tay</button>
      <input id="scanFile" type="file" accept="image/*,application/pdf,.pdf" multiple hidden>
    </main>`;
  }

  const FILTERS = [
    ['all', 'Tất cả', () => true],
    ['giam', 'Tạm giữ, tạm giam', (r) => GIAM_GIU.includes(r.bienPhap)],
    ['ngoai', 'Tại ngoại', (r) => TAI_NGOAI.includes(r.bienPhap)],
    ['truyna', 'Truy nã', (r) => r.bienPhap === 'truyna'],
    ['dieutra', 'Đang điều tra', (r) => r.giaiDoan === 'dieutra'],
    ['xong', 'Đã kết luận điều tra', (r) => ['ketluan', 'truyto', 'xetxu'].includes(r.giaiDoan)],
    ['dtbs', 'Điều tra bổ sung', (r) => r.giaiDoan === 'dtbs'],
    ['dinhchi', 'Đình chỉ, tạm đình chỉ', (r) => ['dinhchi', 'tamdinhchi'].includes(r.giaiDoan)],
  ];
  function listHtml() {
    const f = FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0];
    const q = fold(ui.q.trim());
    const rows = records.filter(f[2]).filter((r) => !q || fold([r.hoTen, r.tenKhac, r.cccd, r.vuAn, r.toiDanh, r.noiGiam, r.dtv].join(' ')).includes(q)).sort(byName);
    if (!rows.length) return `<div class="empty">${records.length ? 'Không tìm thấy bị can phù hợp.' : 'Chưa có bị can nào. Bấm + để thêm.'}</div>`;
    return `<div class="card">${rows.map((r) => personRow(r)).join('')}</div><p class="note">${rows.length} bị can</p>`;
  }
  function viewList() {
    const dups = dupGroups();
    return `${bar('Danh sách bị can')}
    <main class="content">
      <input class="search" id="q" type="search" placeholder="Tìm tên, CCCD, vụ án, tội danh…" value="${esc(ui.q)}" autocomplete="off">
      <div class="chips">${FILTERS.map(([id, label]) => `<button class="chip ${ui.filter === id ? 'on' : ''}" data-act="filter" data-filter="${id}">${label}</button>`).join('')}</div>
      ${dups.length ? `<div class="card pad scan-note" style="margin-bottom:10px"><b>Có ${dups.length} bị can bị nhập trùng (${dups.reduce((n, g) => n + g.length, 0)} hồ sơ).</b>
        <p>${esc(dups.slice(0, 5).map((g) => g[0].hoTen).join(', '))}${dups.length > 5 ? '…' : ''}</p>
        <button class="link" data-act="mergeDups" style="margin-top:6px;font-weight:600">Gộp các hồ sơ trùng</button></div>` : ''}
      <div id="list">${listHtml()}</div>
    </main>
    <button class="fab" data-act="new" aria-label="Thêm bị can">+</button>`;
  }

  const so = (num, date) => [num ? `số ${num}` : '', date ? `ngày ${vn(date)}` : ''].filter(Boolean).join(', ');
  const SCAN_INPUT = '<input id="scanFile" type="file" accept="image/*,application/pdf,.pdf" multiple hidden>';
  function viewCases() {
    // Sắp theo ngày khởi tố vụ án (cũ trước, mới sau); vụ chưa ghi ngày khởi tố nằm cuối.
    const list = cases.map((c) => { const rs = casePeople(c); return { c, rs, kt: caseDate(c, rs) }; })
      .sort((a, b) => (a.kt || '9999').localeCompare(b.kt || '9999') || fold(a.c.ten).localeCompare(fold(b.c.ten)));
    const loose = records.filter((r) => !normName(r.vuAn));
    return `${bar('Vụ án')}
    <main class="content">
      <h3 class="section-title">${list.length} vụ án đang quản lý — theo ngày khởi tố</h3>
      ${list.length || loose.length ? `<div class="card">${list.map(({ c, rs, kt }, i) => {
        const st = caseStatus(c, rs);
        const lead = leadOf(c, rs); const toi = c.toiDanh || first(rs, 'toiDanh');
        const head = lead ? `${lead.hoTen}${rs.length > 1 ? ' cùng đồng phạm' : ''}` : c.ten;
        return `<button class="row crow" data-act="case" data-id="${esc(c.id)}"><div class="main">
          <div class="name" style="white-space:normal">${i + 1}. ${esc(head)}</div>
          ${toi ? `<div class="cl"><span>Tội danh</span>${esc(toi)}</div>` : ''}
          ${c.diaBan ? `<div class="cl"><span>Địa bàn</span>${esc(c.diaBan)}</div>` : ''}
          <div class="sub" style="white-space:normal">${esc([kt ? 'Khởi tố ' + vn(kt) : 'Chưa ghi ngày khởi tố', c.soQDKTVA ? 'QĐ số ' + c.soQDKTVA : '', `${rs.length} bị can`].filter(Boolean).join(' · '))}
            <span class="tag ${st === 'dtbs' ? 'orange' : st === 'dieutra' ? 'blue' : st === 'ketluan' ? 'green' : ''}">${esc(GIAI_DOAN[st])}</span></div>
        </div><span class="chev">›</span></button>`;
      }).join('')}${loose.length ? `<button class="row" data-act="case" data-id=""><div class="main"><div class="name">Bị can chưa gắn vụ án</div><div class="sub">${loose.length} bị can</div></div><span class="chev">›</span></button>` : ''}</div>`
      : '<div class="empty">Chưa có vụ án nào.</div>'}
      <button class="btn" data-act="newScan">Thêm vụ án từ văn bản (QĐ khởi tố vụ án)</button>
      <button class="btn plain" data-act="newCase">Thêm vụ án nhập tay</button>
      ${SCAN_INPUT}
    </main>`;
  }
  // Thẻ thông tin bị can trong trang vụ án.
  function personCard(r, i, lead) {
    const d = dlInfo(r); const bs = r.dtbs[r.dtbs.length - 1];
    const line = (k, v) => (v ? `<div class="pl"><span>${esc(k)}</span><div>${esc(v)}</div></div>` : '');
    return `<button class="pcard" data-act="open" data-id="${esc(r.id)}">
      <div class="pc-head">${avatar(r)}<div class="main"><div class="name">${i + 1}. ${esc(r.hoTen)} ${lead ? '<span class="tag blue">Đầu vụ</span>' : ''}</div>
        <div class="sub">${esc([r.ngaySinh ? 'Sinh ' + vn(r.ngaySinh) : '', r.cccd ? 'CCCD ' + r.cccd : ''].filter(Boolean).join(' · '))}</div></div><span class="chev">›</span></div>
      <div class="pc-tags">${bpTag(r)}<span class="tag">${esc(GIAI_DOAN[r.giaiDoan] || '')}</span>${d ? `<span class="tag ${d.level}">${esc(d.text)}</span>` : ''}</div>
      ${line('Khởi tố bị can', so(r.soQDKTBC, r.ngayKTBC))}
      ${line('Tội danh', [r.toiDanh, r.dieuKhoan].filter(Boolean).join(' — '))}
      ${line('Hạn giam giữ', d ? `đến ${vn(d.date)}${r.noiGiam ? ' · ' + r.noiGiam : ''}` : '')}
      ${line('Nơi thường trú', r.hktt)}
      ${line('Kết luận điều tra', so(r.soKLDT, r.ngayKLDT))}
      ${line('Điều tra bổ sung', bs ? `Lần ${r.dtbs.length}, ${CO_QUAN_TRA[bs.gd] || CO_QUAN_TRA.vks}${bs.ngayTra ? ' ' + vn(bs.ngayTra) : ''}${bs.ngayKL ? '; đã kết luận bổ sung ' + vn(bs.ngayKL) : '; chưa kết luận bổ sung'}` : '')}
      ${line('Tạm đình chỉ', so(r.soTDC, r.ngayTDC))}
      ${line('Đình chỉ', so(r.soDC, r.ngayDC))}
    </button>`;
  }
  function viewCase(id) {
    const c = cases.find((x) => x.id === id);
    const rs = (c ? casePeople(c) : records.filter((r) => !normName(r.vuAn))).sort(byKTBC);
    const lead = c && leadOf(c, rs); const loose = records.filter((r) => !normName(r.vuAn));
    if (lead) { rs.splice(rs.indexOf(lead), 1); rs.unshift(lead); }   // bị can đầu vụ đứng đầu
    const people = rs.map((r, i) => personCard(r, i, r === lead)).join('');
    if (!c) {
      return `${bar('Chưa gắn vụ án', '<button data-act="back">‹ Quay lại</button>')}
      <main class="content nopad-bottom"><p class="note" style="margin-bottom:8px">Mở từng hồ sơ, bấm Sửa và chọn tên vụ án để gắn bị can vào vụ.</p>
      ${people || '<div class="card"><div class="empty">Không có bị can nào.</div></div>'}</main>`;
    }
    return `${bar('Vụ án', '<button data-act="back">‹ Quay lại</button>', `<button class="strong" data-act="editCase" data-id="${esc(c.id)}">Sửa</button>`)}
    <main class="content nopad-bottom">
      <div class="card pad"><h2 style="font-size:18px">${esc(c.ten)}</h2><div style="margin-top:6px"><span class="tag">${esc(GIAI_DOAN[caseStatus(c, rs)])}</span></div></div>
      ${block('Thông tin vụ án', [kv('Bị can đầu vụ', lead ? lead.hoTen : ''), kv('Tội danh', c.toiDanh || first(rs, 'toiDanh')), kv('Điều khoản BLHS', c.dieuKhoan),
        kv('Địa bàn xảy ra', c.diaBan), kv('QĐ khởi tố vụ án', so(c.soQDKTVA, caseDate(c, rs))),
        kv('Điều tra viên', c.dtv), kv('Kết luận điều tra', so(c.soKLDT, c.ngayKLDT)), kv('Tạm đình chỉ', so(c.soTDC, c.ngayTDC)), kv('Đình chỉ', so(c.soDC, c.ngayDC)), kv('Ghi chú', c.ghiChu)])}
      <h3 class="section-title">Bị can bị khởi tố (${rs.length})</h3>
      ${people || '<div class="card"><div class="empty">Chưa có bị can nào trong vụ này.</div></div>'}
      <button class="btn" data-act="new">Thêm bị can vào vụ này</button>
      ${loose.length ? `<button class="btn plain" data-act="attachPage" data-id="${esc(c.id)}">Gắn bị can chưa có vụ án vào vụ này (${loose.length})</button>` : ''}
      ${rs.length ? '' : `<button class="btn danger" data-act="delCase" data-id="${esc(c.id)}">Xoá vụ án</button>`}
    </main>`;
  }
  function scanNote(what) {
    if (!ui.scan) return '';
    return `<div class="card pad scan-note" style="margin-top:10px"><b>Đã tự điền ${ui.scan.filled.length} mục từ văn bản — hãy kiểm tra lại từng mục trước khi lưu.</b>
      ${ui.scan.existed ? `<p>${esc(what)} này đã có trong app — thông tin mới được bổ sung vào hồ sơ cũ, không tạo hồ sơ trùng.</p>` : ''}
      ${ui.scan.filled.length ? `<p>${esc(ui.scan.filled.join(', '))}</p>` : '<p>Không dò được thông tin mới. Thử ảnh rõ hơn, chụp thẳng, đủ sáng.</p>'}
      <details><summary>Xem chữ đọc được</summary><pre>${esc(ui.scan.text)}</pre></details></div>`;
  }
  function viewCaseForm() {
    const c = ui.cdraft; const isNew = !cases.some((x) => x.id === c.id);
    const old = cases.find((x) => x.id === c.id); const people = old ? casePeople(old).sort(byKTBC) : [];
    return `${bar(isNew ? 'Thêm vụ án' : 'Sửa vụ án', '<button data-act="cancel">Huỷ</button>', '<button class="strong" data-act="saveCase">Lưu</button>')}
    <main class="content nopad-bottom"><form id="cform" autocomplete="off">
      <div class="card">
        <button type="button" class="row" data-act="pickScan"><div class="main"><div class="name link">Quét quyết định khởi tố vụ án (ảnh, PDF)</div><div class="sub">Tự điền tên vụ án, số và ngày quyết định</div></div></button>
        ${SCAN_INPUT}
      </div>
      ${scanNote('Vụ án')}
      <h3 class="section-title">Vụ án</h3>
      <div class="card">
        ${sel('Cách đặt tên vụ án', 'tuDatSel', c.tuDat === false ? 'manual' : 'auto', { auto: 'Tự đặt: đối tượng chính + hành vi + phường', manual: 'Tự nhập tên' })}
        ${c.tuDat === false ? area('Tên vụ án *', 'ten', c.ten)
          : `<div class="field"><span>Tên vụ án (đặt lại khi lưu)</span><div style="padding:4px 0">${esc(conventionName(c, people) || c.ten || 'Chưa đủ thông tin: cần tội danh, bị can và địa bàn')}</div></div>`}
        ${inp('QĐ khởi tố vụ án số', 'soQDKTVA', c.soQDKTVA)}
        ${inp('Ngày khởi tố vụ án', 'ngayKTVA', c.ngayKTVA, 'date')}
        ${inp('Tội danh', 'toiDanh', c.toiDanh)}
        ${inp('Điều, khoản BLHS', 'dieuKhoan', c.dieuKhoan)}
        ${area('Địa bàn xảy ra', 'diaBan', c.diaBan)}
        ${people.length ? sel('Bị can đầu vụ', 'dauVu', people.some((r) => r.id === c.dauVu) ? c.dauVu : '', Object.assign({ '': 'Tự động: bị can bị khởi tố sớm nhất' }, Object.fromEntries(people.map((r) => [r.id, r.hoTen])))) : ''}
        ${inp('Điều tra viên thụ lý', 'dtv', c.dtv, 'text', 'autocapitalize="words"')}
      </div>
      ${people.length ? '' : '<p class="note">Chọn bị can đầu vụ sau khi đã thêm bị can vào vụ án.</p>'}
      <h3 class="section-title">Kết luận điều tra vụ án</h3>
      <div class="card">
        ${inp('Bản kết luận điều tra số', 'soKLDT', c.soKLDT)}
        ${inp('Ngày kết luận điều tra', 'ngayKLDT', c.ngayKLDT, 'date')}
      </div>
      <h3 class="section-title">Tạm đình chỉ, đình chỉ vụ án</h3>
      <div class="card">
        ${inp('Quyết định tạm đình chỉ số', 'soTDC', c.soTDC)}
        ${inp('Ngày tạm đình chỉ', 'ngayTDC', c.ngayTDC, 'date')}
        ${inp('Quyết định đình chỉ số', 'soDC', c.soDC)}
        ${inp('Ngày đình chỉ', 'ngayDC', c.ngayDC, 'date')}
      </div>
      <p class="note">Khi lưu, ngày kết luận, tạm đình chỉ, đình chỉ của vụ án được điền cho các bị can trong vụ chưa có các ngày này.</p>
      <h3 class="section-title">Ghi chú</h3>
      <div class="card">${area('Ghi chú', 'ghiChu', c.ghiChu)}</div>
      <button type="button" class="btn" data-act="saveCase">Lưu vụ án</button>
    </form></main>`;
  }
  function syncCaseDraft() {
    const form = $('#cform'); if (!form || !ui.cdraft) return;
    for (const [k, v] of new FormData(form).entries()) {
      if (k === 'tuDatSel') ui.cdraft.tuDat = v !== 'manual';
      else if (k in ui.cdraft) ui.cdraft[k] = String(v).trim();
    }
  }

  // ---------- Thống kê ----------
  const ST_FIELDS = [['vuAn', 'Vụ án'], ['dtv', 'Điều tra viên'], ['ksv', 'Kiểm sát viên'], ['toiDanh', 'Tội danh'], ['bienPhap', 'Biện pháp ngăn chặn'], ['giaiDoan', 'Giai đoạn']];
  function statsData() {
    const f = ui.st; const Y = f.nam ? Number(f.nam) : 0;
    const start = Y ? periodStart(Y) : ''; const end = Y ? periodStart(Y + 1) : '';
    const personFilter = ['dtv', 'ksv', 'toiDanh', 'bienPhap', 'giaiDoan'].some((k) => f[k]);
    const rs = records.filter((r) => ['dtv', 'ksv', 'toiDanh', 'bienPhap', 'giaiDoan'].every((k) => !f[k] || r[k] === f[k]) && (!f.vuAn || normName(r.vuAn) === normName(f.vuAn)));
    const byCase = new Map();
    for (const r of rs) { const k = normName(r.vuAn); if (!k) continue; if (!byCase.has(k)) byCase.set(k, []); byCase.get(k).push(r); }
    const cs = cases.filter((c) => (!f.vuAn || normName(c.ten) === normName(f.vuAn)) && (byCase.has(normName(c.ten)) || !personFilter)).map((c) => {
      const list = byCase.get(normName(c.ten)) || [];
      return { c, rs: list, kt: caseDate(c, list), kl: c.ngayKLDT || first(list, 'ngayKLDT'), st: caseStatus(c, list) };
    });
    const inY = (d) => !!d && d >= start && d < end;
    const stopped = (g) => g === 'dinhchi' || g === 'tamdinhchi';
    // Còn tồn ở đầu kỳ: tới ngày bắt đầu kỳ chưa đình chỉ / tạm đình chỉ, và chưa kết luận
    // (hoặc đã kết luận nhưng bị trả điều tra bổ sung chưa xong).
    const openAtStart = (r) => {
      if (r.ngayDC ? r.ngayDC < start : r.giaiDoan === 'dinhchi') return false;
      if (r.giaiDoan === 'tamdinhchi' && !(r.ngayTDC && r.ngayTDC >= start)) return false;
      return !(r.ngayKLDT && r.ngayKLDT < start && r.dtbs.every((b) => b.ngayKL && b.ngayKL < start));
    };
    const P = (fn) => rs.filter(fn); const C = (fn) => cs.filter(fn);
    const bsP = (fn) => P((r) => r.dtbs.some(fn)); const bsC = (fn) => C((x) => x.rs.some((r) => r.dtbs.some(fn)));
    // Vụ được tính đình chỉ / tạm đình chỉ trong kỳ khi vụ ghi ngày đó trong kỳ, hoặc mọi bị can của vụ đều đã dừng và có ngày trong kỳ.
    const stopC = (k, g) => C((x) => inY(x.c[k]) || (!x.c[k] && x.rs.length && x.rs.every((r) => r.giaiDoan === g) && x.rs.some((r) => inY(r[k]))));
    const d = { rs, cs, Y, start, end, rows: [] };
    const row = (label, c, p, cls = '') => d.rows.push({ label, c: c == null ? '' : c.length, p: p == null ? '' : p.length, cls });
    const dangDT = (g) => g === 'dieutra' || g === 'dtbs';
    const STAGES = ['dieutra', 'dtbs', 'ketluan', 'truyto', 'xetxu', 'tamdinhchi', 'dinhchi'];
    if (Y) {
      const tonP = P((r) => r.ngayKTBC && r.ngayKTBC < start && openAtStart(r));
      const tonC = C((x) => x.kt && x.kt < start && (x.rs.length ? x.rs.some(openAtStart)
        : !(x.kl && x.kl < start) && !(x.c.ngayDC && x.c.ngayDC < start) && !(x.c.ngayTDC && x.c.ngayTDC < start)));
      const moiP = P((r) => inY(r.ngayKTBC)); const moiC = C((x) => inY(x.kt));
      row(`Tồn cũ (khởi tố trước ${vn(start)})`, tonC, tonP, 'strong');
      for (const g of STAGES) {
        const pc = tonP.filter((r) => r.giaiDoan === g); const cc = tonC.filter((x) => x.st === g);
        if (pc.length || cc.length) row(`hiện ${GIAI_DOAN[g].toLowerCase()}`, cc, pc, 'sub');
      }
      row('Khởi tố mới trong kỳ', moiC, moiP, 'strong');
      for (const g of STAGES) {
        const pc = moiP.filter((r) => r.giaiDoan === g); const cc = moiC.filter((x) => x.st === g);
        if (pc.length || cc.length) row(`hiện ${GIAI_DOAN[g].toLowerCase()}`, cc, pc, 'sub');
      }
      row('Tổng thụ lý trong kỳ', [...tonC, ...moiC], [...tonP, ...moiP], 'strong');
      row('Kết luận điều tra trong kỳ', C((x) => inY(x.kl) || x.rs.some((r) => inY(r.ngayKLDT))), P((r) => inY(r.ngayKLDT)), 'strong');
      row('Tạm đình chỉ trong kỳ', stopC('ngayTDC', 'tamdinhchi'), P((r) => inY(r.ngayTDC)));
      row('Đình chỉ trong kỳ', stopC('ngayDC', 'dinhchi'), P((r) => inY(r.ngayDC)));
      row('Viện kiểm sát trả điều tra bổ sung', bsC((b) => b.gd !== 'toa' && inY(b.ngayTra)), bsP((b) => b.gd !== 'toa' && inY(b.ngayTra)));
      row('Toà án trả điều tra bổ sung', bsC((b) => b.gd === 'toa' && inY(b.ngayTra)), bsP((b) => b.gd === 'toa' && inY(b.ngayTra)));
      row('Kết luận điều tra bổ sung trong kỳ', bsC((b) => inY(b.ngayKL)), bsP((b) => inY(b.ngayKL)));
    } else {
      row('Tổng số', cs, rs, 'strong');
      row('Đã kết luận điều tra', C((x) => x.kl), P((r) => r.ngayKLDT), 'strong');
      row('Tạm đình chỉ', C((x) => x.st === 'tamdinhchi'), P((r) => r.giaiDoan === 'tamdinhchi'));
      row('Đình chỉ', C((x) => x.st === 'dinhchi'), P((r) => r.giaiDoan === 'dinhchi'));
    }
    row('Hiện đang điều tra', C((x) => dangDT(x.st)), P((r) => dangDT(r.giaiDoan)), 'strong');
    row('trong đó điều tra bổ sung', C((x) => x.st === 'dtbs'), P((r) => r.giaiDoan === 'dtbs'), 'sub');
    d.noDateP = P((r) => !r.ngayKTBC).length; d.noDateC = C((x) => !x.kt).length;
    d.noStopDate = P((r) => (r.giaiDoan === 'dinhchi' && !r.ngayDC) || (r.giaiDoan === 'tamdinhchi' && !r.ngayTDC)).length;
    return d;
  }
  function viewStats() {
    const f = ui.st; const d = statsData();
    const years = new Set([String(periodOf(today()))]);
    for (const r of records) for (const k of ['ngayKTBC', 'ngayKTVA', 'ngayKLDT', 'ngayDC', 'ngayTDC']) if (r[k]) years.add(String(periodOf(r[k])));
    for (const c of cases) for (const k of ['ngayKTVA', 'ngayKLDT', 'ngayDC', 'ngayTDC']) if (c[k]) years.add(String(periodOf(c[k])));
    if (f.nam) years.add(f.nam);
    const opt = (v, t, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`;
    const values = (k) => (k === 'vuAn' ? cases.map((c) => c.ten) : [...new Set(records.map((r) => r[k]).filter(Boolean))]).sort((a, b) => fold(a).localeCompare(fold(b)));
    const label = (k, v) => (k === 'bienPhap' ? BIEN_PHAP[v] : k === 'giaiDoan' ? GIAI_DOAN[v] : v) || v;
    const group = (title, fn) => {
      const m = new Map(); for (const r of d.rs) { const v = fn(r); if (v === null) continue; const k = v || '(chưa ghi)'; m.set(k, (m.get(k) || 0) + 1); }
      const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
      return rows.length ? `<h3 class="section-title">${title}</h3><div class="card">${rows.map(([k, n]) => `<div class="trow one"><span>${esc(k)}</span><b>${n}</b></div>`).join('')}</div>` : '';
    };
    const active = ST_FIELDS.some(([k]) => f[k]);
    return `${bar('Thống kê')}
    <main class="content">
      <div class="card">
        <label class="field"><span>Năm</span><select data-st="nam">${opt('', 'Tất cả các năm', f.nam)}${[...years].sort().reverse().map((y) => opt(y, fromJan() ? `Năm ${y}` : `Năm ${y} (${vn(periodStart(Number(y)))} – ${vn(addDays(periodStart(Number(y) + 1), -1))})`, f.nam)).join('')}</select></label>
        ${ST_FIELDS.map(([k, t]) => `<label class="field"><span>${t}</span><select data-st="${k}">${opt('', 'Tất cả', f[k])}${values(k).map((v) => opt(v, label(k, v), f[k])).join('')}</select></label>`).join('')}
      </div>
      ${active ? '<button class="btn plain" data-act="clearStats">Bỏ lọc</button>' : ''}
      <h3 class="section-title">${f.nam ? `Kỳ thống kê năm ${f.nam}: ${vn(d.start)} – ${vn(addDays(d.end, -1))}` : 'Số liệu tất cả các năm'}</h3>
      <div class="card">
        <div class="trow head"><span></span><b>Vụ</b><b>Bị can</b></div>
        ${d.rows.map((r) => `<div class="trow ${r.cls}"><span>${esc(r.label)}</span><b>${r.c}</b><b>${r.p}</b></div>`).join('')}
      </div>
      <p class="note">Vụ tính theo ngày khởi tố vụ án, bị can tính theo ngày khởi tố bị can. Mốc bắt đầu kỳ thống kê đổi được trong Cài đặt.${d.noDateP || d.noDateC ? ` Còn ${d.noDateC} vụ và ${d.noDateP} bị can chưa ghi ngày khởi tố nên chưa được tính vào tồn cũ / khởi tố mới.` : ''}${d.noStopDate ? ` Có ${d.noStopDate} bị can đình chỉ, tạm đình chỉ chưa ghi ngày quyết định nên không tính vào tồn cũ.` : ''}</p>
      ${group('Bị can theo giai đoạn', (r) => GIAI_DOAN[r.giaiDoan])}
      ${group('Điều tra bổ sung theo lần và cơ quan trả', (r) => (r.giaiDoan === 'dtbs' && r.dtbs.length ? `Lần ${r.dtbs.length} — ${CO_QUAN_TRA[r.dtbs[r.dtbs.length - 1].gd] || CO_QUAN_TRA.vks}` : null))}
      ${group('Bị can theo biện pháp ngăn chặn', (r) => BIEN_PHAP[r.bienPhap])}
      ${group('Bị can theo tội danh', (r) => r.toiDanh)}
      ${group('Bị can theo điều tra viên', (r) => r.dtv)}
    </main>`;
  }

  function viewSettings() {
    return `${bar('Cài đặt')}
    <main class="content">
      <h3 class="section-title">Cảnh báo</h3>
      <div class="card"><label class="field"><span>Cảnh báo trước khi hết hạn tạm giữ, tạm giam (ngày)</span>
        <input id="alertDays" type="number" inputmode="numeric" min="1" max="60" value="${settings.alertDays}"></label></div>

      <h3 class="section-title">Kỳ thống kê</h3>
      <div class="card"><div class="term"><span style="flex:1;color:var(--text);font-size:16px">Kỳ năm bắt đầu từ ngày</span>
        <input id="statDay" type="number" inputmode="numeric" min="1" max="31" value="${settings.statDay}" data-k="ngay" aria-label="Ngày"><span>/</span>
        <input id="statMonth" type="number" inputmode="numeric" min="1" max="12" value="${settings.statMonth}" data-k="ngay" aria-label="Tháng"></div></div>
      <p class="note">Ví dụ 15/11: năm ${periodOf(today())} tính từ ${vn(periodStart(periodOf(today())))} đến ${vn(addDays(periodStart(periodOf(today()) + 1), -1))}; án khởi tố trước ngày ${vn(periodStart(periodOf(today())))} chưa giải quyết xong là tồn cũ.</p>

      <h3 class="section-title">Bảng thời hạn (loại → số ngày)</h3>
      <div class="card">
        ${(settings.terms || []).map((t, i) => `<div class="term"><input data-term="${i}" data-k="ten" value="${esc(t.ten)}" placeholder="Tên loại thời hạn" autocomplete="off"><input data-term="${i}" data-k="ngay" type="number" inputmode="numeric" min="1" value="${esc(t.ngay)}" aria-label="Số ngày"><span>ngày</span><button data-act="delTerm" data-i="${i}" aria-label="Xoá">✕</button></div>`).join('')}
        <button class="row" data-act="addTerm"><div class="main"><div class="name link">+ Thêm loại thời hạn</div></div></button>
        <button class="row" data-act="resetTerms"><div class="main"><div class="name link">Đặt lại mặc định</div></div></button>
      </div>
      <p class="note">Đến ngày = từ ngày + số ngày − 1 (tính cả ngày bắt đầu). Sửa bảng không làm thay đổi các hồ sơ đã lưu.</p>

      <h3 class="section-title">Sao lưu</h3>
      <div class="card">
        <button class="row" data-act="backup"><div class="main"><div class="name link">Xuất bản sao lưu (đã mã hoá)</div><div class="sub">Lưu vào Tệp / iCloud Drive để phòng mất máy</div></div></button>
        <button class="row" data-act="restore"><div class="main"><div class="name link">Khôi phục từ bản sao lưu</div><div class="sub">Gộp vào dữ liệu hiện có, cần mật khẩu của bản sao lưu</div></div></button>
        <button class="row" data-act="csv"><div class="main"><div class="name link">Xuất danh sách ra Excel (CSV)</div><div class="sub">Tệp không mã hoá — cân nhắc trước khi chia sẻ</div></div></button>
      </div>
      <input id="restoreFile" type="file" accept=".qlbc,.json,application/json" hidden>

      <h3 class="section-title">Bảo mật</h3>
      <div class="card">
        <button class="row" data-act="passPage"><div class="main"><div class="name link">Đổi mật khẩu</div></div><span class="chev">›</span></button>
        <button class="row" data-act="lock"><div class="main"><div class="name link">Khoá ứng dụng ngay</div></div></button>
        <button class="row" data-act="wipe"><div class="main"><div class="name link danger">Xoá toàn bộ dữ liệu</div></div></button>
      </div>
      <p class="note">Dữ liệu chỉ lưu trên máy này và được mã hoá bằng mật khẩu. Ứng dụng tự khoá sau 1 phút rời khỏi màn hình. Quên mật khẩu sẽ không thể khôi phục dữ liệu.</p>
      <p class="note">${records.length} hồ sơ · phiên bản ${APP_VERSION}</p>
      <button class="btn plain" data-act="update">Kiểm tra bản cập nhật</button>
    </main>`;
  }

  // ---------- Giao diện: chi tiết ----------
  function kv(k, v) { return v ? `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>` : ''; }
  function block(title, rows) {
    const body = rows.join('');
    return body ? `<h3 class="section-title">${esc(title)}</h3><div class="card">${body}</div>` : '';
  }
  function viewDetail(id) {
    const r = records.find((x) => x.id === id);
    if (!r) { ui.page = null; return viewTab(); }
    const d = dlInfo(r);
    const so = (label, num, date) => [num ? `số ${num}` : '', date ? `ngày ${vn(date)}` : ''].filter(Boolean).join(', ');
    return `${bar('Hồ sơ bị can', '<button data-act="back">‹ Quay lại</button>', `<button class="strong" data-act="edit" data-id="${esc(r.id)}">Sửa</button>`)}
    <main class="content nopad-bottom">
      <div class="card hero">${avatar(r, true)}<h2>${esc(r.hoTen)}</h2>
        <div class="tags">${bpTag(r)}<span class="tag">${esc(GIAI_DOAN[r.giaiDoan] || '')}</span></div></div>
      ${d ? `<div class="deadline ${d.level}" style="margin-top:10px">${esc(d.text)} — hạn ${BIEN_PHAP[r.bienPhap].toLowerCase()} đến ${vn(d.date)}<small>${r.noiGiam ? 'Nơi giam giữ: ' + esc(r.noiGiam) : ''}</small></div>` : ''}
      ${block('Lý lịch', [
        kv('Tên gọi khác', r.tenKhac), kv('Giới tính', r.gioiTinh), kv('Ngày sinh', vn(r.ngaySinh)),
        kv('Số CCCD', r.cccd), kv('Quốc tịch', r.quocTich), kv('Dân tộc', r.danToc), kv('Nghề nghiệp', r.ngheNghiep),
        kv('Nơi thường trú', r.hktt), kv('Chỗ ở hiện nay', r.choO), kv('Tiền án, tiền sự', r.tienAn),
      ])}
      ${block('Vụ án & tội danh', [
        kv('Vụ án', r.vuAn), kv('QĐ khởi tố vụ án', so('', r.soQDKTVA, r.ngayKTVA)),
        kv('Tội danh', r.toiDanh), kv('Điều khoản BLHS', r.dieuKhoan),
        kv('QĐ khởi tố bị can', so('', r.soQDKTBC, r.ngayKTBC)), kv('Giai đoạn', GIAI_DOAN[r.giaiDoan]),
      ])}
      ${block('Biện pháp ngăn chặn', [
        kv('Biện pháp', BIEN_PHAP[r.bienPhap]), kv('Ngày bắt / tạm giữ', vn(r.ngayBat)), kv('Nơi giam giữ', r.noiGiam),
        kv('Lệnh / quyết định số', r.soLenh),
        kv('Loại thời hạn', r.loaiHan),
        kv('Thời hạn', r.tgTu || r.tgDen ? `${vn(r.tgTu) || '…'} → ${vn(r.tgDen) || '…'}` : ''),
        ...(r.giaHan || []).map((g, i) => kv(`Gia hạn lần ${i + 1}`, `${g.so ? 'Số ' + g.so + '\n' : ''}${g.loai ? g.loai + '\n' : ''}${vn(g.tu) || '…'} → ${vn(g.den) || '…'}`)),
      ])}
      ${block('Kết luận điều tra', [
        kv('Bản kết luận điều tra', so('', r.soKLDT, r.ngayKLDT)),
        ...(r.dtbs || []).map((b, i) => kv(`Điều tra bổ sung lần ${i + 1}`, `${CO_QUAN_TRA[b.gd] || CO_QUAN_TRA.vks}${b.ngayTra ? ' ngày ' + vn(b.ngayTra) : ''}\n${b.ngayKL || b.so ? 'Kết luận bổ sung ' + so('', b.so, b.ngayKL) : 'Chưa kết luận bổ sung'}`)),
      ])}
      ${block('Tạm đình chỉ, đình chỉ', [kv('Tạm đình chỉ', so('', r.soTDC, r.ngayTDC)), kv('Đình chỉ', so('', r.soDC, r.ngayDC))])}
      ${block('Thụ lý', [kv('Điều tra viên', r.dtv), kv('Kiểm sát viên', r.ksv)])}
      ${block('Ghi chú', [r.ghiChu ? `<div class="pad" style="white-space:pre-wrap">${esc(r.ghiChu)}</div>` : ''])}
      <button class="btn danger" data-act="delete" data-id="${esc(r.id)}">Xoá hồ sơ này</button>
      <p class="note" style="text-align:center">Cập nhật lần cuối: ${esc(new Date(r.updatedAt).toLocaleString('vi-VN'))}</p>
    </main>`;
  }

  // ---------- Giao diện: biểu mẫu ----------
  function blank() {
    return { id: uid(), hoTen: '', tenKhac: '', gioiTinh: 'Nam', ngaySinh: '', cccd: '', quocTich: 'Việt Nam', danToc: 'Kinh', ngheNghiep: '', hktt: '', choO: '', tienAn: '', anh: '',
      vuAn: '', soQDKTVA: '', ngayKTVA: '', toiDanh: '', dieuKhoan: '', soQDKTBC: '', ngayKTBC: '', giaiDoan: 'dieutra',
      bienPhap: 'tamgiam', ngayBat: '', noiGiam: '', soLenh: '', loaiHan: '', tgTu: '', tgDen: '', giaHan: [], soKLDT: '', ngayKLDT: '', dtbs: [], soTDC: '', ngayTDC: '', soDC: '', ngayDC: '', dtv: '', ksv: '', ghiChu: '', createdAt: Date.now(), updatedAt: Date.now() };
  }
  function inp(label, name, v, type = 'text', extra = '') {
    return `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(v)}" autocomplete="off" ${extra}></label>`;
  }
  function sel(label, name, v, opts) {
    return `<label class="field"><span>${esc(label)}</span><select name="${name}">${Object.entries(opts).map(([k, t]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  }
  function area(label, name, v) {
    return `<label class="field"><span>${esc(label)}</span><textarea name="${name}" rows="2">${esc(v)}</textarea></label>`;
  }
  function viewForm() {
    const r = ui.draft;
    const isNew = !records.some((x) => x.id === r.id);
    const caseNames = [...new Set(records.map((x) => (x.vuAn || '').trim()).filter(Boolean))];
    return `${bar(isNew ? 'Thêm bị can' : 'Sửa hồ sơ', '<button data-act="cancel">Huỷ</button>', '<button class="strong" data-act="save">Lưu</button>')}
    <main class="content nopad-bottom"><form id="form" autocomplete="off">
      <div class="card">
        <div class="photo-edit">${avatar(r, true)}<div class="btns">
          <button type="button" class="link" data-act="pickPhoto">${r.anh ? 'Đổi ảnh' : 'Thêm ảnh'}</button>
          ${r.anh ? '<button type="button" class="link danger" data-act="dropPhoto">Xoá ảnh</button>' : ''}
        </div></div>
        <input id="photoFile" type="file" accept="image/*" hidden>
      </div>
      <div class="card" style="margin-top:10px">
        <button type="button" class="row" data-act="pickScan"><div class="main"><div class="name link">Quét văn bản để tự điền (ảnh, PDF)</div><div class="sub">Quyết định khởi tố, lệnh tạm giam… Đọc chữ ngay trên máy</div></div></button>
        <input id="scanFile" type="file" accept="image/*,application/pdf,.pdf" multiple hidden>
      </div>
      ${scanNote('Bị can')}
      <h3 class="section-title">Lý lịch</h3>
      <div class="card">
        ${inp('Họ và tên *', 'hoTen', r.hoTen, 'text', 'autocapitalize="words" required')}
        ${inp('Tên gọi khác', 'tenKhac', r.tenKhac)}
        ${sel('Giới tính', 'gioiTinh', r.gioiTinh, { Nam: 'Nam', 'Nữ': 'Nữ' })}
        ${inp('Ngày sinh', 'ngaySinh', r.ngaySinh, 'date')}
        ${inp('Số CCCD', 'cccd', r.cccd, 'text', 'inputmode="numeric"')}
        ${inp('Quốc tịch', 'quocTich', r.quocTich)}
        ${inp('Dân tộc', 'danToc', r.danToc)}
        ${inp('Nghề nghiệp', 'ngheNghiep', r.ngheNghiep)}
        ${area('Nơi thường trú', 'hktt', r.hktt)}
        ${area('Chỗ ở hiện nay', 'choO', r.choO)}
        ${area('Tiền án, tiền sự', 'tienAn', r.tienAn)}
      </div>
      <h3 class="section-title">Vụ án & tội danh</h3>
      <div class="card">
        ${inp('Tên vụ án', 'vuAn', r.vuAn, 'text', 'list="caseNames"')}
        <datalist id="caseNames">${caseNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        ${inp('QĐ khởi tố vụ án số', 'soQDKTVA', r.soQDKTVA)}
        ${inp('Ngày khởi tố vụ án', 'ngayKTVA', r.ngayKTVA, 'date')}
        ${inp('Tội danh', 'toiDanh', r.toiDanh)}
        ${inp('Điều, khoản BLHS', 'dieuKhoan', r.dieuKhoan)}
        ${inp('QĐ khởi tố bị can số', 'soQDKTBC', r.soQDKTBC)}
        ${inp('Ngày khởi tố bị can', 'ngayKTBC', r.ngayKTBC, 'date')}
        ${sel('Giai đoạn tố tụng', 'giaiDoan', r.giaiDoan, GIAI_DOAN)}
      </div>
      <h3 class="section-title">Biện pháp ngăn chặn</h3>
      <div class="card">
        ${sel('Biện pháp', 'bienPhap', r.bienPhap, BIEN_PHAP)}
        ${inp('Ngày bắt / tạm giữ', 'ngayBat', r.ngayBat, 'date')}
        ${inp('Nơi giam giữ', 'noiGiam', r.noiGiam)}
        ${inp('Lệnh / quyết định số', 'soLenh', r.soLenh)}
        ${sel('Loại thời hạn', 'loaiHan', r.loaiHan || '', termOpts(r.loaiHan))}
        ${inp('Thời hạn từ ngày', 'tgTu', r.tgTu, 'date')}
        ${inp('Đến ngày', 'tgDen', r.tgDen, 'date')}
        <div class="quick">Chọn loại thời hạn thì "đến ngày" tự tính = từ ngày + số ngày − 1. Bảng số ngày sửa trong Cài đặt.</div>
      </div>
      <h3 class="section-title">Gia hạn tạm giam</h3>
      <div class="card">
        ${(r.giaHan || []).map((g, i) => `<div class="ext">
          <div class="ext-head"><span>Gia hạn lần ${i + 1}</span><button type="button" data-act="delExt" data-i="${i}">Xoá</button></div>
          ${inp('Lệnh / quyết định số', `gh${i}_so`, g.so)}
          ${sel('Loại thời hạn', `gh${i}_loai`, g.loai || '', termOpts(g.loai))}
          ${inp('Từ ngày', `gh${i}_tu`, g.tu, 'date')}
          ${inp('Đến ngày', `gh${i}_den`, g.den, 'date')}
        </div>`).join('')}
        <button type="button" class="row" data-act="addExt"><div class="main"><div class="name link">+ Thêm lần gia hạn</div></div></button>
      </div>
      <h3 class="section-title">Kết luận điều tra</h3>
      <div class="card">
        ${inp('Bản kết luận điều tra số', 'soKLDT', r.soKLDT)}
        ${inp('Ngày kết luận điều tra', 'ngayKLDT', r.ngayKLDT, 'date')}
      </div>
      <h3 class="section-title">Điều tra bổ sung</h3>
      <div class="card">
        ${(r.dtbs || []).map((b, i) => `<div class="ext">
          <div class="ext-head"><span>Điều tra bổ sung lần ${i + 1}</span><button type="button" data-act="delBs" data-i="${i}">Xoá</button></div>
          ${sel('Cơ quan trả hồ sơ', `bs${i}_gd`, b.gd || 'vks', { vks: 'Viện kiểm sát', toa: 'Toà án' })}
          ${inp('Ngày trả hồ sơ', `bs${i}_ngayTra`, b.ngayTra, 'date')}
          ${inp('Bản kết luận điều tra bổ sung số', `bs${i}_so`, b.so)}
          ${inp('Ngày kết luận điều tra bổ sung', `bs${i}_ngayKL`, b.ngayKL, 'date')}
        </div>`).join('')}
        <button type="button" class="row" data-act="addBs"><div class="main"><div class="name link">+ Thêm lần điều tra bổ sung</div></div></button>
      </div>
      <h3 class="section-title">Tạm đình chỉ, đình chỉ</h3>
      <div class="card">
        ${inp('Quyết định tạm đình chỉ số', 'soTDC', r.soTDC)}
        ${inp('Ngày tạm đình chỉ', 'ngayTDC', r.ngayTDC, 'date')}
        ${inp('Quyết định đình chỉ số', 'soDC', r.soDC)}
        ${inp('Ngày đình chỉ', 'ngayDC', r.ngayDC, 'date')}
      </div>
      <p class="note">Khi lưu, giai đoạn tự chuyển theo các ngày vừa ghi: điều tra bổ sung (lần trả hồ sơ gần nhất chưa kết luận bổ sung), đã kết luận điều tra, tạm đình chỉ, đình chỉ. Khi phục hồi điều tra, chọn lại giai đoạn "Đang điều tra".</p>
      <h3 class="section-title">Thụ lý & ghi chú</h3>
      <div class="card">
        ${inp('Điều tra viên thụ lý', 'dtv', r.dtv, 'text', 'autocapitalize="words"')}
        ${inp('Kiểm sát viên', 'ksv', r.ksv, 'text', 'autocapitalize="words"')}
        ${area('Ghi chú', 'ghiChu', r.ghiChu)}
      </div>
      <button type="button" class="btn" data-act="save">Lưu hồ sơ</button>
    </form></main>`;
  }
  function syncDraft() {
    const form = $('#form'); if (!form || !ui.draft) return;
    const fd = new FormData(form); const r = ui.draft;
    for (const [k, v] of fd.entries()) {
      const m = /^gh(\d+)_(so|loai|tu|den)$/.exec(k); const b = /^bs(\d+)_(gd|ngayTra|so|ngayKL)$/.exec(k);
      if (m) { if (r.giaHan[+m[1]]) r.giaHan[+m[1]][m[2]] = String(v).trim(); }
      else if (b) { if (r.dtbs[+b[1]]) r.dtbs[+b[1]][b[2]] = String(v).trim(); }
      else if (k in r) r[k] = String(v).trim();
    }
  }

  function viewPass() {
    return `${bar('Đổi mật khẩu', '<button data-act="back">‹ Quay lại</button>')}
    <main class="content nopad-bottom"><form id="passForm">
      <div class="card">
        ${inp('Mật khẩu hiện tại', 'cur', '', 'password')}
        ${inp('Mật khẩu mới (ít nhất 6 ký tự)', 'p1', '', 'password')}
        ${inp('Nhập lại mật khẩu mới', 'p2', '', 'password')}
      </div>
      <button type="submit" class="btn">Đổi mật khẩu</button>
      <p class="note">Bản sao lưu đã xuất trước đó vẫn dùng mật khẩu cũ.</p>
    </form></main>`;
  }

  // ---------- Quét văn bản ----------
  const FIELD_NAMES = { hoTen: 'Họ tên', tenKhac: 'Tên gọi khác', gioiTinh: 'Giới tính', ngaySinh: 'Ngày sinh', cccd: 'CCCD', quocTich: 'Quốc tịch', danToc: 'Dân tộc',
    ngheNghiep: 'Nghề nghiệp', hktt: 'Nơi thường trú', choO: 'Chỗ ở', tienAn: 'Tiền án, tiền sự', vuAn: 'Vụ án', soQDKTVA: 'Số QĐ khởi tố vụ án', ngayKTVA: 'Ngày khởi tố vụ án',
    toiDanh: 'Tội danh', dieuKhoan: 'Điều khoản', soQDKTBC: 'Số QĐ khởi tố bị can', ngayKTBC: 'Ngày khởi tố bị can', bienPhap: 'Biện pháp ngăn chặn', ngayBat: 'Ngày bắt',
    noiGiam: 'Nơi giam giữ', soLenh: 'Số lệnh', tgTu: 'Từ ngày', tgDen: 'Đến ngày', giaHan: 'Gia hạn', soKLDT: 'Số kết luận điều tra', ngayKLDT: 'Ngày kết luận điều tra', dtbs: 'Kết luận điều tra bổ sung', soTDC: 'Số QĐ tạm đình chỉ', ngayTDC: 'Ngày tạm đình chỉ', soDC: 'Số QĐ đình chỉ', ngayDC: 'Ngày đình chỉ', dtv: 'Điều tra viên', ksv: 'Kiểm sát viên' };
  const ALWAYS_SET = ['bienPhap', 'gioiTinh', 'quocTich', 'danToc'];
  // Điền kết quả quét vào hồ sơ: không ghi đè ô người dùng đã nhập. Trả về tên các mục đã điền.
  function applyScan(r, got) {
    const filled = [];
    for (const [k, v] of Object.entries(got)) {
      if (!(k in FIELD_NAMES)) continue;
      if (k === 'giaHan') { r.giaHan.push(...v.map((g) => ({ so: g.so || '', loai: '', tu: g.tu || '', den: g.den || '' }))); filled.push(FIELD_NAMES[k]); continue; }
      if (k === 'dtbs') {
        // Bản kết luận bổ sung: điền vào lần trả hồ sơ đang chờ kết luận, nếu không có thì thêm lần mới.
        const last = r.dtbs[r.dtbs.length - 1];
        for (const b of v) { if (last && !last.ngayKL && !last.so) { last.so = b.so || ''; last.ngayKL = b.ngayKL || ''; } else r.dtbs.push({ gd: 'vks', ngayTra: '', so: b.so || '', ngayKL: b.ngayKL || '' }); }
        filled.push(FIELD_NAMES[k]); continue;
      }
      if (r[k] === v) continue;
      if (!r[k] || ALWAYS_SET.includes(k)) { r[k] = v; filled.push(FIELD_NAMES[k]); }
    }
    return filled;
  }
  const CASE_FIELDS = { ten: ['vuAn', 'Tên vụ án'], soQDKTVA: ['soQDKTVA', 'Số QĐ khởi tố vụ án'], ngayKTVA: ['ngayKTVA', 'Ngày khởi tố vụ án'], toiDanh: ['toiDanh', 'Tội danh'],
    dieuKhoan: ['dieuKhoan', 'Điều khoản'], diaBan: ['diaBan', 'Địa bàn xảy ra'], dtv: ['dtv', 'Điều tra viên'], soKLDT: ['soKLDT', 'Số kết luận điều tra'], ngayKLDT: ['ngayKLDT', 'Ngày kết luận điều tra'],
    soTDC: ['soTDC', 'Số QĐ tạm đình chỉ'], ngayTDC: ['ngayTDC', 'Ngày tạm đình chỉ'], soDC: ['soDC', 'Số QĐ đình chỉ'], ngayDC: ['ngayDC', 'Ngày đình chỉ'] };
  function applyCaseScan(c, got) {
    const filled = [];
    for (const [k, [from, label]] of Object.entries(CASE_FIELDS)) {
      if (k === 'ten' && c.tuDat !== false) continue;   // tên vụ do app ghép theo quy ước
      if (!c[k] && got[from]) { c[k] = got[from]; filled.push(label); }
    }
    return filled;
  }
  function busy_(msg) {
    let el = $('#busy');
    if (msg == null) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'busy'; el.innerHTML = '<div><div class="spin"></div><p></p></div>'; document.body.appendChild(el); }
    $('p', el).textContent = msg;
  }
  async function runScan(files) {
    busy_('Đang chuẩn bị…');
    let res;
    let docs;
    try { docs = await Scan.readDocs(files, busy_); } finally { busy_(null); Scan.dispose(); }
    if (!key) return; // app đã tự khoá trong lúc quét
    const type = ui.page && ui.page.type;
    // Nhiều văn bản cùng lúc (ngoài biểu mẫu): đọc từng văn bản, tự phân loại và lưu.
    if (docs.length > 1 && type !== 'form' && type !== 'caseForm') { await batchImport(docs); return; }
    res = Scan.parse(docs.map((d) => d.text).join('\n'));
    const inForm = type === 'form'; const inCaseForm = type === 'caseForm';
    const fromCases = type === 'case' || (!ui.page && ui.tab === 'cases');
    const named = res.persons.filter((p) => p.hoTen);
    const done = (n) => toast(n ? `Đã tự điền ${n} mục — hãy kiểm tra lại` : 'Không dò được thông tin từ văn bản');

    // Văn bản về vụ án (quyết định khởi tố vụ án…): điền vào vụ án, không tạo bị can.
    if (inCaseForm || (!inForm && (fromCases || (res.type === 'ktva' && !named.length)))) {
      const got = res.common || {}; let existed = false;
      if (inCaseForm) syncCaseDraft();
      else {
        const ex = caseBySo(got.soQDKTVA, got.ngayKTVA) || caseByName(got.vuAn);
        existed = !!ex; ui.cdraft = ex ? normCase(clone(ex)) : blankCase(); ui.page = { type: 'caseForm', from: ui.page };
      }
      ui.scan = { filled: applyCaseScan(ui.cdraft, got), text: res.text, existed };
      render(); done(ui.scan.filled.length); return;
    }

    if (named.length > 1 && !(inForm && records.some((x) => x.id === ui.draft.id))) {
      ui.draft = null;
      ui.page = { type: 'scanReview', persons: named.map((p) => ({ on: true, got: p })), text: res.text, from: null };
      render(); return;
    }
    const got = named[0] || res.persons[0] || {}; let existed = false;
    if (inForm) syncDraft();
    else {
      // Bị can đã có hồ sơ thì bổ sung vào hồ sơ cũ thay vì tạo hồ sơ trùng.
      const ex = findExisting(got);
      existed = !!ex; ui.draft = ex ? normalize(clone(ex)) : blank(); ui.page = { type: 'form', from: ui.page };
    }
    const filled = applyScan(ui.draft, got); linkCase(ui.draft);
    ui.scan = { filled, text: res.text, existed };
    render(); done(filled.length);
  }
  // Đọc nhiều văn bản một lượt: quyết định khởi tố vụ án → vụ án; văn bản về bị can → hồ sơ bị can, gắn vào vụ.
  async function batchImport(docs) {
    const parsed = docs.map((d) => ({ d, res: Scan.parse(d.text) }));
    const isCaseDoc = (res) => res.type === 'ktva' && !res.persons.some((p) => p.hoTen);
    const log = []; const batchCases = [];
    for (const { d, res } of parsed.filter((x) => isCaseDoc(x.res))) {
      const got = res.common || {};
      const ex = caseBySo(got.soQDKTVA, got.ngayKTVA);
      const c = ex ? normCase(clone(ex)) : blankCase();
      const filled = applyCaseScan(c, got);
      if (!c.ten) c.ten = uniqueName(conventionName(c, []) || got.vuAn || `Vụ án theo QĐ ${c.soQDKTVA || '(chưa rõ số)'}`, c);
      c.updatedAt = Date.now(); await putCase(c);
      if (!batchCases.some((x) => x.id === c.id)) batchCases.push(c);
      log.push({ kind: 'case', id: c.id, file: d.name, isNew: !ex, filled });
    }
    for (const { d, res } of parsed.filter((x) => !isCaseDoc(x.res))) {
      const named = res.persons.filter((p) => p.hoTen);
      if (!named.length) { log.push({ kind: 'none', file: d.name }); continue; }
      for (const got of named) {
        const ex = findExisting(got);
        const r = ex ? normalize(clone(ex)) : blank();
        const filled = applyScan(r, got); linkCase(r);
        // Chỉ có một vụ án trong lượt này thì bị can chưa rõ vụ được gắn vào vụ đó.
        if (!normName(r.vuAn) && batchCases.length === 1) { r.vuAn = batchCases[0].ten; linkCase(r); }
        stageFromStop(r, ex); autoStage(r); r.updatedAt = Date.now();
        await putRecord(r); await ensureCase(r.vuAn, r);
        const old = log.find((x) => x.kind === 'person' && x.id === r.id);
        if (old) old.filled = [...new Set([...old.filled, ...filled])]; else log.push({ kind: 'person', id: r.id, file: d.name, isNew: !ex, filled });
      }
    }
    await refreshAllCases();
    ui.draft = null; ui.cdraft = null; ui.scan = null;
    ui.page = { type: 'batch', log, docs: docs.map((d) => ({ name: d.name, text: d.text })), from: null };
    render(); toast('Đã đọc xong — hãy mở từng mục để kiểm tra');
  }
  function viewBatch() {
    const pg = ui.page;
    const row = (it) => {
      if (it.kind === 'none') return `<div class="row"><div class="main"><div class="name">Không dò được thông tin</div><div class="sub">${esc(it.file)}</div></div></div>`;
      const c = it.kind === 'case' ? cases.find((x) => x.id === it.id) : null; const r = it.kind === 'person' ? records.find((x) => x.id === it.id) : null;
      if (!c && !r) return '';
      const vu = r && caseByName(r.vuAn);
      return `<button class="row" data-act="openItem" data-kind="${it.kind}" data-id="${esc(it.id)}"><div class="main">
        <div class="name" style="white-space:normal">${esc(c ? c.ten : r.hoTen)}</div>
        <div class="sub" style="white-space:normal">${esc(c ? 'Vụ án' : 'Bị can')} · ${it.isNew ? 'tạo mới' : 'bổ sung vào hồ sơ đã có'} · điền ${it.filled.length} mục${r ? (vu ? ' · thuộc vụ: ' + esc(vu.ten) : ' · CHƯA GẮN VỤ ÁN') : ''}</div>
        <div class="sub">${esc(it.file)}</div></div><span class="chev">›</span></button>`;
    };
    const cs = pg.log.filter((x) => x.kind === 'case'); const ps = pg.log.filter((x) => x.kind === 'person'); const no = pg.log.filter((x) => x.kind === 'none');
    return `${bar('Kết quả đọc văn bản', '', '<button class="strong" data-act="back">Xong</button>')}
    <main class="content nopad-bottom">
      <div class="card pad scan-note"><b>Đã đọc ${pg.docs.length} văn bản: ${cs.length} vụ án, ${ps.length} bị can${no.length ? `, ${no.length} văn bản không dò được` : ''}.</b>
        <p>Thông tin đã được lưu. Hãy mở từng mục để đối chiếu với văn bản gốc và sửa chỗ đọc sai.</p></div>
      ${cs.length ? `<h3 class="section-title">Vụ án</h3><div class="card">${cs.map(row).join('')}</div>` : ''}
      ${ps.length ? `<h3 class="section-title">Bị can</h3><div class="card">${ps.map(row).join('')}</div>` : ''}
      ${no.length ? `<h3 class="section-title">Chưa dò được</h3><div class="card">${no.map(row).join('')}</div>` : ''}
      <h3 class="section-title">Chữ đọc được từ từng văn bản</h3>
      <div class="card pad scan-note" style="background:var(--card)">${pg.docs.map((d) => `<details><summary>${esc(d.name)}</summary><pre>${esc(d.text)}</pre></details>`).join('')}</div>
    </main>`;
  }
  function viewAttach() {
    const pg = ui.page; const c = cases.find((x) => x.id === pg.id); const n = pg.items.filter((x) => x.on).length;
    return `${bar('Gắn bị can vào vụ', '<button data-act="back">Huỷ</button>')}
    <main class="content nopad-bottom">
      <p class="note" style="margin-bottom:8px">Chọn các bị can thuộc vụ: ${esc(c ? c.ten : '')}</p>
      <div class="card">${pg.items.map((it, i) => { const r = records.find((x) => x.id === it.id); return r ? `<button class="row" data-act="attachToggle" data-i="${i}">
        <span class="check ${it.on ? 'on' : ''}">${it.on ? '✓' : ''}</span><div class="main"><div class="name">${esc(r.hoTen)}</div>
        <div class="sub" style="white-space:normal">${esc([r.ngaySinh ? 'Sinh ' + vn(r.ngaySinh) : '', r.toiDanh, r.ngayKTBC ? 'Khởi tố ' + vn(r.ngayKTBC) : ''].filter(Boolean).join(' · '))}</div></div></button>` : ''; }).join('')}</div>
      <button class="btn" data-act="attachSave" ${n ? '' : 'disabled'}>Gắn ${n} bị can</button>
    </main>`;
  }
  function viewScanReview() {
    const pg = ui.page; const n = pg.persons.filter((p) => p.on).length;
    return `${bar('Kết quả quét', '<button data-act="back">Huỷ</button>')}
    <main class="content nopad-bottom">
      <div class="card pad scan-note"><b>Tìm thấy ${pg.persons.length} bị can trong văn bản.</b><p>Bỏ chọn người không cần lưu. Người đã có hồ sơ sẽ được bổ sung thông tin, không tạo hồ sơ trùng. Sau khi lưu, mở từng hồ sơ để kiểm tra lại.</p>
        <details><summary>Xem chữ đọc được</summary><pre>${esc(pg.text)}</pre></details></div>
      <div class="card" style="margin-top:10px">${pg.persons.map((p, i) => `<button class="row" data-act="scanToggle" data-i="${i}">
        <span class="check ${p.on ? 'on' : ''}">${p.on ? '✓' : ''}</span>
        <div class="main"><div class="name">${esc(p.got.hoTen || '(chưa đọc được họ tên)')} ${findExisting(p.got) ? '<span class="tag orange">Đã có hồ sơ</span>' : ''}</div>
        <div class="sub" style="white-space:normal">${esc([p.got.ngaySinh ? 'Sinh ' + vn(p.got.ngaySinh) : '', p.got.cccd ? 'CCCD ' + p.got.cccd : '', p.got.toiDanh, p.got.hktt].filter(Boolean).join(' · '))}</div></div></button>`).join('')}</div>
      <button class="btn" data-act="scanSave" ${n ? '' : 'disabled'}>Lưu ${n} hồ sơ</button>
    </main>`;
  }

  // ---------- Giao diện: khoá ----------
  function viewLock() {
    const head = '<img src="icons/icon-192.png" alt=""><h1>Quản lý bị can</h1>';
    if (!window.isSecureContext || !crypto.subtle) {
      return `<div class="lock">${head}<p class="warn">Ứng dụng cần được mở qua địa chỉ HTTPS để mã hoá dữ liệu.</p></div>`;
    }
    if (!auth) {
      return `<form class="lock" id="setupForm">${head}
        <p>Đặt mật khẩu để mã hoá toàn bộ dữ liệu trên máy này.</p>
        <input name="p1" type="password" placeholder="Mật khẩu (ít nhất 6 ký tự)" autocomplete="new-password">
        <input name="p2" type="password" placeholder="Nhập lại mật khẩu" autocomplete="new-password">
        <p class="warn">Quên mật khẩu sẽ không thể khôi phục dữ liệu. Hãy ghi nhớ và xuất bản sao lưu định kỳ.</p>
        <button class="btn" type="submit">Bắt đầu</button>
        <div class="err">${esc(ui.lockErr)}</div></form>`;
    }
    return `<form class="lock" id="unlockForm">${head}
      <p>Nhập mật khẩu để mở khoá.</p>
      <input name="p" type="password" placeholder="Mật khẩu" autocomplete="current-password" autofocus>
      <button class="btn" type="submit">Mở khoá</button>
      <div class="err">${esc(ui.lockErr)}</div></form>`;
  }

  // ---------- Dựng giao diện ----------
  function viewTab() {
    const body = { home: viewHome, list: viewList, cases: viewCases, stats: viewStats, settings: viewSettings }[ui.tab]();
    return body + tabs();
  }
  function render(keepScroll) {
    const y = window.scrollY;
    if (!key) app.innerHTML = viewLock();
    else if (!ui.page) app.innerHTML = viewTab();
    else if (ui.page.type === 'detail') app.innerHTML = viewDetail(ui.page.id);
    else if (ui.page.type === 'form') app.innerHTML = viewForm();
    else if (ui.page.type === 'case') app.innerHTML = viewCase(ui.page.id);
    else if (ui.page.type === 'attach') app.innerHTML = viewAttach();
    else if (ui.page.type === 'batch') app.innerHTML = viewBatch();
    else if (ui.page.type === 'pass') app.innerHTML = viewPass();
    else if (ui.page.type === 'scanReview') app.innerHTML = viewScanReview();
    else if (ui.page.type === 'caseForm') app.innerHTML = viewCaseForm();
    window.scrollTo(0, keepScroll ? y : 0);
  }
  function lock() {
    key = null; records = []; cases = []; ui.page = null; ui.draft = null; ui.cdraft = null; ui.scan = null; ui.lockErr = '';
    render();
  }

  // ---------- Ảnh ----------
  function readPhoto(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => {
        const max = 480; const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Không đọc được ảnh')); };
      img.src = url;
    });
  }

  // ---------- Xuất / nhập ----------
  async function saveFile(name, text, type) {
    const file = new File([text], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function exportBackup() {
    const rows = await tx('bican', 'readonly', (s) => s.getAll());
    const data = {
      app: 'qlbc', v: 1, at: new Date().toISOString(),
      salt: b64(auth.salt), iter: auth.iter, check: { iv: b64(auth.check.iv), ct: b64(auth.check.ct) },
      records: rows.map((r) => ({ iv: b64(r.iv), ct: b64(r.ct) })),
      cases: (await tx('vuan', 'readonly', (s) => s.getAll())).map((r) => ({ iv: b64(r.iv), ct: b64(r.ct) })),
    };
    await saveFile(`bican-saoluu-${today()}.qlbc`, JSON.stringify(data), 'application/json');
  }
  async function importBackup(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data || data.app !== 'qlbc' || !Array.isArray(data.records)) { toast('Tệp không phải bản sao lưu hợp lệ'); return; }
    const pass = prompt('Nhập mật khẩu của bản sao lưu:');
    if (pass == null) return;
    const k = await keyFromAuth(pass, { salt: unb64(data.salt), iter: data.iter, check: { iv: unb64(data.check.iv), ct: unb64(data.check.ct) } });
    if (!k) { toast('Sai mật khẩu bản sao lưu'); return; }
    let added = 0; let updated = 0;
    for (const row of data.records) {
      const r = normalize(await unseal(k, { iv: unb64(row.iv), ct: unb64(row.ct) }));
      const old = records.find((x) => x.id === r.id);
      if (old && (old.updatedAt || 0) >= (r.updatedAt || 0)) continue;
      await putRecord(r); if (old) updated++; else added++;
    }
    for (const row of data.cases || []) {
      const c = normCase(await unseal(k, { iv: unb64(row.iv), ct: unb64(row.ct) }));
      const old = cases.find((x) => x.id === c.id) || caseByName(c.ten);
      if (!old) { await putCase(c); continue; }
      // Vụ án đã có: giữ bản đang có, chỉ lấy thêm các ô còn trống.
      let ch = false; for (const [f, v] of Object.entries(c)) if (!old[f] && v) { old[f] = v; ch = true; }
      if (ch) await putCase(old);
    }
    await syncCases(); await refreshAllCases();
    toast(`Đã khôi phục: thêm ${added}, cập nhật ${updated} hồ sơ`);
    render();
  }
  function exportCSV() {
    const cols = [
      ['Họ và tên', (r) => r.hoTen], ['Tên gọi khác', (r) => r.tenKhac], ['Giới tính', (r) => r.gioiTinh], ['Ngày sinh', (r) => vn(r.ngaySinh)],
      ['CCCD', (r) => r.cccd], ['Quốc tịch', (r) => r.quocTich], ['Dân tộc', (r) => r.danToc], ['Nghề nghiệp', (r) => r.ngheNghiep],
      ['Nơi thường trú', (r) => r.hktt], ['Chỗ ở hiện nay', (r) => r.choO], ['Tiền án, tiền sự', (r) => r.tienAn],
      ['Vụ án', (r) => r.vuAn], ['QĐ KTVA số', (r) => r.soQDKTVA], ['Ngày KTVA', (r) => vn(r.ngayKTVA)],
      ['Tội danh', (r) => r.toiDanh], ['Điều khoản', (r) => r.dieuKhoan], ['QĐ KTBC số', (r) => r.soQDKTBC], ['Ngày KTBC', (r) => vn(r.ngayKTBC)],
      ['Giai đoạn', (r) => GIAI_DOAN[r.giaiDoan]], ['Biện pháp ngăn chặn', (r) => BIEN_PHAP[r.bienPhap]], ['Ngày bắt', (r) => vn(r.ngayBat)],
      ['Nơi giam giữ', (r) => r.noiGiam], ['Lệnh số', (r) => r.soLenh], ['Loại thời hạn', (r) => r.loaiHan], ['Từ ngày', (r) => vn(r.tgTu)], ['Đến ngày', (r) => vn(r.tgDen)],
      ['Gia hạn', (r) => (r.giaHan || []).map((g, i) => `Lần ${i + 1}: ${g.so || ''} ${g.loai || ''} ${vn(g.tu)}-${vn(g.den)}`).join('; ')],
      ['Hạn hiện tại', (r) => vn(deadlineOf(r))], ['KLĐT số', (r) => r.soKLDT], ['Ngày KLĐT', (r) => vn(r.ngayKLDT)],
      ['Điều tra bổ sung', (r) => (r.dtbs || []).map((b, i) => `Lần ${i + 1}: ${CO_QUAN_TRA[b.gd] || CO_QUAN_TRA.vks} ${vn(b.ngayTra)}; KL bổ sung ${b.so || ''} ${vn(b.ngayKL)}`).join(' | ')],
      ['QĐ tạm đình chỉ số', (r) => r.soTDC], ['Ngày tạm đình chỉ', (r) => vn(r.ngayTDC)], ['QĐ đình chỉ số', (r) => r.soDC], ['Ngày đình chỉ', (r) => vn(r.ngayDC)],
      ['Điều tra viên', (r) => r.dtv], ['Kiểm sát viên', (r) => r.ksv], ['Ghi chú', (r) => r.ghiChu],
    ];
    // Thêm dấu ' trước ô bắt đầu bằng = + - @ để Excel không coi là công thức; CCCD giữ dạng chữ.
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const lines = [cols.map((c) => cell(c[0])).join(',')];
    for (const r of [...records].sort(byName)) lines.push(cols.map((c) => (c[0] === 'CCCD' && r.cccd ? `"=""${String(r.cccd).replace(/"/g, '')}"""` : cell(c[1](r)))).join(','));
    return saveFile(`danh-sach-bi-can-${today()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  }

  // ---------- Hành động ----------
  const actions = {
    tab(el) { ui.tab = el.dataset.tab; ui.page = null; render(); },
    goFilter(el) { ui.tab = 'list'; ui.filter = el.dataset.filter; ui.q = ''; render(); },
    filter(el) { ui.filter = el.dataset.filter; render(true); },
    open(el) { ui.page = { type: 'detail', id: el.dataset.id, from: ui.page }; render(); },
    case(el) { ui.page = { type: 'case', id: el.dataset.id, from: ui.page }; render(); },
    back() { ui.page = (ui.page && ui.page.from) || null; render(); },
    new() {
      ui.scan = null; ui.draft = blank();
      const c = ui.page && ui.page.type === 'case' && cases.find((x) => x.id === ui.page.id);
      if (c) { ui.draft.vuAn = c.ten; for (const k of CASE_SEED) ui.draft[k] = c[k] || ''; }
      ui.page = { type: 'form', from: ui.page }; render();
    },
    newCase() { ui.scan = null; ui.cdraft = blankCase(); ui.page = { type: 'caseForm', from: ui.page }; render(); },
    editCase(el) {
      const c = cases.find((x) => x.id === el.dataset.id); if (!c) return;
      ui.scan = null; ui.cdraft = normCase(clone(c)); ui.page = { type: 'caseForm', from: ui.page }; render();
    },
    async saveCase() {
      syncCaseDraft(); const c = ui.cdraft;
      const old = cases.find((x) => x.id === c.id);
      const people = old ? casePeople(old) : [];
      if (c.tuDat !== false) {
        const conv = conventionName(c, people);
        if (!conv && !c.ten) { toast('Nhập tội danh để app đặt tên vụ án'); return; }
        if (conv) c.ten = uniqueName(conv, c);
      } else {
        if (!c.ten) { toast('Vui lòng nhập tên vụ án'); return; }
        const other = caseByName(c.ten);
        if (other && other.id !== c.id) { toast('Đã có vụ án cùng tên'); return; }
      }
      if (old && old.ten !== c.ten) { const now = c.ten; c.ten = old.ten; rememberName(c); c.ten = now; }
      c.updatedAt = Date.now(); await putCase(c);
      // Đồng bộ sang các bị can trong vụ: tên vụ, quyết định khởi tố vụ án, ngày kết luận / tạm đình chỉ / đình chỉ (nếu bị can chưa có).
      for (const r of people) {
        const before = JSON.stringify(r);
        r.vuAn = c.ten;
        for (const k of ['soQDKTVA', 'ngayKTVA']) if (c[k]) r[k] = c[k];
        const was = clone(r);
        if (c.ngayKLDT && !r.ngayKLDT) { r.ngayKLDT = c.ngayKLDT; if (!r.soKLDT) r.soKLDT = c.soKLDT; }
        if (c.ngayTDC && !r.ngayTDC) { r.ngayTDC = c.ngayTDC; if (!r.soTDC) r.soTDC = c.soTDC; }
        if (c.ngayDC && !r.ngayDC) { r.ngayDC = c.ngayDC; if (!r.soDC) r.soDC = c.soDC; }
        stageFromStop(r, was); autoStage(r);
        if (JSON.stringify(r) !== before) { r.updatedAt = Date.now(); await putRecord(r); }
      }
      ui.cdraft = null; ui.scan = null; ui.tab = 'cases';
      ui.page = { type: 'case', id: c.id, from: null }; toast('Đã lưu vụ án'); render();
    },
    attachPage(el) {
      const items = records.filter((r) => !normName(r.vuAn)).sort(byName).map((r) => ({ id: r.id, on: false }));
      ui.page = { type: 'attach', id: el.dataset.id, items, from: ui.page }; render();
    },
    attachToggle(el) { const it = ui.page.items[Number(el.dataset.i)]; it.on = !it.on; render(true); },
    async attachSave() {
      const c = cases.find((x) => x.id === ui.page.id); if (!c) return;
      let n = 0;
      for (const it of ui.page.items.filter((x) => x.on)) {
        const r = records.find((x) => x.id === it.id); if (!r) continue;
        r.vuAn = c.ten; for (const k of ['soQDKTVA', 'ngayKTVA']) if (c[k]) r[k] = c[k];
        r.updatedAt = Date.now(); await putRecord(r); n++;
      }
      await refreshCaseName(c);
      ui.page = { type: 'case', id: c.id, from: null }; toast(`Đã gắn ${n} bị can vào vụ án`); render();
    },
    openItem(el) {
      const from = ui.page;
      ui.page = el.dataset.kind === 'case' ? { type: 'case', id: el.dataset.id, from } : { type: 'detail', id: el.dataset.id, from };
      render();
    },
    async delCase(el) {
      const c = cases.find((x) => x.id === el.dataset.id); if (!c || casePeople(c).length) return;
      if (!confirm(`Xoá vụ án "${c.ten}"?`)) return;
      await removeCase(c.id); ui.page = null; ui.tab = 'cases'; toast('Đã xoá vụ án'); render();
    },
    async mergeDups() {
      const groups = dupGroups(); if (!groups.length) return;
      const desc = groups.map((g) => `• ${g[0].hoTen} (${g.length} hồ sơ)`).join('\n');
      if (!confirm(`Gộp các hồ sơ trùng sau, mỗi người còn một hồ sơ?\n${desc}\n\nThông tin của các hồ sơ được dồn lại. Không thể hoàn tác, nên xuất bản sao lưu trước.`)) return;
      for (const g of groups) {
        const base = mergeGroup(g); await putRecord(base);
        for (const o of g) if (o.id !== base.id) await removeRecord(o.id);
      }
      await refreshAllCases();
      toast(`Đã gộp ${groups.length} bị can bị trùng`); render();
    },
    clearStats() { for (const [k] of ST_FIELDS) ui.st[k] = ''; render(true); },
    addBs() { syncDraft(); ui.draft.dtbs.push({ gd: 'vks', ngayTra: '', so: '', ngayKL: '' }); render(true); },
    delBs(el) { syncDraft(); ui.draft.dtbs.splice(Number(el.dataset.i), 1); render(true); },
    edit(el) {
      const r = records.find((x) => x.id === el.dataset.id); if (!r) return;
      ui.scan = null; ui.draft = normalize(clone(r));
      ui.page = { type: 'form', from: ui.page }; render();
    },
    cancel() { ui.draft = null; ui.cdraft = null; ui.scan = null; ui.page = ui.page.from || null; render(); },
    pickScan() { $('#scanFile').click(); },
    newScan() { $('#scanFile').click(); },
    scanToggle(el) { const p = ui.page.persons[Number(el.dataset.i)]; p.on = !p.on; render(true); },
    async scanSave() {
      const list = ui.page.persons.filter((p) => p.on); let added = 0; let merged = 0;
      for (const p of list) {
        const ex = findExisting(p.got);
        const r = ex ? normalize(clone(ex)) : blank();
        applyScan(r, p.got); linkCase(r); stageFromStop(r, ex); autoStage(r); r.updatedAt = Date.now();
        await putRecord(r); await ensureCase(r.vuAn, r);
        if (ex) merged++; else added++;
      }
      await refreshAllCases();
      ui.page = null; ui.tab = 'list'; ui.filter = 'all'; ui.q = '';
      toast(`Thêm ${added} hồ sơ mới, bổ sung ${merged} hồ sơ đã có — hãy mở từng hồ sơ để kiểm tra`); render();
    },
    async save() {
      syncDraft(); const r = ui.draft;
      if (!r.hoTen) { toast('Vui lòng nhập họ và tên'); return; }
      if (r.tgTu && r.tgDen && r.tgDen < r.tgTu) { toast('"Đến ngày" phải sau "từ ngày"'); return; }
      r.giaHan = r.giaHan.filter((g) => g.so || g.tu || g.den);
      r.dtbs = r.dtbs.filter((b) => b.ngayTra || b.so || b.ngayKL);
      const isNew = !records.some((x) => x.id === r.id);
      const dup = isNew && findExisting(r);
      if (dup && !confirm(`Đã có hồ sơ của "${dup.hoTen}"${dup.ngaySinh ? ' sinh ' + vn(dup.ngaySinh) : ''}. Vẫn lưu thành một hồ sơ mới?`)) return;
      linkCase(r); stageFromStop(r, records.find((x) => x.id === r.id)); autoStage(r);
      r.updatedAt = Date.now();
      const prev = records.find((x) => x.id === r.id); const prevCase = prev && caseByName(prev.vuAn);
      await putRecord(r);
      const nowCase = await ensureCase(r.vuAn, r);
      await refreshCaseName(nowCase);
      if (prevCase && (!nowCase || prevCase.id !== nowCase.id)) await refreshCaseName(prevCase);
      ui.draft = null; ui.scan = null;
      const from = ui.page.from;
      ui.page = from && from.type === 'detail' ? from : { type: 'detail', id: r.id, from };
      toast('Đã lưu'); render();
    },
    async delete(el) {
      const r = records.find((x) => x.id === el.dataset.id); if (!r) return;
      if (!confirm(`Xoá hồ sơ bị can "${r.hoTen}"? Không thể hoàn tác.`)) return;
      const c = caseByName(r.vuAn);
      await removeRecord(r.id); await refreshCaseName(c);
      ui.page = ui.page.from || null; toast('Đã xoá'); render();
    },
    addTerm() { settings.terms.push({ ten: '', ngay: 30 }); render(true); },
    async delTerm(el) { settings.terms.splice(Number(el.dataset.i), 1); await metaSet('settings', settings); render(true); },
    async resetTerms() {
      if (!confirm('Đặt lại bảng thời hạn về mặc định?')) return;
      settings.terms = defaultSettings().terms; await metaSet('settings', settings); render(true);
    },
    addExt() {
      syncDraft(); const r = ui.draft;
      const last = [r.tgDen, ...r.giaHan.map((g) => g.den)].filter(Boolean).sort().pop();
      r.giaHan.push({ so: '', loai: '', tu: last ? addDays(last, 1) : '', den: '' }); render(true);
    },
    delExt(el) { syncDraft(); ui.draft.giaHan.splice(Number(el.dataset.i), 1); render(true); },
    pickPhoto() { $('#photoFile').click(); },
    dropPhoto() { syncDraft(); ui.draft.anh = ''; render(true); },
    lock() { lock(); },
    async update() {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (!reg) { location.reload(); return; }
      toast('Đang kiểm tra…');
      await reg.update();
      // Có bản mới thì trang tự tải lại khi bản mới sẵn sàng (xem controllerchange bên dưới).
      setTimeout(() => { if (!reg.installing && !reg.waiting) toast(`Đang dùng bản mới nhất (phiên bản ${APP_VERSION})`); }, 1500);
    },
    passPage() { ui.page = { type: 'pass' }; render(); },
    async backup() { if (!records.length) { toast('Chưa có dữ liệu để sao lưu'); return; } await exportBackup(); },
    restore() { $('#restoreFile').click(); },
    async csv() { if (!records.length) { toast('Chưa có dữ liệu để xuất'); return; } await exportCSV(); },
    async wipe() {
      if (!confirm('Xoá TOÀN BỘ hồ sơ và mật khẩu trên máy này? Không thể hoàn tác.')) return;
      if (prompt('Gõ XOA để xác nhận:') !== 'XOA') { toast('Đã huỷ'); return; }
      await tx('bican', 'readwrite', (s) => s.clear());
      await tx('vuan', 'readwrite', (s) => s.clear());
      await tx('meta', 'readwrite', (s) => s.clear());
      auth = null; settings = defaultSettings(); lock();
    },
  };

  let busy = false;
  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || busy) return;
    busy = true;
    try { await actions[el.dataset.act](el); } catch (err) { console.error(err); toast('Có lỗi: ' + (err.message || err)); } finally { busy = false; }
  });

  app.addEventListener('input', (e) => {
    if (e.target.id === 'q') { ui.q = e.target.value; $('#list').innerHTML = listHtml(); }
  });

  app.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.id === 'alertDays') {
        settings.alertDays = Math.min(60, Math.max(1, parseInt(t.value, 10) || 10));
        await metaSet('settings', settings); render(true); toast('Đã lưu cài đặt');
      } else if (t.id === 'statDay' || t.id === 'statMonth') {
        const m = Math.min(12, Math.max(1, parseInt($('#statMonth').value, 10) || 1));
        const dmax = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
        settings.statMonth = m; settings.statDay = Math.min(dmax, Math.max(1, parseInt($('#statDay').value, 10) || 1));
        await metaSet('settings', settings); ui.st.nam = String(periodOf(today())); render(true); toast('Đã lưu cài đặt');
      } else if (t.name === 'tuDatSel') {
        syncCaseDraft(); render(true);
      } else if (t.dataset.st) {
        ui.st[t.dataset.st] = t.value; render(true);
      } else if (t.name === 'vuAn' && ui.draft) {
        // Chọn vụ án đã có thì lấy sẵn quyết định khởi tố vụ án, tội danh cho các ô còn trống.
        const c = caseByName(t.value);
        if (c) for (const k of CASE_SEED) { const el = $(`#form [name=${k}]`); if (el && !el.value && c[k]) el.value = c[k]; }
      } else if (t.dataset.term != null) {
        const row = settings.terms[Number(t.dataset.term)];
        if (t.dataset.k === 'ngay') row.ngay = Math.min(3650, Math.max(1, parseInt(t.value, 10) || 1));
        else row.ten = t.value.trim();
        await metaSet('settings', settings); render(true);
      } else if (ui.draft && /^(loaiHan|tgTu|gh\d+_(loai|tu))$/.test(t.name || '')) {
        // Tự tính "đến ngày" = từ ngày + số ngày tra theo loại thời hạn − 1
        syncDraft();
        const m = /^gh(\d+)_/.exec(t.name);
        const o = m ? ui.draft.giaHan[+m[1]] : ui.draft;
        const days = termDays(m ? o.loai : o.loaiHan); const tu = m ? o.tu : o.tgTu;
        if (days && tu) {
          const den = addDays(tu, days - 1);
          if (m) o.den = den; else o.tgDen = den;
          $(`[name=${m ? `gh${m[1]}_den` : 'tgDen'}]`).value = den;
        }
      } else if (t.id === 'photoFile' && t.files[0]) {
        syncDraft(); ui.draft.anh = await readPhoto(t.files[0]); render(true);
      } else if (t.id === 'scanFile' && t.files.length) {
        const files = [...t.files]; t.value = ''; await runScan(files);
      } else if (t.id === 'restoreFile' && t.files[0]) {
        const f = t.files[0]; t.value = ''; await importBackup(f);
      }
    } catch (err) { console.error(err); toast('Có lỗi: ' + (err.message || err)); }
  });

  app.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const btn = $('button[type=submit]', f);
    if (btn) btn.disabled = true;
    try {
      if (f.id === 'setupForm') {
        const p1 = f.p1.value; const p2 = f.p2.value;
        if (p1.length < 6) ui.lockErr = 'Mật khẩu cần ít nhất 6 ký tự.';
        else if (p1 !== p2) ui.lockErr = 'Hai lần nhập mật khẩu không khớp.';
        else {
          const made = await makeAuth(p1);
          await metaSet('auth', made.auth);
          auth = made.auth; key = made.key; records = []; cases = []; ui.lockErr = ''; ui.tab = 'home';
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        }
        render();
      } else if (f.id === 'unlockForm') {
        const k = await keyFromAuth(f.p.value, auth);
        if (!k) { ui.lockErr = 'Sai mật khẩu.'; render(); return; }
        key = k; ui.lockErr = ''; await loadRecords(); render();
      } else if (f.id === 'passForm') {
        if (!(await keyFromAuth(f.cur.value, auth))) { toast('Mật khẩu hiện tại không đúng'); return; }
        if (f.p1.value.length < 6) { toast('Mật khẩu mới cần ít nhất 6 ký tự'); return; }
        if (f.p1.value !== f.p2.value) { toast('Hai lần nhập mật khẩu mới không khớp'); return; }
        const made = await makeAuth(f.p1.value);
        const rows = [];
        for (const r of records) { const box = await seal(made.key, r); rows.push({ id: r.id, iv: box.iv, ct: box.ct }); }
        const crows = [];
        for (const c of cases) { const box = await seal(made.key, c); crows.push({ id: c.id, iv: box.iv, ct: box.ct }); }
        // Ghi hồ sơ và thông tin mật khẩu trong cùng một giao dịch để không bao giờ lệch khoá.
        await new Promise((res, rej) => {
          const t = db.transaction(['bican', 'vuan', 'meta'], 'readwrite');
          rows.forEach((row) => t.objectStore('bican').put(row));
          crows.forEach((row) => t.objectStore('vuan').put(row));
          t.objectStore('meta').put(made.auth, 'auth');
          t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
        });
        auth = made.auth; key = made.key; ui.page = null; toast('Đã đổi mật khẩu'); render();
      }
    } catch (err) { console.error(err); toast('Có lỗi: ' + (err.message || err)); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  // Tự khoá khi rời ứng dụng quá 1 phút (10 phút nếu đang nhập dở biểu mẫu, để kịp chọn ảnh).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (key && hiddenAt && Date.now() - hiddenAt > (ui.page && ['form', 'caseForm', 'scanReview', 'batch', 'attach'].includes(ui.page.type) ? 10 : 1) * AUTO_LOCK_MS) lock();
  });

  // ---------- Khởi động ----------
  (async () => {
    try {
      db = await openDB();
      auth = (await metaGet('auth')) || null;
      settings = Object.assign(settings, (await metaGet('settings')) || {});
      if (!Array.isArray(settings.terms)) settings.terms = defaultSettings().terms;
      ui.st.nam = String(periodOf(today()));
    } catch (err) {
      app.innerHTML = `<div class="lock"><p class="warn">Không mở được bộ nhớ của trình duyệt (${esc(err && err.message)}). Hãy tắt chế độ duyệt riêng tư rồi thử lại.</p></div>`;
      return;
    }
    render();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      const sw = navigator.serviceWorker;
      const hadController = !!sw.controller;
      // Khi bản mới của app đã sẵn sàng thì tải lại trang để dùng ngay (trừ lúc đang nhập dở biểu mẫu).
      sw.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (ui.page && ['form', 'caseForm', 'scanReview'].includes(ui.page.type)) toast('Đã có bản mới, sẽ áp dụng khi mở lại app');
        else location.reload();
      });
      sw.register('sw.js').then((reg) => {
        let last = Date.now();
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && Date.now() - last > 60000) { last = Date.now(); reg.update().catch(() => {}); }
        });
      }).catch(() => {});
    }
  })();
})();
