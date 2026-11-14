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
  // Đưa ảnh về cỡ vừa cho bộ đọc chữ: cạnh dài tối đa 2800 px, ảnh nhỏ thì phóng lên (tối đa 2 lần).
  function toCanvas(img) {
    const w = img.naturalWidth || img.width; const h = img.naturalHeight || img.height;
    const long = Math.max(w, h);
    const k = long > 2800 ? 2800 / long : long < 1900 ? Math.min(2, 1900 / long) : 1;
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    return enhance(c);
  }
  // Làm sạch ảnh chụp trước khi đọc chữ:
  //  - chỉ lấy kênh đỏ: mực dấu đỏ gần như biến mất, chữ đen và chữ ký mực xanh vẫn đậm;
  //  - chia cho độ sáng nền quanh đó để xoá bóng đổ, ánh sáng không đều;
  //  - vùng nền tối ngoài trang giấy (mặt bàn) thành trắng.
  function enhance(c) {
    const g = c.getContext('2d'); const w = c.width; const h = c.height;
    let im; try { im = g.getImageData(0, 0, w, h); } catch (e) { return c; }
    const d = im.data; const n = w * h; const gray = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = d[j];
    const B = 32; const bw = Math.ceil(w / B); const bh = Math.ceil(h / B); const bg = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let m = 0; const y1 = Math.min(h, (by + 1) * B); const x1 = Math.min(w, (bx + 1) * B);
      for (let y = by * B; y < y1; y += 2) for (let x = bx * B, o = y * w + x; x < x1; x += 2, o += 2) if (gray[o] > m) m = gray[o];
      bg[by * bw + bx] = m;
    }
    // làm mượt nền theo ô 3x3
    const sm = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let t = 0; let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = by + dy; const xx = bx + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { t += bg[yy * bw + xx]; k++; } }
      sm[by * bw + bx] = t / k;
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(bh - 1, y0 + 1); const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(bw - 1, x0 + 1); const tx = fx - x0;
        const b = (sm[y0 * bw + x0] * (1 - tx) + sm[y0 * bw + x1] * tx) * (1 - ty) + (sm[y1 * bw + x0] * (1 - tx) + sm[y1 * bw + x1] * tx) * ty;
        const i = y * w + x; let v = b < 95 ? 255 : (gray[i] * 255) / b;
        v = (v - 70) * (255 / 150); v = v < 0 ? 0 : v > 255 ? 255 : v;   // tăng tương phản
        const j = i * 4; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    return c;
  }
  async function ocr(canvas, label, onProgress) {
    const w = await getWorker();
    report = (m) => { if (m.status === 'recognizing text') onProgress(`${label}: đang đọc chữ ${Math.round(m.progress * 100)}%`); else onProgress(`${label}: đang chuẩn bị bộ đọc chữ…`); };
    const { data } = await w.recognize(canvas, { rotateAuto: true });
    return data.text || '';
  }
  // Trả về chữ của từng trang (mỗi trang một phần tử).
  async function readPdfPages(file, onProgress) {
    const pdfjs = await getPdf();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = Math.min(doc.numPages, 60); const out = [];
    for (let i = 1; i <= n; i++) {
      const label = `Trang ${i}/${n}`;
      onProgress(`${label}: đang mở…`);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
      // Trang scan (không có lớp chữ), hoặc lớp chữ hỏng (phông chữ cũ VNI/TCVN3, lớp chữ do máy scan nhận dạng sai):
      // khi không thấy các từ tiếng Việt quen thuộc thì vẽ trang ra ảnh và tự đọc chữ.
      const ft = fold(text);
      const hits = ['cong hoa', 'doc lap', 'quyet dinh', 'can cu', 'dieu', 'ngay', 'thang', 'nam', 'so', 'ho ten', 'bi can', 'vu an', 'hinh su'].filter((k) => new RegExp('\\b' + k + '\\b').test(ft)).length;
      if (text.replace(/\s/g, '').length < 40 || hits < 3) {
        const layer = text;
        // Trang scan (không có lớp chữ): vẽ ra ảnh rồi đọc chữ.
        const v0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(3, 2400 / Math.max(v0.width, v0.height)) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        text = await ocr(enhance(c), label, onProgress);
        if (text.replace(/\s/g, '').length < layer.replace(/\s/g, '').length / 4) text = layer;   // đọc ảnh còn kém hơn thì giữ lớp chữ
      }
      out.push(text);
    }
    return out;
  }
  async function readPdf(file, onProgress) { return (await readPdfPages(file, onProgress)).join('\n'); }
  async function read(files, onProgress = () => {}) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) out.push(await readPdf(f, onProgress));
      else out.push(await ocr(toCanvas(await fileToImage(f)), files.length > 1 ? `Ảnh ${i + 1}/${files.length}` : 'Ảnh', onProgress));
    }
    return out.join('\n');
  }

  // Đọc và tách thành từng văn bản: mỗi PDF là một văn bản; ảnh có phần đầu văn bản ("Số: …", tên loại văn bản)
  // mở đầu một văn bản mới, ảnh không có thì là trang tiếp theo của văn bản trước.
  // Trang mở đầu một văn bản mới: có quốc hiệu, dòng "Số:", hoặc tên loại văn bản ở phần đầu trang.
  function startsDoc(text) {
    const head = fold(text.slice(0, 700));
    return /cong hoa xa hoi chu nghia|doc lap\s*-\s*tu do/.test(head) || /\bso\s*[:：]/.test(head.slice(0, 400)) || TYPES.some(([, re]) => new RegExp(re.source.replace(/ /g, '\\s*')).test(head));
  }
  async function readDocs(files, onProgress = () => {}) {
    const docs = [];
    const push = (name, text, group) => {
      const last = docs[docs.length - 1];
      if (!startsDoc(text) && last && last.group === group) { last.text += '\n' + text; last.to = name; } else docs.push({ name, text, group });
    };
    for (let i = 0; i < files.length; i++) {
      const f = files[i]; const label = files.length > 1 ? `Tệp ${i + 1}/${files.length}` : 'Ảnh';
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        // Một tệp PDF có thể chứa nhiều văn bản: tách theo trang, trang không có phần đầu văn bản là trang tiếp theo.
        const pages = await readPdfPages(f, (m) => onProgress(files.length > 1 ? `${label} — ${m}` : m));
        pages.forEach((t, k) => push(pages.length > 1 ? `${f.name} — trang ${k + 1}` : f.name, t, 'pdf' + i));
      } else push(f.name, await ocr(toCanvas(await fileToImage(f)), label, onProgress), 'img');
    }
    return docs.map((d) => ({ name: d.to ? `${d.name} → ${d.to.replace(/^.* — /, '')}` : d.name, text: d.text }));
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
  // "tháng", "năm" hay bị đọc sai một chữ (thúng, nam, nãm…) nên so khớp lỏng.
  const THANG = 'th[a-z]{1,3}g'; const NAM = 'n[a-z]{1,2}m';
  const DATE = `(\\d{1,2})[\\s.…]*(?:[\\/\\-]|${THANG})[\\s.…]*(\\d{1,2})[\\s.…]*(?:[\\/\\-]|${NAM})[\\s.…]*(\\d{4})`;
  function mkDate(d, m, y) {
    d = +d; m = +m; y = +y;
    if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100)) return '';
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  const clean = (v) => {
    let t = String(v || '').replace(/(^|\s)['‘’`´](?=\p{L})/gu, '$1')          // dấu nháy lạc do đọc nhầm
      .replace(/\s+/g, ' ').replace(/^[\s:;.,…\-–—"“”'(]+|[\s:;.,…\-–—"“”'(]+$/g, '').trim();
    if ((t.match(/["“”]/g) || []).length === 1) t = /["“”]$/.test(t) ? t.slice(0, -1) : t + '"';   // ngoặc kép lẻ
    return t;
  };
  function titleCase(s) {
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
  }
  const LABELS = /\b(ho\s*(va\s*)?ten|ten goi khac|gioi tinh|noi tam tru|noi o hien tai|noi lam viec|trinh do hoc van|cap ngay|noi cap|the cccd|the cc|nam sinh|tuoi|dia chi|sinh ngay|ngay sinh|ngay,? thang,? nam sinh|sinh nam|nam sinh|noi sinh|que quan|quoc tich|dan toc|ton giao|nghe nghiep|trinh do|noi (dang ky )?thuong tru|noi cu tru|noi dkhktt|hktt|ho khau thuong tru|cho o|noi o|so cccd|cccd|cmnd|can cuoc|chung minh|so dinh danh|tien an|tien su|con ong|con ba|ho ten cha|ho ten me|bi bat|bi khoi to|hien dang)\b/;

  // Tìm "nhãn: giá trị". short=true thì cắt thêm ở dấu phẩy / chấm.
  function field(f, src, labels, short, raw) {
    // [ \t]* (không phải \s*): ô để trống thì không được lấy nhầm dòng bên dưới.
    const re = new RegExp(`(?:${labels})[ \\t]*[:：][ \\t]*([^\\n;]*)`, 'd');
    const m = re.exec(f); if (!m) return '';
    let [a, b] = m.indices[1];
    if (raw) return clean(src.slice(a, b));
    const cut = LABELS.exec(f.slice(a, b)); if (cut) b = a + cut.index;
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
    p.tienAn = field(f, src, 'tien an\\s*[,\\/\\-–]?\\s*tien su', false, true);
    return p;
  }

  // Tên tội danh chuẩn (chương tội phạm về ma túy và một số tội thường gặp): bộ đọc chữ hay sai dấu
  // ("Tầng trữ", "Mua bản"), so khớp không dấu rồi trả về cách viết đúng.
  const CRIMES = ['Trồng cây thuốc phiện, cây côca, cây cần sa hoặc các loại cây khác có chứa chất ma túy', 'Sản xuất trái phép chất ma túy', 'Tàng trữ trái phép chất ma túy',
    'Vận chuyển trái phép chất ma túy', 'Mua bán trái phép chất ma túy', 'Chiếm đoạt chất ma túy', 'Tàng trữ, vận chuyển, mua bán hoặc chiếm đoạt tiền chất dùng vào việc sản xuất trái phép chất ma túy',
    'Sản xuất, tàng trữ, vận chuyển hoặc mua bán phương tiện, dụng cụ dùng vào việc sản xuất hoặc sử dụng trái phép chất ma túy', 'Tổ chức sử dụng trái phép chất ma túy',
    'Chứa chấp việc sử dụng trái phép chất ma túy', 'Cưỡng bức người khác sử dụng trái phép chất ma túy', 'Lôi kéo người khác sử dụng trái phép chất ma túy',
    'Vi phạm quy định về quản lý chất ma túy, tiền chất, thuốc gây nghiện, thuốc hướng thần', 'Tàng trữ, vận chuyển trái phép chất ma túy', 'Mua bán, vận chuyển trái phép chất ma túy',
    'Tàng trữ, mua bán trái phép chất ma túy', 'Trộm cắp tài sản', 'Cướp tài sản', 'Cướp giật tài sản', 'Cố ý gây thương tích', 'Giết người', 'Lừa đảo chiếm đoạt tài sản',
    'Lạm dụng tín nhiệm chiếm đoạt tài sản', 'Đánh bạc', 'Tổ chức đánh bạc', 'Gây rối trật tự công cộng', 'Chống người thi hành công vụ', 'Tàng trữ, vận chuyển, sử dụng trái phép vũ khí quân dụng'];
  const squash = (v) => fold(v).replace(/[^a-z0-9]+/g, ' ').trim();
  const CRIME_MAP = new Map(CRIMES.map((c) => [squash(c), c]));
  function fixCrime(v) {
    const k = squash(v); if (CRIME_MAP.has(k)) return CRIME_MAP.get(k);
    // sai 1–2 chữ cái do đọc nhầm: chọn tên chuẩn gần nhất nếu đủ giống
    let best = ''; let bd = 3;
    for (const [ck, c] of CRIME_MAP) { if (Math.abs(ck.length - k.length) > 2) continue; const d = lev(ck, k, 2); if (d < bd) { bd = d; best = c; } }
    return best || v;
  }
  function lev(a, b, max) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < rowMin) rowMin = cur[j]; }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // Viết lại điều khoản từ bản không dấu để khỏi dính lỗi dấu ("Khoán 1 Điều 249").
  function fixClause(k) {
    const d = /diem\s+([a-z](?:\s*,\s*[a-z])*)/.exec(k); const kh = /kho[a-z]n\s+(\d+)/.exec(k); const dieu = /di[a-z]u\s+(\d+[a-z]?)/.exec(k);
    if (!dieu) return '';
    const out = [d ? `điểm ${d[1].replace(/\s+/g, '')}` : '', kh ? `khoản ${kh[1]}` : '', `Điều ${dieu[1]}`].filter(Boolean).join(' ');
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  const joinList = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' và ' + a[a.length - 1]);
  // Các tội danh chuẩn xuất hiện trong một đoạn văn, theo thứ tự xuất hiện (một người có thể bị khởi tố nhiều tội).
  function crimesIn(seg) {
    const z = ' ' + squash(seg) + ' '; const hits = [];
    for (const [k, name] of CRIME_MAP) { let i = z.indexOf(' ' + k + ' '); while (i >= 0) { hits.push({ i, len: k.length, name }); i = z.indexOf(' ' + k + ' ', i + 1); } }
    hits.sort((a, b) => b.len - a.len);
    const keep = [];
    for (const h of hits) if (!keep.some((x) => h.i < x.i + x.len && x.i < h.i + h.len)) keep.push(h);
    return [...new Set(keep.sort((a, b) => a.i - b.i).map((x) => x.name))];
  }
  function clausesIn(seg) {
    const out = [];
    for (const m of seg.matchAll(/(?:diem\s+[a-z](?:\s*,\s*[a-z])*\s*,?\s*)?(?:kho[a-z]n\s+\d+\s*,?\s*)?di[a-z]u\s+\d+[a-z]?/g)) { const c = fixClause(m[0]); if (c && !out.includes(c)) out.push(c); }
    return out;
  }
  function crimeFields(f, src) {
    const o = {};
    // Vùng nói về tội danh của bị can: ưu tiên câu "đối với <tên> … về tội …", rồi "đã có hành vi …", rồi "về tội …" bất kỳ.
    // Vùng kéo tới "Bộ luật Hình sự" để lấy luôn điều khoản; một người có thể có nhiều tội, nhiều điều khoản.
    const starts = [
      /doi voi[^\n;]{3,70}?,?\s*(?:bi khoi to\s*)?ve toi(?!\s*pham\b)/,
      /da co hanh vi/,
      /ve toi(?!\s*pham\b)/,
      /dau hieu toi pham\s*[:：]/,
      /hanh vi pham toi/,
      /toi danh\s*[:：]/,
    ];
    for (const re of starts) {
      // Trong các chỗ khớp, chọn chỗ ghi điều khoản đầy đủ nhất (câu về bị can thường có điểm, khoản; câu về vụ án chỉ có điều).
      let best = null;
      for (const m of f.matchAll(new RegExp(re.source, 'g'))) {
        if (/ti[a-z]n\s*(?:an|su)[^\n]{0,25}$/.test(f.slice(Math.max(0, m.index - 30), m.index + 6))) continue;   // "01 tiền án về tội …" không phải tội danh của vụ này
        const a = m.index + m[0].length; const rest = f.slice(a, a + 480);
        const end = /bo luat hinh su|blhs/.exec(rest);
        const zone = end ? rest.slice(0, end.index) : rest.split(/\.\s|;\s*\n|\n\s*\n/)[0].slice(0, 220);
        const names = crimesIn(zone); if (!names.length) continue;
        const cl = clausesIn(zone); const score = joinList(cl).length;
        if (!best || score > best.score) best = { names, cl, score };
      }
      if (best) { o.toiDanh = joinList(best.names); if (best.cl.length) o.dieuKhoan = joinList(best.cl); break; }
    }
    if (!o.toiDanh) {
      const t = /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*[,.]?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|pham vao|xay ra)/d.exec(f)
        || /dau hieu toi pham\s*[:：]\s*["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*[,.]?\s*(?:quy dinh tai|theo quy dinh)/d.exec(f)
        || /da co hanh vi\s*(?:pham toi\s*)?["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*(?:[.;]|,?\s*quy dinh tai|pham vao)/d.exec(f)
        || /toi danh\s*[:：]\s*([^\n;]{3,160})/d.exec(f)
        || /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n;.,]{3,120})/d.exec(f);
      if (t) o.toiDanh = fixCrime(clean(src.slice(t.indices[1][0], t.indices[1][1]).replace(/["“”]/g, ' ')));
    }
    if (!o.dieuKhoan) {
      // Lấy chỗ ghi đầy đủ nhất (có điểm, khoản) trong các lần nhắc tới điều luật.
      const dk = [...f.matchAll(/((?:diem\s+[a-z](?:\s*,\s*[a-z])*\s*,?\s*)?(?:kho[a-z]n\s+\d+\s*,?\s*)?di[a-z]u\s+\d+[a-z]?)\s*(?:cua\s*)?(?:bo luat hinh su|blhs)/g)]
        .sort((x, y) => y[1].length - x[1].length)[0];
      if (dk) o.dieuKhoan = fixClause(dk[1]);
    }
    // Tội danh của VỤ ÁN ghi ngay sau số quyết định khởi tố vụ án ("… số B123 ngày …, về tội “…”").
    const va = /quyet dinh khoi to vu an(?: hinh su)?\s*so[^;]{0,200}?ve toi(?!\s*pham\b)([^;]{3,200})/.exec(f);
    if (va) { const n = crimesIn(va[1].split(/quy dinh tai|theo/)[0]); if (n.length) o.toiDanhVA = joinList(n); }
    return o;
  }

  // Loại văn bản, nhận theo tiêu đề viết HOA. Thứ tự quan trọng: tên dài hơn đứng trước
  // ("phê chuẩn quyết định khởi tố bị can" trước "quyết định khởi tố bị can").
  const TYPES = [
    ['pclenh', /phe chuan lenh (?:bat bi can de )?tam giam|phe chuan lenh bat/], ['pcktbc', /phe chuan quyet dinh khoi to bi can/],
    ['bbbat', /bien ban bat bi can de tam giam|bien ban bat nguoi/], ['pcdtv', /quyet dinh phan cong dieu tra vien/],
    ['lylich', /ly lich ca nhan|ly lich bi can/],
    ['kldtbs', /ban ket luan dieu tra bo sung|ket luan dieu tra bo sung/], ['kldt', /ban ket luan dieu tra/],
    ['tdc', /quyet dinh tam dinh chi/], ['dc', /quyet dinh dinh chi/],
    ['giahan', /quyet dinh gia han tam giam/], ['ktbc', /quyet dinh khoi to bi can/], ['ktva', /quyet dinh khoi to vu an/],
    ['tamgiam', /lenh tam giam|lenh bat bi can de tam giam/], ['tamgiu', /quyet dinh tam giu/], ['camdi', /lenh cam di khoi noi cu tru/],
  ];
  // Văn bản mà số, ngày của các quyết định được IN (không viết tay): văn bản của Viện kiểm sát, biên bản, công văn.
  const PRINTED = ['pclenh', 'pcktbc', 'bbbat', ''];
  const RANKS = '(?:dai uy|thuong uy|trung uy|thieu uy|thieu ta|trung ta|thuong ta|dai ta)';
  // Số văn bản hợp lệ: B123, 27/QĐ-CSMT, B12345/LB-CSMT… (loại ký tự rác do đọc chữ viết tay).
  const validSo = (v) => /^[A-Za-zĐ]?\d{1,6}(\/[\p{L}\d\-.]+)?$/u.test(v) && !/\/(ĐN|DN|CV)\b/i.test(v) && !/VKSTC|TT-|TTLT/i.test(v);
  // Tiêu đề chuẩn của từng loại văn bản (không dấu) để so khớp gần đúng với dòng tiêu đề viết hoa.
  const TITLE_LIST = [['pclenh', 'phe chuan lenh bat bi can de tam giam'], ['pclenh', 'phe chuan lenh tam giam'], ['pcktbc', 'phe chuan quyet dinh khoi to bi can'],
    ['bbbat', 'bien ban bat bi can de tam giam'], ['pcdtv', 'quyet dinh phan cong dieu tra vien'], ['lylich', 'ly lich ca nhan'], ['lylich', 'ly lich bi can'],
    ['kldtbs', 'ban ket luan dieu tra bo sung'], ['kldt', 'ban ket luan dieu tra'], ['tdc', 'quyet dinh tam dinh chi'], ['dc', 'quyet dinh dinh chi'],
    ['giahan', 'quyet dinh gia han tam giam'], ['ktbc', 'quyet dinh khoi to bi can'], ['ktva', 'quyet dinh khoi to vu an'],
    ['tamgiam', 'lenh bat bi can de tam giam'], ['tamgiam', 'lenh tam giam'], ['tamgiu', 'quyet dinh tam giu'], ['camdi', 'lenh cam di khoi noi cu tru']];
  // Khoảng cách sửa nhỏ nhất giữa mẫu và một đoạn bất kỳ của chuỗi (để chịu được vài chữ đọc sai trong tiêu đề).
  function approxSub(text, pat) {
    let prev = new Array(text.length + 1).fill(0);
    for (let i = 1; i <= pat.length; i++) {
      const cur = [i];
      for (let j = 1; j <= text.length; j++) cur[j] = Math.min(prev[j - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
      prev = cur;
    }
    return Math.min(...prev);
  }
  // Tìm loại văn bản theo dòng tiêu đề viết hoa ở phần đầu trang; trả về { type, pos }.
  function detectType(f, src) {
    const lines = []; let off = 0;
    for (const line of src.split('\n')) { lines.push({ line, off }); off += line.length + 1; }
    const isUpper = (t) => { const L = t.replace(/[^\p{L}]/gu, ''); if (L.length < 6) return false; let u = 0; for (const ch of L) if (ch === ch.toUpperCase()) u++; return u / L.length >= 0.8; };
    const cand = lines.filter((x) => x.line.trim()).slice(0, 30);
    let best = null;
    for (let i = 0; i < cand.length; i++) {
      if (!isUpper(cand[i].line)) continue;
      const one = squash(cand[i].line); const two = i + 1 < cand.length && isUpper(cand[i + 1].line) ? one + ' ' + squash(cand[i + 1].line) : one;
      for (const [k, t] of TITLE_LIST) {
        const lim = t.length >= 20 ? 3 : t.length >= 12 ? 2 : 1;
        const d = Math.min(approxSub(one, t), approxSub(two, t));
        if (d > lim) continue;
        if (!best || t.length - d * 2 > best.score) best = { type: k, pos: cand[i].off, score: t.length - d * 2 };
      }
      if (best) break;   // tiêu đề là dòng viết hoa khớp đầu tiên
    }
    return best || { type: '', pos: Infinity };
  }
  const WORDNUM = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };

  function commonFields(f, src) {
    const o = {};
    let { type, pos } = detectType(f, src);
    if (!type) {
      for (const [k, re] of TYPES) {
        // cho phép các từ trong tiêu đề bị đọc dính liền hoặc cách xa nhau
        for (const m of f.matchAll(new RegExp(re.source.replace(/ /g, '\\s*'), 'g'))) {
          const t = src.slice(m.index, m.index + m[0].length);
          if (t !== t.toUpperCase()) continue;            // chỉ nhận tiêu đề viết hoa, không nhận câu nhắc tới văn bản khác
          if (m.index < pos) { pos = m.index; type = k; }
          break;
        }
      }
    }
    // Số và ngày của chính văn bản nằm ở phần đầu (trước tên loại văn bản / trước "Căn cứ"),
    // không lấy nhầm số của quyết định được viện dẫn bên dưới, cũng không lấy "Mẫu số", "TT số" ở góc trang.
    const cc = f.search(/\bcan cu\b/);
    const headEnd = Math.min(pos === Infinity ? 700 : pos + 60, cc > 40 ? cc : Infinity, f.length);
    const qh = f.search(/c[a-z]ng\s*h[a-z]a\s*xa\s*h[a-z]i/);
    const headStart = qh > 0 && qh < headEnd ? f.lastIndexOf('\n', qh) + 1 : 0;
    const head = ' '.repeat(headStart) + f.slice(headStart, headEnd);   // giữ nguyên vị trí ký tự so với văn bản gốc
    let docSo = '';
    for (const m of head.matchAll(/\bs[o0]\s*[:：;.]?[\s.…]*([a-z]{0,2}\d{1,6})[\s.…]*\/[\s.…]*([^\s,;]+)|(?:^|[\s.…])(\d{1,6})[\s.…]*\/[\s.…]*((?:qd|ltg|lbtg|lb|lcd|kl|kldt|tb|l)[^\s,;]*)|\bs[o0]\s*[:：]\s*([a-z]{0,2}\d{1,6})(?=\s|$)/gd)) {
      if (/(mau|tt|thong tu|theo)\s*$/.test(head.slice(Math.max(0, m.index - 12), m.index).trim() + ' ') || /(mau|tt|thong tu)\s*$/.test(head.slice(Math.max(0, m.index - 10), m.index))) continue;
      const pick = (i) => (m.indices[i] ? src.slice(m.indices[i][0], m.indices[i][1]) : '');
      const v = (m[1] ? `${pick(1)}/${clean(pick(2))}` : m[3] ? `${pick(3)}/${clean(pick(4))}` : pick(5)).replace(/\s+/g, '');
      if (validSo(v) && !/^\d+\/\d{4}\//.test(v)) { docSo = v; break; }
    }
    const NGAY = new RegExp(`ngay[\\s.…]*(\\d{1,2})[\\s.…]*${THANG}[\\s.…]*(\\d{1,2})[\\s.…]*${NAM}[\\s.…]*(\\d{4})`);
    // Ngày của văn bản chỉ lấy ở phần đầu; ngày viết tay không đọc được thì để trống (không lấy nhầm ngày sinh…).
    const dn = NGAY.exec(head.replace(/ngay\s*\d{1,2}\/\d{1,2}\/\d{4}/g, (x) => ' '.repeat(x.length)));
    const docNgay = dn ? mkDate(dn[1], dn[2], dn[3]) : '';

    // Số, ngày của quyết định được viện dẫn: "Quyết định khởi tố bị can số B1234 ngày 01 tháng 6 năm 2026".
    // Ưu tiên chỗ "Phê chuẩn … số …" (Điều 1), bỏ chỗ "đề nghị phê chuẩn … số …" (số của công văn đề nghị).
    const ref = (name) => {
      let best = null;
      for (const m of f.matchAll(new RegExp(`${name}\\s*so\\s*[:：]?\\s*([a-z]{0,2}\\d{1,6}(?:\\s?\\/\\s?[^\\s,;]+)?)(?:[\\s\\S]{0,40}?ngay\\s*${DATE}|[\\s\\S]{0,160}?cung\\s*ngay\\s*${DATE})?`, 'gd'))) {
        const before = f.slice(Math.max(0, m.index - 30), m.index);
        if (/de\s*ngh\S*\s*phe\s*chu\S*\s*$/.test(before)) continue;
        const so = src.slice(m.indices[1][0], m.indices[1][1]).replace(/\s+/g, '').replace(/[.,;:]+$/, '');
        if (!validSo(so)) continue;
        const cand = { so, ngay: m[2] ? mkDate(m[2], m[3], m[4]) : m[5] ? mkDate(m[5], m[6], m[7]) : '', rank: /phe\s*chu\S*\s*$/.test(before) ? 2 : 1 };
        if (!best || cand.rank > best.rank || (cand.rank === best.rank && !best.ngay && cand.ngay)) best = cand;
      }
      return best;
    };
    const va = ref('quyet dinh khoi to vu an(?: hinh su)?'); if (va) { o.soQDKTVA = va.so; if (va.ngay) o.ngayKTVA = va.ngay; }
    const bc = ref('quyet dinh khoi to bi can'); if (bc) { o.soQDKTBC = bc.so; if (bc.ngay) o.ngayKTBC = bc.ngay; }
    const lb = ref('lenh (?:bat bi can de )?tam giam'); if (lb) { o.soLenh = lb.so; o.bienPhap = 'tamgiam'; }

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
    if (type === 'pclenh' || type === 'bbbat') o.bienPhap = 'tamgiam';
    if (type === 'giahan') { o.bienPhap = 'tamgiam'; o.giaHan = [{ so: docSo, loai: '', tu, den }]; }
    if (!type && tu) { o.tgTu = tu; if (den) o.tgDen = den; }
    if (type === 'kldt') { if (docSo) o.soKLDT = docSo; if (docNgay) o.ngayKLDT = docNgay; }
    if (type === 'kldtbs') o.dtbs = [{ so: docSo, ngayKL: docNgay }];
    if (type === 'tdc') { if (docSo) o.soTDC = docSo; if (docNgay) o.ngayTDC = docNgay; }
    if (type === 'dc') { if (docSo) o.soDC = docSo; if (docNgay) o.ngayDC = docNgay; }
    // "trong thời hạn 04 tháng, kể từ ngày bắt được bị can": chưa có ngày, chỉ biết số tháng.
    const th = /thoi han\s*(?:tam giam\s*)?[:：]?\s*0?(\d{1,2})\s*thang/.exec(f); if (th) o.thoiHanThang = Number(th[1]);
    // Biên bản bắt: "Hồi … giờ … ngày … tháng … năm …".
    if (type === 'bbbat') { const h = new RegExp(`\\bhoi\\b[^\\n]{0,40}?ngay\\s*${DATE}`).exec(f); if (h) o.ngayBat = mkDate(h[1], h[2], h[3]); }
    if (PRINTED.includes(type)) o.strong = ['soQDKTVA', 'ngayKTVA', 'soQDKTBC', 'ngayKTBC', 'soLenh'].filter((k) => o[k]);
    o.docType = type;

    const ng = /((?:phan )?trai tam giam|nha tam giu|co so giam giu)[^\n,;.]{0,60}/d.exec(f);
    if (ng) {
      const a = ng.indices[0][0]; let b = ng.indices[0][1];
      const cut = /\s(de|va|theo|ke tu|trong|thuoc|cong an|bo cong an|bo tri|neu tren|thi hanh|[–\-—])\s/.exec(f.slice(a, b)); if (cut && cut.index > 12) b = a + cut.index;
      o.noiGiam = clean(src.slice(a, b)).replace(/^./, (c) => c.toUpperCase());
    }
    const nb = new RegExp(`(?:bi bat|bat giu|bat qua tang|bi tam giu|tam giu)[^\\n\\d]{0,25}?ngay\\s*${DATE}`).exec(f);
    if (nb && !o.ngayBat) o.ngayBat = mkDate(nb[1], nb[2], nb[3]);
    if (!o.ngayBat && o.bienPhap === 'tamgiam' && tu) o.ngayBat = tu;   // lệnh bắt để tạm giam: hạn tính từ ngày bắt
    // Tên vụ án: phần đứng sau "(khởi tố) vụ án hình sự …" cho tới hết câu, bỏ đoạn viện dẫn điều luật.
    for (const m of (type === 'ktva' ? f.matchAll(/khoi to vu an(?: hinh su)?[ ]*[:：]?[ ]*(?:ve toi[ ]*[:：]?[ ]*)?(["“”']?[^\n;]{6,240})/gd) : [])) {
      const a = m.indices[1][0]; let b = m.indices[1][1]; const seg = f.slice(a, b);
      // Bỏ qua tiêu đề văn bản viết hoa (QUYẾT ĐỊNH KHỞI TỐ VỤ ÁN HÌNH SỰ) và dòng chức danh người ký đứng sau nó.
      const lead = src.slice(m.index, a);
      if (lead === lead.toUpperCase() || /^["“”']?\s*((pho )?thu truong|(pho )?truong phong|toi\b|chung toi|co quan|cong an|vien kiem sat)/.test(seg)) continue;
      if (/^["“”']?\s*(so|ngay|nay|tren|do|va|theo|de|nhu|cho|den|duoc|co|khong|thuoc|noi tren|hinh su)\b|^\d/.test(seg)) continue;
      const cut = /(?<!\b(?:tp|tx|tt|q|p|h|x|kp))\.(?:\s|$)|,?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|can cu)\b/.exec(seg);
      if (cut) b = a + cut.index;
      const raw = src.slice(a, b); const name = clean(raw.replace(/["“”]/g, ' '));
      if (name.length < 6) continue;
      o.vuAn = name;
      const q = /^\s*["“”']\s*([^"“”']{3,120})["“”']/.exec(raw); if (q) o.toiDanhVuAn = fixCrime(clean(q[1]));
      break;
    }
    // Địa bàn xảy ra: "xảy ra (ngày …) tại <địa bàn>".
    const db = /xay ra[^\n;]{0,60}?\btai\s+([^\n;]{3,140})/d.exec(f);
    if (db) {
      const a = db.indices[1][0]; let b = db.indices[1][1];
      const cut = /(?<!\b(?:tp|tx|tt|q|p|h|x|kp))\.(?:\s|$)|,?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|can cu|vao ngay|ngay \d)/.exec(f.slice(a, b));
      if (cut) b = a + cut.index;
      o.diaBan = clean(src.slice(a, b));
    }
    // Quyết định khởi tố vụ án không có cụm "xảy ra … tại": lấy "tại phường/xã …" đầu tiên trong phần quyết định.
    if (!o.diaBan && type === 'ktva') {
      const t = /\btai\s+((?:phuong|xa|thi tran|dac khu)\s+[^\n,;.]+(?:,\s*(?:thanh pho|tinh|tp|quan|huyen)[^\n,;.]*){0,2})/d.exec(f.slice(pos === Infinity ? 0 : pos));
      if (t) { const off = pos === Infinity ? 0 : pos; o.diaBan = clean(src.slice(off + t.indices[1][0], off + t.indices[1][1])); }
    }
    // Mô tả vụ án trong hồ sơ: "vụ án hình sự <hành vi> phát hiện ngày <ngày> tại <địa bàn> do <đối tượng chính> thực hiện".
    const sig = new RegExp(`vu an(?: hinh su)?[ ]*[:：]?[ ]*["“”']?[ ]*([^\\n"“”']{5,140}?)[ ]*["“”']?\\s*(?:phat hien|xay ra)(?:\\s*vao)?\\s*ngay\\s*${DATE}\\s*tai\\s*([\\s\\S]{5,240}?)\\s+do\\s+([^\\n,.;]{3,60}?)\\s+thuc hien`, 'd').exec(f);
    if (sig) {
      const g = (i) => clean(src.slice(sig.indices[i][0], sig.indices[i][1]));
      o.toiDanhVuAn = fixCrime(g(1)); o.ngayPhatHien = mkDate(sig[2], sig[3], sig[4]); o.diaBan = g(5).replace(/\s*\n\s*/g, ' ');
      const who = titleCase(g(6)); if (isName(who)) o.doiTuong = who;
      if (type === 'ktva' || !o.vuAn) o.vuAn = `${o.toiDanhVuAn} phát hiện tại ${o.diaBan}`;
    }
    // Điều tra viên: người ghi "(thụ lý chính)", hoặc "Tôi: … – Điều tra viên" trong biên bản.
    const dv = new RegExp(`(?:\\d\\s*[.)]\\s*)?(?:${RANKS}\\s+)?([^\\n,–\\-]{4,40}?)\\s*[,–\\-]\\s*dieu tra vien\\s*\\(thu ly chinh\\)`, 'd').exec(f)
      || new RegExp(`\\btoi\\s*[:：]\\s*(?:${RANKS}\\s+)?([^\\n,–\\-]{4,40}?)\\s*[,–\\-]\\s*dieu tra vien`, 'd').exec(f);
    if (dv) { const n = titleCase(clean(src.slice(dv.indices[1][0], dv.indices[1][1]))); if (isName(n)) o.dtv = n; }
    if (!o.dtv) {
      // Lệnh bắt: "Phân công ông: <tên> tổ chức thi hành Lệnh này".
      const pc = new RegExp(`phan cong\\s*(?:ong|ba|dong chi)?\\s*[:：]?\\s*(?:${RANKS}\\s+)?([^\\n,;:]{4,40}?)\\s+to chuc thi hanh`, 'd').exec(f);
      if (pc) { const n = fixSurname(titleCase(clean(src.slice(pc.indices[1][0], pc.indices[1][1])))); if (isName(n)) o.dtv = n; }
    }
    if (!o.dtv) { const n = titleCase(field(f, src, 'dieu tra vien(?: thu ly)?', true)); if (isName(n)) o.dtv = n; }
    const kv = titleCase(field(f, src, 'kiem sat vien(?: thu ly)?', true)); if (isName(kv)) o.ksv = kv;
    return o;
  }

  const NAME_RE = 'ho\\s*(?:va\\s*)?ten(?:\\s*(?:bi can|bi cao|khai sinh))?\\s*[:：]\\s*([^\\n;]*)';
  // Họ tên hợp lệ: 2–7 từ, chỉ gồm chữ cái.
  const isName = (v) => /^[\p{L}]+(?:\s[\p{L}]+){1,6}$/u.test(v) && v.length <= 50;
  // Họ thường gặp: bộ đọc chữ hay sai dấu ở chữ đầu (Đồ/Đỏ → Đỗ, Nguyên → Nguyễn, Tràn → Trần).
  const SURNAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Đinh', 'Đoàn', 'Trương', 'Lương',
    'Trịnh', 'Mai', 'Cao', 'Lâm', 'Tạ', 'Hà', 'Châu', 'Thái', 'Lưu', 'Quách', 'Từ', 'Kiều', 'Tăng', 'Đào', 'Tô', 'Phùng', 'Vương', 'Diệp', 'Thạch', 'Lại', 'Nghiêm', 'Tống', 'Triệu'];
  const SURNAME_MAP = new Map(SURNAMES.map((x) => [fold(x), x]));
  function fixSurname(name) {
    const w = name.split(' '); const k = fold(w[0] || '');
    if (w.length >= 2 && SURNAME_MAP.has(k)) w[0] = SURNAME_MAP.get(k);
    return w.join(' ');
  }
  function nameFrom(f, src, a, b) {
    const cut = LABELS.exec(f.slice(a, b)); if (cut && cut.index > 0) b = a + cut.index;
    // Bộ đọc chữ hay nhầm họ NGUYỄN thành NGUYÊN.
    return fixSurname(titleCase(clean(src.slice(a, b).split(/[,.(]/)[0])));
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
      const join = prev && cur && prev.length >= full * 0.75 && (!/[.;:]$/.test(prev) || /(^|[\s,])(TP|Tp|TX|TT|P|Q|H|X)\.$/.test(prev)) && !startsLabel;
      out += (join ? ' ' : '\n') + cur;
    }
    return out;
  }

  function parse(text) {
    const src = unwrap(String(text || '').normalize('NFC').replace(/Ð/g, 'Đ').replace(/ð/g, 'đ').replace(/[⁄∕／]/g, '/').replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' '));
    const f = fold(src);
    const common = Object.assign(commonFields(f, src), crimeFields(f, src));
    const type = common.docType || ''; delete common.docType;
    const strong = common.strong || []; delete common.strong;
    if (common.toiDanhVuAn && !common.toiDanhVA) common.toiDanhVA = common.toiDanhVuAn;
    if (!common.toiDanh && common.toiDanhVuAn) common.toiDanh = common.toiDanhVuAn;
    delete common.toiDanhVuAn;
    // Quyết định khởi tố vụ án không ghi rõ tên vụ thì ghép tên từ tội danh và địa bàn.
    if (type === 'ktva' && !common.vuAn && common.toiDanh) common.vuAn = common.toiDanh;
    if (type === 'ktva' && common.vuAn) {
      if (!common.toiDanh) common.toiDanh = fixCrime(clean(common.vuAn.split(/\s+xảy ra\b/i)[0]));
      // tên vụ ghép lại từ tội danh đã chuẩn hoá và địa bàn
      if (common.toiDanh && common.diaBan) common.vuAn = common.toiDanh + ' xảy ra tại ' + common.diaBan;
      if (common.diaBan && !/xảy ra/i.test(common.vuAn)) common.vuAn += ' xảy ra tại ' + common.diaBan;
    }
    const marks = [...f.matchAll(new RegExp(NAME_RE, 'gd'))].filter((m) => m.indices[1][1] > m.indices[1][0] && isName(nameFrom(f, src, m.indices[1][0], m.indices[1][1])));
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
      // Không có dòng "Họ tên:": tìm tên sau "đối với (bị can/ông/bà) …", "bị can: …".
      const tryName = (re) => {
        for (const m of f.matchAll(re)) {
          const a = m.indices[1][0]; let b = m.indices[1][1];
          const raw = src.slice(a, b); if (raw === raw.toUpperCase()) continue;       // tiêu đề viết hoa
          const stop = /\s(ve toi|sinh|gioi tinh|la|da|co|bi|thuoc|trong|tai|ve|do|nhu|de|tam giam|tam giu|khoi to)\b/.exec(f.slice(a, b)); if (stop) b = a + stop.index;
          const cand = nameFrom(f, src, a, b);
          // tên người viết hoa chữ đầu mỗi từ
          if (isName(cand) && cand.split(' ').every((w) => w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase())) return cand;
        }
        return '';
      };
      const hoTen = tryName(/doi voi\s*(?:bi can|\(?ong\/ba\)?|ong|ba)?\s*[:：]?\s*([^\n,;:(]{3,60})/gd) || tryName(/(?:bi can|bi cao)\s*[:：]?\s*([^\n,;:(]{3,60})/gd);
      const p = hoTen ? { hoTen } : {};
      Object.assign(p, personFields(f, src));
      persons.push(p);
    }
    const out = persons.map((p) => {
      const r = {};
      for (const [k, v] of Object.entries(Object.assign({}, common, p))) if (v && (!Array.isArray(v) || v.length)) r[k] = v;
      return r;
    }).filter((r) => Object.keys(r).length);
    return { persons: out, text: src, type, common, strong };
  }

  async function dispose() { if (worker) { const w = worker; worker = null; try { await w.terminate(); } catch (e) { /* bỏ qua */ } } }

  return { read, readDocs, parse, dispose, toCanvas, fileToImage };
})();
