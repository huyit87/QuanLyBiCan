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

  // Đọc và tách thành từng văn bản: mỗi PDF là một văn bản; ảnh có phần đầu văn bản ("Số: …", tên loại văn bản)
  // mở đầu một văn bản mới, ảnh không có thì là trang tiếp theo của văn bản trước.
  async function readDocs(files, onProgress = () => {}) {
    const docs = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]; const label = files.length > 1 ? `Tệp ${i + 1}/${files.length}` : 'Ảnh';
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) { docs.push({ name: f.name, text: await readPdf(f, (m) => onProgress(files.length > 1 ? `${label} — ${m}` : m)) }); continue; }
      const text = await ocr(toCanvas(await fileToImage(f)), label, onProgress);
      const head = fold(text.slice(0, 600));
      const starts = /\bso\s*[:：]/.test(head) || TYPES.some(([, re]) => re.test(head)) || /cong hoa xa hoi chu nghia/.test(head);
      const last = docs[docs.length - 1];
      if (!starts && last && last.image) { last.text += '\n' + text; last.name += ', ' + f.name; } else docs.push({ name: f.name, text, image: true });
    }
    return docs;
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
  const LABELS = /\b(ho\s*(va\s*)?ten|ten goi khac|gioi tinh|sinh ngay|ngay sinh|ngay,? thang,? nam sinh|sinh nam|nam sinh|noi sinh|que quan|quoc tich|dan toc|ton giao|nghe nghiep|trinh do|noi (dang ky )?thuong tru|noi cu tru|noi dkhktt|hktt|ho khau thuong tru|cho o|noi o|so cccd|cccd|cmnd|can cuoc|chung minh|so dinh danh|tien an|tien su|con ong|con ba|ho ten cha|ho ten me|vo|chong|bi bat|hien dang)\b/;

  // Tìm "nhãn: giá trị". short=true thì cắt thêm ở dấu phẩy / chấm.
  function field(f, src, labels, short, raw) {
    const re = new RegExp(`(?:${labels})\\s*[:：]\\s*([^\\n;]*)`, 'd');
    const m = re.exec(f); if (!m) return '';
    let [a, b] = m.indices[1];
    if (raw) return clean(src.slice(a, b));
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
    p.tienAn = field(f, src, 'tien an,?\\s*tien su', false, true);
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
  function crimeFields(f, src) {
    const o = {};
    const t = /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*[,.]?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu)|pham vao|xay ra)/d.exec(f)
      || /hanh vi pham toi\s*[:：]?\s*["“”']?\s*([^\n]{3,160}?)\s*["“”']?\s*[,.]?\s*(?:quy dinh tai|theo quy dinh|theo (?:diem|khoan|dieu))/d.exec(f)
      || /toi danh\s*[:：]\s*([^\n;]{3,160})/d.exec(f)
      || /ve toi(?!\s*pham\b)\s*[:：]?\s*["“”']?\s*([^\n;.,]{3,120})/d.exec(f);
    if (t) o.toiDanh = fixCrime(clean(src.slice(t.indices[1][0], t.indices[1][1])));
    // Lấy chỗ ghi đầy đủ nhất (có điểm, khoản) trong các lần nhắc tới điều luật.
    const dk = [...f.matchAll(/((?:diem\s+[a-z](?:\s*,\s*[a-z])*\s*,?\s*)?(?:kho[a-z]n\s+\d+\s*,?\s*)?di[a-z]u\s+\d+[a-z]?)\s*(?:cua\s*)?(?:bo luat hinh su|blhs)/g)]
      .sort((x, y) => y[1].length - x[1].length)[0];
    if (dk) o.dieuKhoan = fixClause(dk[1]);
    return o;
  }

  const TYPES = [
    ['kldtbs', /ban ket luan dieu tra bo sung|ket luan dieu tra bo sung/], ['kldt', /ban ket luan dieu tra/],
    ['tdc', /quyet dinh tam dinh chi/], ['dc', /quyet dinh dinh chi/],
    ['giahan', /quyet dinh gia han tam giam/], ['ktbc', /quyet dinh khoi to bi can/], ['ktva', /quyet dinh khoi to vu an/],
    ['tamgiam', /lenh tam giam|lenh bat bi can de tam giam/], ['tamgiu', /quyet dinh tam giu/], ['camdi', /lenh cam di khoi noi cu tru/],
  ];
  const WORDNUM = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9, muoi: 10 };

  function commonFields(f, src) {
    const o = {};
    let type = ''; let pos = Infinity;
    for (const [k, re] of TYPES) { const m = re.exec(f); if (m && m.index < pos) { pos = m.index; type = k; } }
    // Số và ngày của chính văn bản nằm ở phần đầu (trước tên loại văn bản / trước "Căn cứ"),
    // không lấy nhầm số của quyết định được viện dẫn bên dưới.
    const cc = f.search(/\bcan cu\b/);
    const headEnd = Math.min(pos === Infinity ? 700 : pos + 60, cc > 40 ? cc : Infinity, f.length);
    const head = f.slice(0, headEnd);
    // Dạng "Số: 27/QĐ-CSMT", "Số: ....27..../QĐ-CSMT" (dấu chấm dẫn), hoặc mất chữ "Số" do dấu đè: "27/QĐ-…".
    const sm = /\bs[o0]\s*[:：;.]?[\s.…]*(\d{1,6})[\s.…]*\/[\s.…]*([^\s,;]+)/d.exec(head)
      || /(?:^|[\s.…])(\d{1,6})[\s.…]*\/[\s.…]*((?:qd|ltg|lbtg|lcd|kl|kldt|tb|l)[^\s,;]*)/d.exec(head);
    const s1 = sm ? null : /\bs[o0]\s*[:：]\s*(\S*\d\S*)/d.exec(head);
    const docSo = sm ? `${sm[1]}/${clean(src.slice(sm.indices[2][0], sm.indices[2][1]))}` : s1 ? clean(src.slice(s1.indices[1][0], s1.indices[1][1])) : '';
    const NGAY = new RegExp(`ngay[\\s.…]*(\\d{1,2})[\\s.…]*${THANG}[\\s.…]*(\\d{1,2})[\\s.…]*${NAM}[\\s.…]*(\\d{4})`);
    const dn = NGAY.exec(head) || NGAY.exec(f);
    const docNgay = dn ? mkDate(dn[1], dn[2], dn[3]) : '';

    const ref = (name) => {
      const m = new RegExp(`${name}\\s*so\\s*[:：]?\\s*(\\d+\\s?\\/\\s?[^\\s,;]+|\\S*\\d\\S*)[\\s\\S]{0,60}?ngay\\s*${DATE}`, 'd').exec(f);
      return m ? [clean(src.slice(m.indices[1][0], m.indices[1][1])).replace(/\s*\/\s*/g, '/'), mkDate(m[2], m[3], m[4])] : null;
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
    if (type === 'tdc') { if (docSo) o.soTDC = docSo; if (docNgay) o.ngayTDC = docNgay; }
    if (type === 'dc') { if (docSo) o.soDC = docSo; if (docNgay) o.ngayDC = docNgay; }
    o.docType = type;

    const ng = /(tr[aạ]i t[aạ]m giam|nh[aà] t[aạ]m gi[uữ]|trai tam giam|nha tam giu|co so giam giu)[^\n,;.]{0,60}/d.exec(f);
    if (ng) {
      const a = ng.indices[0][0]; let b = ng.indices[0][1];
      const cut = /\s(de|va|theo|ke tu|trong|thuoc|cong an|bo cong an)\s/.exec(f.slice(a, b)); if (cut && cut.index > 12) b = a + cut.index;
      o.noiGiam = clean(src.slice(a, b)).replace(/^./, (c) => c.toUpperCase());
    }
    const nb = new RegExp(`(?:bi bat|bat giu|bat qua tang|bi tam giu|tam giu)[^\\n\\d]{0,25}?ngay\\s*${DATE}`).exec(f);
    if (nb) o.ngayBat = mkDate(nb[1], nb[2], nb[3]);
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
    o.dtv = titleCase(field(f, src, 'dieu tra vien(?: thu ly)?', true));
    o.ksv = titleCase(field(f, src, 'kiem sat vien(?: thu ly)?', true));
    return o;
  }

  const NAME_RE = 'ho\\s*(?:va\\s*)?ten(?:\\s*(?:bi can|bi cao|khai sinh))?\\s*[:：]\\s*([^\\n;]*)';
  // Họ tên hợp lệ: 2–7 từ, chỉ gồm chữ cái.
  const isName = (v) => /^[\p{L}]+(?:\s[\p{L}]+){1,6}$/u.test(v) && v.length <= 50;
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
    const src = unwrap(String(text || '').normalize('NFC').replace(/Ð/g, 'Đ').replace(/ð/g, 'đ').replace(/[⁄∕／]/g, '/').replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' '));
    const f = fold(src);
    const common = Object.assign(commonFields(f, src), crimeFields(f, src));
    const type = common.docType || ''; delete common.docType;
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
      let hoTen = '';
      for (const m of f.matchAll(/(?:doi voi|bi can|bi cao)\s*(?:bi can|\(?ong\/ba\)?|ong|ba)?\s*[:：]?\s*([^\n,;:(]{3,60})/gd)) {
        const a = m.indices[1][0]; let b = m.indices[1][1];
        const stop = /\s(ve toi|sinh|gioi tinh|la|da|co|bi|thuoc|trong|tai|ve|do|nhu|de)\b/.exec(f.slice(a, b)); if (stop) b = a + stop.index;
        const cand = nameFrom(f, src, a, b);
        // tên người viết hoa chữ đầu mỗi từ
        if (isName(cand) && cand.split(' ').every((w) => w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase())) { hoTen = cand; break; }
      }
      const p = hoTen ? { hoTen } : {};
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

  return { read, readDocs, parse, dispose, toCanvas, fileToImage };
})();
