'use strict';
/*
 * Quét văn bản (ảnh chụp / PDF) để tự điền hồ sơ.
 * Việc đọc chữ (OCR) chạy hoàn toàn trên máy bằng Tesseract và pdf.js đặt trong thư mục vendor/,
 * văn bản không được gửi đi đâu. Kết quả chỉ là gợi ý, người dùng phải kiểm tra lại.
 */
const Scan = (() => {
  const base = (p) => new URL(p, document.baseURI).href;
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---------- Nạp thư viện khi cần ----------
  let tessLoading; let worker; let pdfLib;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src;
      s.onload = res; s.onerror = () => rej(new Error('Không tải được bộ đọc chữ. Cần có mạng ở lần dùng đầu tiên.'));
      document.head.appendChild(s);
    });
  }
  let report = () => {};
  async function getWorker() {
    if (worker) return worker;
    if (!tessLoading) tessLoading = loadScript(base('vendor/tesseract/tesseract.min.js'));
    await tessLoading;
    worker = await Tesseract.createWorker('vie', 1, {
      workerPath: base('vendor/tesseract/worker.min.js'),
      corePath: base('vendor/tesseract/'),
      langPath: base('vendor/tesseract/lang/'),
      gzip: true,
      logger: (m) => report(m),
    });
    return worker;
  }
  async function getPdf() {
    if (!pdfLib) {
      pdfLib = await import(base('vendor/pdfjs/pdf.min.mjs'));
      pdfLib.GlobalWorkerOptions.workerSrc = base('vendor/pdfjs/pdf.worker.min.mjs');
    }
    return pdfLib;
  }

  // ---------- Đọc chữ ----------
  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Không đọc được ảnh ' + file.name)); };
      img.src = url;
    });
  }
  // Thu ảnh về cạnh dài tối đa 2600 px để iPhone không hết bộ nhớ.
  function toCanvas(img) {
    const w = img.naturalWidth || img.width; const h = img.naturalHeight || img.height;
    const k = Math.min(1, 2600 / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  async function ocr(canvas, label, onProgress) {
    const w = await getWorker();
    report = (m) => { if (m.status === 'recognizing text') onProgress(`${label}: đang đọc chữ ${Math.round(m.progress * 100)}%`); else onProgress(`${label}: đang chuẩn bị bộ đọc chữ…`); };
    const { data } = await w.recognize(canvas);
    return data.text || '';
  }
  async function readPdf(file, onProgress) {
    const pdfjs = await getPdf();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = Math.min(doc.numPages, 20); const out = [];
    for (let i = 1; i <= n; i++) {
      const label = `Trang ${i}/${n}`;
      onProgress(`${label}: đang mở…`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      if (text.replace(/\s/g, '').length < 40) {
        // Trang scan (không có lớp chữ): vẽ ra ảnh rồi đọc chữ.
        const v0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, 2400 / Math.max(v0.width, v0.height)) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        text = await ocr(c, label, onProgress);
      }
      out.push(text);
    }
    return out.join('\n');
  }
  async function read(files, onProgress = () => {}) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) out.push(await readPdf(f, onProgress));
      else out.push(await ocr(toCanvas(await fileToImage(f)), files.length > 1 ? `Ảnh ${i + 1}/${files.length}` : 'Ảnh', onProgress));
    }
    return out.join('\n');
  }

  // ---------- Dò thông tin trong văn bản ----------
  // Bỏ dấu từng ký tự một (giữ nguyên độ dài) để vị trí khớp trùng với văn bản gốc.
  function fold(s) {
    let o = '';
    for (const ch of s) {
      if (ch.length > 1) { o += ch; continue; }
      let b = ch === 'đ' || ch === 'Đ' || ch === 'Ð' ? 'd' : ch.normalize('NFD')[0];
      const l = b.toLowerCase(); o += l.length === 1 ? l : b;
    }
    return o;
  }
  const DATE = '(\\d{1,2})\\s*(?:[\\/\\-.]|thang)\\s*(\\d{1,2})\\s*(?:[\\/\\-.]|nam)\\s*(\\d{4})';
  function mkDate(d, m, y) {
    d = +d; m = +m; y = +y;
    if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100)) return '';
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').replace(/^[\s:;.,\-–—"“”'(]+|[\s:;.,\-–—"“”'(]+$/g, '').trim();
  function titleCase(s) {
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
  }
  const LABELS = /\b(ho\s*(va\s*)?ten|ten goi khac|gioi tinh|sinh ngay|ngay sinh|ngay,? thang,? nam sinh|sinh nam|nam sinh|noi sinh|que quan|quoc tich|dan toc|ton giao|nghe nghiep|trinh do|noi (dang ky )?thuong tru|noi cu tru|noi dkhktt|hktt|ho khau thuong tru|cho o|noi o|so cccd|cccd|cmnd|can cuoc|chung minh|so dinh danh|tien an|tien su|con ong|con ba|ho ten cha|ho ten me|vo|chong|bi bat|hien dang)\b/;

  // Tìm "nhãn: giá trị". short=true thì cắt thêm ở dấu phẩy / chấm.
  function field(f, src, labels, short) {
    const re = new RegExp(`(?:${labels})\\s*[:：]\\s*([^\\n;]*)`, 'd');
    const m = re.exec(f); if (!m) return '';
    let [a, b] = m.indices[1];
    const cut = LABELS.exec(f.slice(a, b)); if (cut && cut.index > 0) b = a + cut.index;
    // Câu văn tiếp theo bị nối vào cùng dòng thì cắt bỏ.
    const stop = /\s(cac bi can|bi can|bi cao|bi khoi to|ve toi|da co hanh vi|hanh vi)\b/.exec(f.slice(a, b)); if (stop && stop.index > 0) b = a + stop.index;
    let v = src.slice(a, b);
    if (short) v = v.split(/[,.]/)[0];
    return clean(v);
  }
  function dateAfter(f, labels) {
    const m = new RegExp(`(?:${labels})\\s*[:：]?\\s*(?:ngay\\s*)?${DATE}`).exec(f);
    return m ? mkDate(m[1], m[2], m[3]) : '';
  }

  function personFields(f, src) {
    const p = {};
    p.tenKhac = field(f, src, 'ten goi khac', true);
    if (/^(khong|khong co|khong ro)$/.test(fold(p.tenKhac))) p.tenKhac = '';
    const g = /gioi tinh\s*[:：]?\s*(nam|nu)\b/.exec(f); if (g) p.gioiTinh = g[1] === 'nu' ? 'Nữ' : 'Nam';
    p.ngaySinh = dateAfter(f, 'sinh ngay|ngay sinh|ngay,? thang,? nam sinh|sinh');
    const id = /(?:cccd|cmnd|can cuoc(?: cong dan)?|chung minh(?: nhan dan)?|so dinh danh(?: ca nhan)?)[^\d\n]{0,40}(\d{9,12})\b/.exec(f); if (id) p.cccd = id[1];
    p.quocTich = field(f, src, 'quoc tich', true);
    p.danToc = field(f, src, 'dan toc', true);
    p.ngheNghiep = field(f, src, 'nghe nghiep', true);
    p.hktt = field(f, src, 'noi (?:dang ky )?thuong tru|noi dang ky ho khau thuong tru|ho khau thuong tru|noi dkhktt|hktt|noi cu tru');
    p.choO = field(f, src, 'cho o(?: hien nay| hien tai)?|noi o(?: hien nay| hien tai)?');
    p.tienAn = field(f, src, 'tien an,?\\s*tien su');
    return p;
  }

  function crimeFields(f, src) {
    const o = {};
    const t = /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*[,.]?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|pham vao|xay ra)/d.exec(f)
      || /toi danh\s*[:：]\s*([^\n;]{3,160})/d.exec(f)
      || /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n;.,]{3,120})/d.exec(f);
    if (t) o.toiDanh = clean(src.slice(t.indices[1][0], t.indices[1][1]));
    // Lấy chỗ ghi đầy đủ nhất (có điểm, khoản) trong các lần nhắc tới điều luật.
    const dk = [...f.matchAll(/((?:diem\s+[a-z](?:\s*,\s*[a-z])*\s*,?\s*)?(?:khoan\s+\d+\s*,?\s*)?dieu\s+\d+[a-z]?)\s*(?:cua\s*)?(?:bo luat hinh su|blhs)/gd)]
      .sort((x, y) => y[1].length - x[1].length)[0];
    if (dk) o.dieuKhoan = clean(src.slice(dk.indices[1][0], dk.indices[1][1])).replace(/^./, (c) => c.toUpperCase());
    return o;
  }

  const TYPES = [
    ['kldtbs', /ban ket luan dieu tra bo sung|ket luan dieu tra bo sung/], ['kldt', /ban ket luan dieu tra/],
    ['giahan', /quyet dinh gia han tam giam/], ['ktbc', /quyet dinh khoi to bi can/], ['ktva', /quyet dinh khoi to vu an/],
    ['tamgiam', /lenh tam giam|lenh bat bi can de tam giam/], ['tamgiu', /quyet dinh tam giu/], ['camdi', /lenh cam di khoi noi cu tru/],
  ];
  const WORDNUM = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };

  function commonFields(f, src) {
    const o = {};
    let type = ''; let pos = Infinity;
    for (const [k, re] of TYPES) { const m = re.exec(f); if (m && m.index < pos) { pos = m.index; type = k; } }
    const so = /\bso\s*[:：]\s*(\S*\d\S*)/d.exec(f);
    const docSo = so ? clean(src.slice(so.indices[1][0], so.indices[1][1])) : '';
    const dn = /ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/.exec(f);
    const docNgay = dn ? mkDate(dn[1], dn[2], dn[3]) : '';

    const ref = (name) => {
      const m = new RegExp(`${name}\\s*so\\s*[:：]?\\s*(\\S*\\d\\S*)[\\s\\S]{0,60}?ngay\\s*${DATE}`, 'd').exec(f);
      return m ? [clean(src.slice(m.indices[1][0], m.indices[1][1])), mkDate(m[2], m[3], m[4])] : null;
    };
    const va = ref('quyet dinh khoi to vu an(?: hinh su)?'); if (va) { o.soQDKTVA = va[0]; o.ngayKTVA = va[1]; }
    const bc = ref('quyet dinh khoi to bi can'); if (bc) { o.soQDKTBC = bc[0]; o.ngayKTBC = bc[1]; }

    // Thời hạn: "từ ngày … đến ngày …", hoặc "N tháng kể từ ngày …".
    let tu = ''; let den = '';
    const r = new RegExp(`tu\\s*ngay\\s*${DATE}[\\s\\S]{0,40}?den\\s*(?:het\\s*)?(?:ngay\\s*)?${DATE}`).exec(f);
    if (r) { tu = mkDate(r[1], r[2], r[3]); den = mkDate(r[4], r[5], r[6]); } else {
      const s = new RegExp(`ke\\s*tu\\s*ngay\\s*${DATE}`).exec(f);
      const d = /(?:thoi han|trong han|trong thoi han)[^\n\d]{0,30}?(\d+|mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s*(?:\([^)]*\)\s*)?(thang|ngay)/.exec(f);
      if (s) tu = mkDate(s[1], s[2], s[3]);
      if (tu && d) { const n = WORDNUM[d[1]] || parseInt(d[1], 10); if (n > 0) den = addDays(tu, (d[2] === 'thang' ? 30 * n : n) - 1); }
    }

    if (type === 'ktbc') { if (docSo) o.soQDKTBC = docSo; if (docNgay) o.ngayKTBC = docNgay; }
    if (type === 'ktva') { if (docSo) o.soQDKTVA = docSo; if (docNgay) o.ngayKTVA = docNgay; }
    if (type === 'tamgiam' || type === 'tamgiu' || type === 'camdi') {
      o.bienPhap = type; if (docSo) o.soLenh = docSo; if (tu) o.tgTu = tu; if (den) o.tgDen = den;
    }
    if (type === 'giahan') { o.bienPhap = 'tamgiam'; o.giaHan = [{ so: docSo, loai: '', tu, den }]; }
    if (!type && tu) { o.tgTu = tu; if (den) o.tgDen = den; }
    if (type === 'kldt') { if (docSo) o.soKLDT = docSo; if (docNgay) o.ngayKLDT = docNgay; }
    if (type === 'kldtbs') o.dtbs = [{ so: docSo, ngayKL: docNgay }];
    o.docType = type;

    const ng = /(tr[aạ]i t[aạ]m giam|nh[aà] t[aạ]m gi[uữ]|trai tam giam|nha tam giu|co so giam giu)[^\n,;.]{0,60}/d.exec(f);
    if (ng) o.noiGiam = clean(src.slice(ng.indices[0][0], ng.indices[0][1])).replace(/^./, (c) => c.toUpperCase());
    const nb = new RegExp(`(?:bi bat|bat giu|bat qua tang|bi tam giu|tam giu)[^\\n\\d]{0,25}?ngay\\s*${DATE}`).exec(f);
    if (nb) o.ngayBat = mkDate(nb[1], nb[2], nb[3]);
    // Tên vụ án: phần đứng sau "(khởi tố) vụ án hình sự …" cho tới hết câu, bỏ đoạn viện dẫn điều luật.
    for (const m of f.matchAll(/vu an(?: hinh su)?[ ]*[:：]?[ ]*(?:ve toi[ ]*[:：]?[ ]*)?(["“”']?[^\n;]{6,240})/gd)) {
      const a = m.indices[1][0]; let b = m.indices[1][1]; const seg = f.slice(a, b);
      if (/^["“”']?\s*(so|ngay|nay|tren|do|va|theo|de|nhu|cho|den|duoc|co|khong|thuoc|noi tren|hinh su)\b|^\d/.test(seg)) continue;
      const cut = /(?<!\b(?:tp|tx|tt|q|p|h|x|kp))\.(?:\s|$)|,?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|can cu)\b/.exec(seg);
      if (cut) b = a + cut.index;
      const raw = src.slice(a, b); const name = clean(raw.replace(/["“”]/g, ' '));
      if (name.length < 6) continue;
      o.vuAn = name;
      const q = /^\s*["“”']\s*([^"“”']{3,120})["“”']/.exec(raw); if (q) o.toiDanhVuAn = clean(q[1]);
      break;
    }
    o.dtv = titleCase(field(f, src, 'dieu tra vien(?: thu ly)?', true));
    o.ksv = titleCase(field(f, src, 'kiem sat vien(?: thu ly)?', true));
    return o;
  }

  const NAME_RE = 'ho\\s*(?:va\\s*)?ten(?:\\s*(?:bi can|bi cao|khai sinh))?\\s*[:：]\\s*([^\\n;]*)';
  function nameFrom(f, src, a, b) {
    const cut = LABELS.exec(f.slice(a, b)); if (cut && cut.index > 0) b = a + cut.index;
    // Bộ đọc chữ hay nhầm họ NGUYỄN thành NGUYÊN.
    return titleCase(clean(src.slice(a, b).split(/[,.(]/)[0])).replace(/^Nguy[êeế]n(?=\s)/, 'Nguyễn');
  }

  // Nối các dòng bị ngắt do hết chiều ngang trang: dòng dài gần hết khổ, chưa kết thúc câu,
  // và dòng sau không mở đầu bằng một nhãn (Họ tên:, Quốc tịch:…).
  function unwrap(t) {
    const lines = t.split('\n').map((l) => l.trim());
    const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
    if (lens.length < 3) return lines.join('\n');
    const full = lens[Math.floor(lens.length * 0.9)];
    let out = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]; const cur = lines[i];
      const startsLabel = /^(\d+[.)]\s*)?(ho\s*(va\s*)?ten|ten goi khac|gioi tinh|sinh ngay|ngay sinh|quoc tich|dan toc|ton giao|nghe nghiep|trinh do|noi |cho o|so cccd|cccd|cmnd|can cuoc|tien an|dieu \d|can cu|so\s*:)/.test(fold(cur));
      const join = prev && cur && prev.length >= full * 0.75 && !/[.;:]$/.test(prev) && !startsLabel;
      out += (join ? ' ' : '\n') + cur;
    }
    return out;
  }

  function parse(text) {
    const src = unwrap(String(text || '').normalize('NFC').replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' '));
    const f = fold(src);
    const common = Object.assign(commonFields(f, src), crimeFields(f, src));
    const type = common.docType || ''; delete common.docType;
    if (!common.toiDanh && common.toiDanhVuAn) common.toiDanh = common.toiDanhVuAn;
    delete common.toiDanhVuAn;
    const marks = [...f.matchAll(new RegExp(NAME_RE, 'gd'))].filter((m) => m.indices[1][1] > m.indices[1][0]);
    const persons = [];
    if (marks.length) {
      marks.forEach((m, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].index : f.length;
        const sf = f.slice(m.index, end); const ss = src.slice(m.index, end);
        const p = { hoTen: nameFrom(f, src, m.indices[1][0], m.indices[1][1]) };
        Object.assign(p, personFields(sf, ss));
        // Tội danh riêng của từng người (nếu có) ưu tiên hơn tội danh chung của văn bản.
        if (marks.length > 1) Object.assign(p, crimeFields(sf, ss));
        persons.push(p);
      });
    } else {
      const m = /(?:khoi to bi can|tam giam|tam giu|bat bi can de tam giam|gia han tam giam)\s*doi voi\s*(?:bi can|ong|ba)?\s*[:：]?\s*([^\n,;:(]{3,60})/d.exec(f);
      const p = m ? { hoTen: nameFrom(f, src, m.indices[1][0], m.indices[1][1]) } : {};
      Object.assign(p, personFields(f, src));
      persons.push(p);
    }
    const out = persons.map((p) => {
      const r = {};
      for (const [k, v] of Object.entries(Object.assign({}, common, p))) if (v && (!Array.isArray(v) || v.length)) r[k] = v;
      return r;
    }).filter((r) => Object.keys(r).length);
    return { persons: out, text: src, type, common };
  }

  async function dispose() { if (worker) { const w = worker; worker = null; try { await w.terminate(); } catch (e) { /* bỏ qua */ } } }

  return { read, parse, dispose };
})();
