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
    truyto: 'Truy tố',
    xetxu: 'Xét xử',
    tamdinhchi: 'Tạm đình chỉ',
    dinhchi: 'Đình chỉ',
  };
  const GIAM_GIU = ['tamgiam', 'tamgiu'];
  const TAI_NGOAI = ['camdi', 'baolinh', 'dattien'];
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
      const r = indexedDB.open('qlbc', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meta');
        r.result.createObjectStore('bican', { keyPath: 'id' });
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
  let settings = { alertDays: 10 };
  const ui = { tab: 'home', page: null, q: '', filter: 'all', draft: null, lockErr: '' };

  async function loadRecords() {
    const rows = await tx('bican', 'readonly', (s) => s.getAll());
    const out = [];
    for (const row of rows) out.push(await unseal(key, row));
    records = out;
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

  // ---------- Nghiệp vụ: thời hạn tạm giữ / tạm giam ----------
  function deadlineOf(r) {
    if (!GIAM_GIU.includes(r.bienPhap) || r.giaiDoan === 'dinhchi') return null;
    const ds = [r.tgDen, ...(r.giaHan || []).map((g) => g.den)].filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : null;
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
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900l2.100 2.100M17 17l2.100 2.100M4.900 19.100L7 17M17 7l2.100-2.100"/></svg>',
  };
  function bar(title, left = '', right = '') {
    return `<header class="bar"><div class="side">${left}</div><h1>${esc(title)}</h1><div class="side right">${right}</div></header>`;
  }
  function tabs() {
    const n = alerts().length;
    const t = (id, label) => `<button data-act="tab" data-tab="${id}" class="${ui.tab === id ? 'on' : ''}">${ICON[id]}${label}${id === 'home' && n ? `<span class="dot">${n}</span>` : ''}</button>`;
    return `<nav class="tabs">${t('home', 'Tổng quan')}${t('list', 'Bị can')}${t('cases', 'Vụ án')}${t('settings', 'Cài đặt')}</nav>`;
  }
  function avatar(r, big) {
    return r.anh
      ? `<img class="avatar ${big ? 'big' : ''}" src="${esc(r.anh)}" alt="">`
      : `<div class="avatar ${big ? 'big' : ''}">${esc(initials(r.hoTen))}</div>`;
  }
  function personRow(r, withDeadline) {
    const d = dlInfo(r);
    const sub = [r.toiDanh, r.vuAn].filter(Boolean).join(' · ') || (r.ngaySinh ? `Sinh ${vn(r.ngaySinh)}` : '');
    const right = withDeadline && d
      ? `<span class="tag ${d.level}">${esc(d.text)}</span><div class="sub">${vn(d.date)}</div>`
      : `${bpTag(r)}${d && d.level !== 'green' ? `<div class="sub"><span class="tag ${d.level}">${esc(d.text)}</span></div>` : ''}`;
    return `<button class="row" data-act="open" data-id="${esc(r.id)}">${avatar(r)}<div class="main"><div class="name">${esc(r.hoTen)}</div><div class="sub">${esc(sub)}</div></div><div class="right">${right}</div></button>`;
  }

  // ---------- Giao diện: các tab ----------
  function viewHome() {
    const giam = records.filter((r) => GIAM_GIU.includes(r.bienPhap) && r.giaiDoan !== 'dinhchi');
    const ngoai = records.filter((r) => TAI_NGOAI.includes(r.bienPhap));
    const truyna = records.filter((r) => r.bienPhap === 'truyna');
    const al = alerts();
    const upcoming = records.map((r) => ({ r, d: dlInfo(r) })).filter((x) => x.d && x.d.level === 'green').sort((a, b) => a.d.left - b.d.left);
    return `${bar('Quản lý bị can', '', '<button data-act="lock">Khoá</button>')}
    <main class="content">
      <div class="stats">
        <button class="stat" data-act="goFilter" data-filter="all"><b>${records.length}</b><span>Tổng số bị can</span></button>
        <button class="stat" data-act="goFilter" data-filter="giam"><b>${giam.length}</b><span>Đang tạm giữ, tạm giam</span></button>
        <button class="stat" data-act="goFilter" data-filter="ngoai"><b>${ngoai.length}</b><span>Tại ngoại</span></button>
        <button class="stat ${truyna.length ? 'red' : ''}" data-act="goFilter" data-filter="truyna"><b>${truyna.length}</b><span>Đang truy nã</span></button>
      </div>
      <h3 class="section-title">Hạn tạm giữ, tạm giam cần chú ý (${al.length})</h3>
      <div class="card">${al.length ? al.map((x) => personRow(x.r, true)).join('') : `<div class="empty">Không có hạn nào quá hạn hoặc sắp hết trong ${settings.alertDays} ngày tới.</div>`}</div>
      ${upcoming.length ? `<h3 class="section-title">Các hạn tiếp theo</h3><div class="card">${upcoming.map((x) => personRow(x.r, true)).join('')}</div>` : ''}
      ${records.length ? '' : '<button class="btn" data-act="new">Thêm bị can đầu tiên</button>'}
    </main>`;
  }

  const FILTERS = [
    ['all', 'Tất cả', () => true],
    ['giam', 'Tạm giữ, tạm giam', (r) => GIAM_GIU.includes(r.bienPhap)],
    ['ngoai', 'Tại ngoại', (r) => TAI_NGOAI.includes(r.bienPhap)],
    ['truyna', 'Truy nã', (r) => r.bienPhap === 'truyna'],
    ['dieutra', 'Đang điều tra', (r) => r.giaiDoan === 'dieutra'],
    ['xong', 'Đã kết thúc điều tra', (r) => ['ketluan', 'truyto', 'xetxu'].includes(r.giaiDoan)],
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
    return `${bar('Danh sách bị can')}
    <main class="content">
      <input class="search" id="q" type="search" placeholder="Tìm tên, CCCD, vụ án, tội danh…" value="${esc(ui.q)}" autocomplete="off">
      <div class="chips">${FILTERS.map(([id, label]) => `<button class="chip ${ui.filter === id ? 'on' : ''}" data-act="filter" data-filter="${id}">${label}</button>`).join('')}</div>
      <div id="list">${listHtml()}</div>
    </main>
    <button class="fab" data-act="new" aria-label="Thêm bị can">+</button>`;
  }

  const caseName = (r) => (r.vuAn || '').trim() || 'Chưa gắn vụ án';
  function caseGroups() {
    const m = new Map();
    for (const r of records) { const k = caseName(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => fold(a[0]).localeCompare(fold(b[0])));
  }
  function viewCases() {
    const groups = caseGroups();
    return `${bar('Vụ án')}
    <main class="content">
      ${groups.length ? `<div class="card">${groups.map(([name, rs]) => {
        const giam = rs.filter((r) => GIAM_GIU.includes(r.bienPhap)).length;
        return `<button class="row" data-act="case" data-name="${esc(name)}"><div class="main"><div class="name">${esc(name)}</div><div class="sub">${rs.length} bị can${giam ? ` · ${giam} đang giam giữ` : ''}</div></div><span class="chev">›</span></button>`;
      }).join('')}</div>` : '<div class="empty">Chưa có vụ án nào. Vụ án được tạo tự động theo tên vụ án ghi trong hồ sơ bị can.</div>'}
    </main>`;
  }
  function viewCase(name) {
    const rs = records.filter((r) => caseName(r) === name).sort(byName);
    const first = rs.find((r) => r.soQDKTVA || r.ngayKTVA) || {};
    return `${bar('Vụ án', '<button data-act="back">‹ Quay lại</button>')}
    <main class="content">
      <div class="card pad"><h2 style="font-size:18px">${esc(name)}</h2>
      ${first.soQDKTVA || first.ngayKTVA ? `<p class="sub" style="color:var(--muted);margin-top:4px">QĐ khởi tố vụ án ${first.soQDKTVA ? 'số ' + esc(first.soQDKTVA) : ''} ${first.ngayKTVA ? 'ngày ' + vn(first.ngayKTVA) : ''}</p>` : ''}</div>
      <h3 class="section-title">Bị can (${rs.length})</h3>
      <div class="card">${rs.map((r) => personRow(r)).join('') || '<div class="empty">Không còn bị can nào.</div>'}</div>
    </main>`;
  }

  function viewSettings() {
    return `${bar('Cài đặt')}
    <main class="content">
      <h3 class="section-title">Cảnh báo</h3>
      <div class="card"><label class="field"><span>Cảnh báo trước khi hết hạn tạm giữ, tạm giam (ngày)</span>
        <input id="alertDays" type="number" inputmode="numeric" min="1" max="60" value="${settings.alertDays}"></label></div>

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
      <p class="note">${records.length} hồ sơ · phiên bản 1.0</p>
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
        kv('Thời hạn', r.tgTu || r.tgDen ? `${vn(r.tgTu) || '…'} → ${vn(r.tgDen) || '…'}` : ''),
        ...(r.giaHan || []).map((g, i) => kv(`Gia hạn lần ${i + 1}`, `${g.so ? 'Số ' + g.so + '\n' : ''}${vn(g.tu) || '…'} → ${vn(g.den) || '…'}`)),
      ])}
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
      bienPhap: 'tamgiam', ngayBat: '', noiGiam: '', soLenh: '', tgTu: '', tgDen: '', giaHan: [], dtv: '', ksv: '', ghiChu: '', createdAt: Date.now(), updatedAt: Date.now() };
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
        ${inp('Thời hạn từ ngày', 'tgTu', r.tgTu, 'date')}
        ${inp('Đến ngày', 'tgDen', r.tgDen, 'date')}
        <div class="quick">Tính nhanh "đến ngày":
          <button type="button" data-act="quick" data-m="2">2 tháng</button>
          <button type="button" data-act="quick" data-m="3">3 tháng</button>
          <button type="button" data-act="quick" data-m="4">4 tháng</button>
          <span>(1 tháng = 30 ngày; luôn đối chiếu với lệnh)</span></div>
      </div>
      <h3 class="section-title">Gia hạn tạm giam</h3>
      <div class="card">
        ${(r.giaHan || []).map((g, i) => `<div class="ext">
          <div class="ext-head"><span>Gia hạn lần ${i + 1}</span><button type="button" data-act="delExt" data-i="${i}">Xoá</button></div>
          ${inp('Lệnh / quyết định số', `gh${i}_so`, g.so)}
          ${inp('Từ ngày', `gh${i}_tu`, g.tu, 'date')}
          ${inp('Đến ngày', `gh${i}_den`, g.den, 'date')}
        </div>`).join('')}
        <button type="button" class="row" data-act="addExt"><div class="main"><div class="name link">+ Thêm lần gia hạn</div></div></button>
      </div>
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
      const m = /^gh(\d+)_(so|tu|den)$/.exec(k);
      if (m) { if (r.giaHan[+m[1]]) r.giaHan[+m[1]][m[2]] = String(v).trim(); } else if (k in r) r[k] = String(v).trim();
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
    const body = { home: viewHome, list: viewList, cases: viewCases, settings: viewSettings }[ui.tab]();
    return body + tabs();
  }
  function render(keepScroll) {
    const y = window.scrollY;
    if (!key) app.innerHTML = viewLock();
    else if (!ui.page) app.innerHTML = viewTab();
    else if (ui.page.type === 'detail') app.innerHTML = viewDetail(ui.page.id);
    else if (ui.page.type === 'form') app.innerHTML = viewForm();
    else if (ui.page.type === 'case') app.innerHTML = viewCase(ui.page.name);
    else if (ui.page.type === 'pass') app.innerHTML = viewPass();
    window.scrollTo(0, keepScroll ? y : 0);
  }
  function lock() {
    key = null; records = []; ui.page = null; ui.draft = null; ui.lockErr = '';
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
      const r = await unseal(k, { iv: unb64(row.iv), ct: unb64(row.ct) });
      const old = records.find((x) => x.id === r.id);
      if (old && (old.updatedAt || 0) >= (r.updatedAt || 0)) continue;
      await putRecord(r); if (old) updated++; else added++;
    }
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
      ['Nơi giam giữ', (r) => r.noiGiam], ['Lệnh số', (r) => r.soLenh], ['Từ ngày', (r) => vn(r.tgTu)], ['Đến ngày', (r) => vn(r.tgDen)],
      ['Gia hạn', (r) => (r.giaHan || []).map((g, i) => `Lần ${i + 1}: ${g.so || ''} ${vn(g.tu)}-${vn(g.den)}`).join('; ')],
      ['Hạn hiện tại', (r) => vn(deadlineOf(r))], ['Điều tra viên', (r) => r.dtv], ['Kiểm sát viên', (r) => r.ksv], ['Ghi chú', (r) => r.ghiChu],
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
    case(el) { ui.page = { type: 'case', name: el.dataset.name }; render(); },
    back() { ui.page = (ui.page && ui.page.from) || null; render(); },
    new() { ui.draft = blank(); if (ui.page && ui.page.type === 'case' && ui.page.name !== 'Chưa gắn vụ án') ui.draft.vuAn = ui.page.name; ui.page = { type: 'form', from: ui.page }; render(); },
    edit(el) {
      const r = records.find((x) => x.id === el.dataset.id); if (!r) return;
      ui.draft = JSON.parse(JSON.stringify(r)); ui.draft.giaHan = ui.draft.giaHan || [];
      ui.page = { type: 'form', from: ui.page }; render();
    },
    cancel() { ui.draft = null; ui.page = ui.page.from || null; render(); },
    async save() {
      syncDraft(); const r = ui.draft;
      if (!r.hoTen) { toast('Vui lòng nhập họ và tên'); return; }
      if (r.tgTu && r.tgDen && r.tgDen < r.tgTu) { toast('"Đến ngày" phải sau "từ ngày"'); return; }
      r.giaHan = r.giaHan.filter((g) => g.so || g.tu || g.den);
      r.updatedAt = Date.now();
      await putRecord(r);
      ui.draft = null;
      const from = ui.page.from;
      ui.page = from && from.type === 'detail' ? from : { type: 'detail', id: r.id, from };
      toast('Đã lưu'); render();
    },
    async delete(el) {
      const r = records.find((x) => x.id === el.dataset.id); if (!r) return;
      if (!confirm(`Xoá hồ sơ bị can "${r.hoTen}"? Không thể hoàn tác.`)) return;
      await removeRecord(r.id); ui.page = ui.page.from || null; toast('Đã xoá'); render();
    },
    quick(el) {
      syncDraft(); const r = ui.draft;
      if (!r.tgTu) { toast('Nhập "thời hạn từ ngày" trước'); return; }
      r.tgDen = addDays(r.tgTu, 30 * Number(el.dataset.m) - 1); render(true);
    },
    addExt() {
      syncDraft(); const r = ui.draft;
      const last = [r.tgDen, ...r.giaHan.map((g) => g.den)].filter(Boolean).sort().pop();
      r.giaHan.push({ so: '', tu: last ? addDays(last, 1) : '', den: '' }); render(true);
    },
    delExt(el) { syncDraft(); ui.draft.giaHan.splice(Number(el.dataset.i), 1); render(true); },
    pickPhoto() { $('#photoFile').click(); },
    dropPhoto() { syncDraft(); ui.draft.anh = ''; render(true); },
    lock() { lock(); },
    passPage() { ui.page = { type: 'pass' }; render(); },
    async backup() { if (!records.length) { toast('Chưa có dữ liệu để sao lưu'); return; } await exportBackup(); },
    restore() { $('#restoreFile').click(); },
    async csv() { if (!records.length) { toast('Chưa có dữ liệu để xuất'); return; } await exportCSV(); },
    async wipe() {
      if (!confirm('Xoá TOÀN BỘ hồ sơ và mật khẩu trên máy này? Không thể hoàn tác.')) return;
      if (prompt('Gõ XOA để xác nhận:') !== 'XOA') { toast('Đã huỷ'); return; }
      await tx('bican', 'readwrite', (s) => s.clear());
      await tx('meta', 'readwrite', (s) => s.clear());
      auth = null; settings = { alertDays: 10 }; lock();
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
      } else if (t.id === 'photoFile' && t.files[0]) {
        syncDraft(); ui.draft.anh = await readPhoto(t.files[0]); render(true);
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
          auth = made.auth; key = made.key; records = []; ui.lockErr = ''; ui.tab = 'home';
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
        // Ghi hồ sơ và thông tin mật khẩu trong cùng một giao dịch để không bao giờ lệch khoá.
        await new Promise((res, rej) => {
          const t = db.transaction(['bican', 'meta'], 'readwrite');
          rows.forEach((row) => t.objectStore('bican').put(row));
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
    else if (key && hiddenAt && Date.now() - hiddenAt > (ui.page && ui.page.type === 'form' ? 10 : 1) * AUTO_LOCK_MS) lock();
  });

  // ---------- Khởi động ----------
  (async () => {
    try {
      db = await openDB();
      auth = (await metaGet('auth')) || null;
      settings = Object.assign(settings, (await metaGet('settings')) || {});
    } catch (err) {
      app.innerHTML = `<div class="lock"><p class="warn">Không mở được bộ nhớ của trình duyệt (${esc(err && err.message)}). Hãy tắt chế độ duyệt riêng tư rồi thử lại.</p></div>`;
      return;
    }
    render();
    if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
      navigator.serviceWorker && navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  })();
})();
