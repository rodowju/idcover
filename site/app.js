/*
 * 신분증 주민번호 뒷자리 가리기
 * - 모든 처리는 이 기기 안에서만 합니다. 이 파일에는 이미지를 밖으로 보내는 코드(fetch, XHR, sendBeacon 등)가 없습니다.
 * - 글자 인식은 같은 사이트에 함께 둔 tesseract.js 파일로 합니다(외부 CDN 사용 안 함).
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const abs = (p) => new URL(p, location.href).href;

  // 상태 ---------------------------------------------------------------
  const state = {
    src: null,          // 원본(회전 반영) 이미지가 그려진 canvas
    boxes: [],          // {id, x, y, w, h, type, auto?:{partial, full}}  (원본 픽셀 좌표)
    selected: null,
    pendingPreset: null,
    drag: null,
    view: { scale: 1 }, // 원본 → 화면(CSS px) 배율
    ocrRun: 0,
    previewUrl: null,
    scope: 'rrn7',      // rrn6 | rrn7 | addr | all (기본: 7자리 전부)
    foreign: false,     // 외국인등록번호(뒷자리 첫 자리 5~8)로 보이면 true
    ocrLines: [],       // 마지막 인식 결과의 줄
    ocrInv: 1,          // 인식용 사본 좌표 → 원본 좌표 배율
    exportBlob: null,
  };
  let nextId = 1;
  let worker = null;
  let workerPromise = null;

  const LABEL = {
    rrn: '주민번호', address: '주소', date: '발급일', license: '면허번호', face: '얼굴', free: '가림',
  };
  // 사진 크기에 대한 비율(가로, 세로)
  const PRESET_SIZE = {
    rrn: [0.36, 0.08], address: [0.62, 0.14], date: [0.32, 0.08],
    license: [0.42, 0.08], face: [0.26, 0.42], free: [0.25, 0.1],
  };

  // 연결·오프라인 상태 표시 -------------------------------------------
  function updateNet() {
    const el = $('netStatus');
    if (navigator.onLine) {
      el.textContent = '인터넷 연결됨';
      el.className = 'pill';
    } else {
      el.textContent = '인터넷 꺼짐 (오프라인으로 작동 중)';
      el.className = 'pill ok';
    }
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  let offlineTries = 0;
  async function checkOfflineReady() {
    const el = $('offlineStatus');
    if (!('serviceWorker' in navigator) || !window.caches) {
      el.textContent = '이 브라우저는 오프라인 저장을 지원하지 않음';
      el.className = 'pill warn';
      return;
    }
    try {
      // 서비스 워커 설치가 끝나기를 무한정 기다리지 않고, 1.5초마다 저장 상태를 확인
      const reg = await navigator.serviceWorker.getRegistration();
      const hit = await caches.match(abs('vendor/lang/eng.traineddata.gz'));
      if (hit && reg && reg.active) {
        el.textContent = '오프라인 사용 준비됨';
        el.className = 'pill ok';
        return;
      }
      offlineTries++;
      // 20초쯤 지나도 안 되면 큰 파일 받기를 다시 시도하도록 서비스 워커에 요청
      if (offlineTries % 15 === 0 && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('cache-big');
      if (offlineTries > 40) {
        el.textContent = '오프라인 준비가 늦어지고 있습니다(인터넷 연결 상태에서는 사용 가능). 잠시 뒤 새로고침해 주세요';
        el.className = 'pill warn';
      } else {
        el.textContent = '오프라인 준비 중';
        el.className = 'pill';
      }
      setTimeout(checkOfflineReady, 1500);
    } catch (e) {
      el.textContent = '오프라인 준비 실패';
      el.className = 'pill warn';
    }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(checkOfflineReady).catch(() => {
      $('offlineStatus').textContent = '오프라인 준비 실패';
      $('offlineStatus').className = 'pill warn';
    });
  } else {
    checkOfflineReady();
  }

  // 단계 전환 -----------------------------------------------------------
  function show(step) {
    for (const id of ['stepPick', 'stepEdit', 'stepPreview']) $(id).hidden = id !== step;
    window.scrollTo(0, 0);
  }

  // 1단계: 사진 읽기 ----------------------------------------------------
  for (const id of ['inCamera', 'inGallery']) {
    $(id).addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        await loadFile(file);
      } catch (err) {
        alert('사진을 열 수 없습니다. 다른 사진으로 해 주세요.');
      }
    });
  }

  async function decode(file) {
    // EXIF 회전 정보는 화면에 바로 보이도록 반영만 하고, 결과 이미지에는 다시 쓰지 않습니다.
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* 아래 방식으로 */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const MAX_SIDE = 4000; // 너무 큰 사진은 휴대폰 메모리를 위해 줄입니다.
  async function loadFile(file) {
    const bmp = await decode(file);
    const w0 = bmp.width, h0 = bmp.height;
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * k);
    c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    state.src = c;
    state.boxes = [];
    state.selected = null;
    setPending(null);
    state.ocrLines = [];
    setScope('rrn7', true);
    state.foreign = false;
    $('scopeMsg').hidden = true;
    show('stepEdit');
    layoutCanvas();
    runDetect();
  }

  // 2단계: 자동 인식 ----------------------------------------------------
  function getWorker() {
    if (workerPromise) return workerPromise;
    // 인식 파일 받기가 멈추면 끝없이 기다리지 않도록 90초 제한
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90000));
    workerPromise = Promise.race([timeout, Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/core/'),
      langPath: abs('vendor/lang'),
      workerBlobURL: false,
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') setProgress('번호를 찾는 중입니다…', m.progress);
        else if (m.status) setProgress('글자 인식 준비 중입니다… (처음 한 번은 조금 걸립니다)', m.progress || 0);
      },
    })]).then((w) => { worker = w; return w; }).catch((e) => { workerPromise = null; throw e; });
    return workerPromise;
  }

  function setProgress(msg, p) {
    $('ocrMsg').textContent = msg;
    $('ocrBar').style.width = Math.round((p || 0) * 100) + '%';
  }

  function ocrCanvas(src, target) {
    // 인식용 사본: 긴 변 target px 안팎, 흑백 + 대비 보정
    const k = Math.min(1.6, target / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height);
    const a = d.data;
    let lo = 255, hi = 0;
    const hist = new Uint32Array(256);
    for (let i = 0; i < a.length; i += 4) {
      const y = (a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000 | 0;
      a[i] = y; hist[y]++;
    }
    // 아래·위 1%를 잘라 대비를 늘림
    const n = a.length / 4;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < a.length; i += 4) {
      let y = (a[i] - lo) * 255 / span;
      y = y < 0 ? 0 : y > 255 ? 255 : y;
      a[i] = a[i + 1] = a[i + 2] = y;
    }
    g.putImageData(d, 0, 0);
    return { canvas: c, k };
  }

  async function runDetect() {
    const run = ++state.ocrRun;
    $('ocrBox').hidden = false;
    $('detectMsg').hidden = true;
    setProgress('글자 인식 준비 중입니다…', 0);
    let found = [];
    try {
      const w = await getWorker();
      if (run !== state.ocrRun) return;
      // 사진 방향 0·90·180·270도 순서로, 각 방향에서 (자동 배치 → 흩어진 글자) 두 방식으로 찾습니다.
      // 돌린 방향에서 찾으면 사진도 그 방향으로 바로 세워 보여 줍니다.
      let img = state.src;
      search:
      for (let rot = 0; rot < 4; rot++) {
        if (rot > 0) img = rotateCanvas(img);
        const tries = rot === 0 ? [['3', 2000], ['11', 2000], ['11', 3200]] : [['3', 2000], ['11', 2000]];
        for (const [psm, size] of tries) {
          const { canvas, k } = ocrCanvas(img, size);
          await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
          const { data } = await w.recognize(canvas, {}, { blocks: true, text: false, hocr: false, tsv: false });
          if (run !== state.ocrRun) return;
          state.ocrInv = 1 / k;
          found = findNumbers(data, 1 / k);
          if (found.some((f) => f.type === 'rrn')) {
            for (let i = 0; i < rot; i++) rotateSrc();
            break search;
          }
        }
      }
      if (!found.some((f) => f.type === 'rrn')) { found = []; state.ocrLines = []; }
    } catch (err) {
      if (run !== state.ocrRun) return;
      $('ocrBox').hidden = true;
      showDetect('warn', '자동 인식을 쓸 수 없습니다. 아래 "주민번호" 버튼을 누르고 사진에서 번호 자리를 눌러 직접 가려 주세요. 인터넷 연결을 확인하고 "다시 자동 찾기"를 누르면 다시 시도합니다.');
      return;
    }
    if (run !== state.ocrRun) return;
    $('ocrBox').hidden = true;
    // 이전 자동 칸은 지우고 새로 넣음(직접 만든 칸은 유지)
    state.boxes = state.boxes.filter((b) => !b.auto);
    for (const f of found) state.boxes.push(f);
    applyScope();
    const nR = found.filter((f) => f.type === 'rrn').length;
    if (nR > 0) {
      let msg = `주민번호 ${nR}곳을 찾아 가렸습니다.`;
      msg += ' 검은 칸이 번호를 다 덮었는지 꼭 확인해 주세요.';
      showDetect('ok', msg);
    } else {
      showDetect('warn', '주민번호를 자동으로 찾지 못했습니다. "주민번호" 버튼을 누른 뒤 사진에서 번호 자리를 눌러 직접 가려 주세요. 신분증이 화면을 가득 채우게, 밝은 곳에서 반듯하게 다시 찍으면 찾을 가능성이 높아집니다.');
    }
    draw();
  }

  function showDetect(kind, msg) {
    const el = $('detectMsg');
    el.className = 'detect-msg ' + kind;
    el.textContent = msg;
    el.hidden = false;
  }

  // 글자 인식 결과에서 번호 찾기 ------------------------------------------
  // 인식기가 숫자를 비슷한 글자로 읽는 경우를 한 글자씩 숫자로 바꿔 봅니다(글자 수는 그대로).
  const DIGITLIKE = {
    O: '0', o: '0', D: '0', Q: '0', U: '0', '°': '0',
    I: '1', l: '1', i: '1', '|': '1', '!': '1', ']': '1', '[': '1', J: '1', j: '1', L: '1',
    Z: '2', z: '2', S: '5', s: '5', $: '5', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7', A: '4',
  };
  const DASH = '-–—~=_.·―‐−';

  function lineChars(line) {
    // 한 줄의 글자와 각 글자의 위치(bbox)를 나란히 만듭니다.
    const chars = [];
    const words = line.words || [];
    words.forEach((wd, wi) => {
      if (wi > 0) chars.push({ c: ' ', bbox: null });
      const text = wd.text || '';
      const syms = (wd.symbols || []).filter((s) => s.text);
      const symText = syms.map((s) => s.text).join('');
      if (syms.length && symText === text) {
        for (const s of syms) {
          for (const ch of s.text) chars.push({ c: ch, bbox: s.bbox });
        }
      } else {
        const b = wd.bbox;
        const n = Math.max(1, text.length);
        const cw = (b.x1 - b.x0) / n;
        [...text].forEach((ch, i) => chars.push({ c: ch, bbox: { x0: b.x0 + cw * i, x1: b.x0 + cw * (i + 1), y0: b.y0, y1: b.y1 } }));
      }
    });
    return chars;
  }

  function normalize(chars) {
    return chars.map((x) => {
      if (/\d/.test(x.c)) return x.c;
      if (DIGITLIKE[x.c]) return DIGITLIKE[x.c];
      if (DASH.includes(x.c)) return '-';
      if (x.c === ' ') return ' ';
      return '#';
    }).join('');
  }

  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of list) {
      if (!b) continue;
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    return { x0, y0, x1, y1 };
  }

  function findNumbers(data, inv) {
    const out = [];
    const lines = [];
    state.ocrLines = [];
    state.foreign = false;
    for (const bl of data.blocks || []) for (const p of bl.paragraphs || []) for (const ln of p.lines || []) lines.push(ln);
    const seen = [];
    for (const ln of lines) {
      const chars = lineChars(ln);
      const s = normalize(chars);
      state.ocrLines.push({ chars, s, bbox: ln.bbox });
      // 주민번호·외국인등록번호: 6자리 - 7자리 (뒷자리는 인식이 덜 돼도 5자리 이상이면 잡음)
      const reR = /(?<!\d)(\d{6}) ?-? ?([1-8]\d{4,7})(?!\d)/g; // 뒷자리 첫 자리 1~8. 체크섬 검증은 하지 않음(2020-10 이후 번호는 체크섬과 무관)
      let m;
      while ((m = reR.exec(s))) {
        const front = m[1];
        // 앞자리가 생년월일 꼴인지 가볍게 확인(월 01~12)
        const mon = +front.slice(2, 4);
        if (mon < 1 || mon > 12) continue;
        const frontStart = m.index;
        const backStart = s.indexOf(m[2], frontStart + 6);
        const backLen = m[2].length;
        const fb = chars.slice(frontStart, frontStart + 6).map((x) => x.bbox);
        const bb = chars.slice(backStart, backStart + backLen).map((x) => x.bbox);
        const fU = unionBox(fb);
        const bU = unionBox(bb);
        // 글자 위치가 이상하면(세로로 누운 글줄 등) 버리고 다른 방향에서 다시 찾음
        if (!(fU.y1 - fU.y0 > 2) || !(bU.y1 - bU.y0 > 2) || (fU.x1 - fU.x0) < (fU.y1 - fU.y0) * 1.5 || bU.x0 < fU.x1 - 2) continue;
        const allU = unionBox([fU, bU]);
        const cw = Math.max((fU.x1 - fU.x0) / 6, (bU.x1 - bU.x0) / backLen);
        const h = allU.y1 - allU.y0;
        const padY = h * 0.35;
        const padX = cw * 0.45;
        // 뒷자리가 7자리보다 적게 읽혀도 7자리 폭만큼 덮도록 늘림
        const right = Math.max(bU.x1, bb[0].x0 + cw * 7) + padX;
        const c0 = bb[0], c1 = bb[1];
        const keepLeft = c1 ? (c0.x1 + c1.x0) / 2 : c0.x1;
        const fullLeft = c0.x0 - padX * 0.6;
        const y0 = allU.y0 - padY, y1 = allU.y1 + padY;
        const mk = (l) => ({ x: l * inv, y: y0 * inv, w: (right - l) * inv, h: (y1 - y0) * inv });
        const partial = mk(keepLeft);
        const full = mk(fullLeft);
        if (seen.some((q) => Math.abs(q.x - full.x) < cw * inv && Math.abs(q.y - full.y) < h * inv)) continue;
        seen.push(full);
        if (/[5-8]/.test(m[2][0])) state.foreign = true;
        out.push({ id: nextId++, type: 'rrn', auto: { partial, full }, ...partial });
      }
      // 운전면허번호는 자동으로 가리지 않음(2026-11-20 결정: 렌터카·본인확인 등에서 필요한 경우가 많음).
      // 원하는 사람만 "면허번호" 버튼으로 직접 가림.
    }
    return out;
  }

  // 제출처별 가림 범위 -------------------------------------------------------
  // 범위는 칸 위치를 "제안"할 뿐입니다. 저장 전 미리보기 확인은 그대로 필수입니다.
  function setScope(sc, silent) {
    state.scope = sc;
    document.querySelectorAll('[data-scope]').forEach((b) => {
      const on = b.dataset.scope === sc;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    if (!silent) { applyScope(); draw(); }
  }
  document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));

  const RRN_RE = /(?<!\d)\d{6} ?-? ?[1-8]\d{4,7}(?!\d)/;
  const LIC_RE = /\d\d-\d\d-\d{6}-\d\d/;
  const DATE_RE = /(?:19|20)\d\d ?- ?[01]?\d ?- ?[0-3]?\d/g;

  function suggest(t) {
    const inv = state.ocrInv, L = state.ocrLines;
    if (!L.length || !state.src) return [];
    const rrnIdx = L.findIndex((l) => RRN_RE.test(l.s));
    const pad = (u, h) => ({ x: (u.x0 - h * 0.3) * inv, y: (u.y0 - h * 0.3) * inv, w: (u.x1 - u.x0 + h * 0.6) * inv, h: (u.y1 - u.y0 + h * 0.6) * inv });
    const dateHits = [];
    L.forEach((l, i) => {
      if (i === rrnIdx) return;
      DATE_RE.lastIndex = 0;
      let m;
      while ((m = DATE_RE.exec(l.s))) {
        dateHits.push({ i, u: unionBox(l.chars.slice(m.index, m.index + m[0].length).map((c) => c.bbox)) });
      }
    });
    if (t === 'date') return dateHits.map(({ u }) => pad(u, u.y1 - u.y0));
    if (rrnIdx < 0) return [];
    const r = L[rrnIdx].bbox, rh = r.y1 - r.y0;
    if (t === 'address') {
      // 주민번호 줄 바로 아래, 같은 글줄 기둥에 있는 1~3줄 (날짜 줄을 만나면 멈춤)
      const dateLines = new Set(dateHits.map((d) => d.i));
      const cand = L.map((l, i) => ({ l, i }))
        .filter(({ l, i }) => i !== rrnIdx && l.bbox.y0 >= r.y1 - rh * 0.2 && l.bbox.y0 <= r.y1 + rh * 6)
        .sort((a, b) => a.l.bbox.y0 - b.l.bbox.y0);
      const picked = [];
      for (const { l, i } of cand) {
        if (dateLines.has(i)) break;
        if (LIC_RE.test(l.s)) continue;
        if (l.s.replace(/ /g, '').length < 3) continue;
        if (Math.abs(l.bbox.x0 - r.x0) > rh * 4) continue;
        if (picked.length && l.bbox.y0 - picked[picked.length - 1].y1 > rh * 2.5) break;
        picked.push(l.bbox);
        if (picked.length >= 3) break;
      }
      return picked.length ? [pad(unionBox(picked), rh)] : [];
    }
    if (t === 'face') {
      // 대략적인 추정: 신분증 가로 폭 ≈ 주민번호 글자 높이의 약 28배로 보고,
      // 면허증형(면허번호가 있으면)은 글줄 왼쪽, 그 밖은 카드 오른쪽 1/3에 사진이 있다고 가정
      const W = state.src.width / inv, H = state.src.height / inv;
      const cardW = rh * 28;
      const fw = cardW * 0.28, fh = cardW * 0.38;
      const above = L.filter((l) => l.bbox.y0 >= r.y0 - rh * 3 && l.bbox.y1 <= r.y0 && Math.abs(l.bbox.x0 - r.x0) < rh * 4);
      const top = above.length ? Math.min(...above.map((l) => l.bbox.y0)) : r.y0 - rh * 2.5;
      const y = Math.max(0, top - rh * 0.5);
      let x;
      if (L.some((l) => LIC_RE.test(l.s))) x = r.x0 - rh * 1.2 - fw;
      else x = r.x0 - rh + cardW * 0.70;
      x = Math.max(0, Math.min(W - fw, x));
      return [{ x: x * inv, y: y * inv, w: fw * inv, h: Math.min(fh, H - y) * inv }];
    }
    return [];
  }

  function applyScope() {
    const full = state.scope !== 'rrn6';
    for (const b of state.boxes) if (b.auto) Object.assign(b, full ? b.auto.full : b.auto.partial);
    state.boxes = state.boxes.filter((b) => !b.suggest); // 손대지 않은 이전 제안 칸만 지움
    if (state.selected && !state.boxes.includes(state.selected)) state.selected = null;
    const want = { addr: ['address'], all: ['address', 'date', 'face'] }[state.scope] || [];
    const miss = [];
    const skipped = [];
    for (const t of want) {
      if (t === 'address' && state.foreign) { skipped.push(t); continue; }
      const sug = suggest(t);
      if (!sug.length) miss.push(LABEL[t]);
      for (const r of sug) state.boxes.push({ id: nextId++, type: t, suggest: true, ...r });
    }
    const el = $('scopeMsg');
    const notes = [];
    if (skipped.length) notes.push('외국인등록번호로 보여 주소 칸은 제안하지 않았습니다(외국인등록증은 앞면 배치가 달라 이름·국적 줄을 덮을 수 있음). 주소가 보이면 아래 "주소" 버튼으로 직접 추가해 주세요.');
    if (miss.length) notes.push(`${miss.join(', ')} 위치를 찾지 못했습니다. 아래 "더 가리기" 버튼으로 직접 추가해 주세요.`);
    if (notes.length) {
      el.textContent = notes.join(' ');
      el.hidden = false;
    } else if (want.length) {
      el.textContent = '제안한 칸(주소·발급일·사진)은 대략적인 위치입니다. 제자리에 맞게 옮겨 주세요.';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // 용도 표시 글씨(선택) -------------------------------------------------------
  function todayStr() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  $('optWm').addEventListener('change', (e) => {
    $('wmText').disabled = !e.target.checked;
    if (e.target.checked && !$('wmText').value.trim()) $('wmText').value = `OO 제출용 / ${todayStr()} / 타 용도 사용 금지`;
    draw();
  });
  $('wmText').addEventListener('input', () => draw());

  function drawWatermark(g, W, H) {
    if (!$('optWm').checked) return;
    const text = $('wmText').value.trim();
    if (!text) return;
    g.save();
    const fs = Math.max(14, Math.round(Math.min(W, H) / 14));
    g.font = `bold ${fs}px sans-serif`;
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(30,30,30,0.32)';
    g.strokeStyle = 'rgba(255,255,255,0.32)';
    g.lineWidth = Math.max(1, fs / 14);
    g.translate(W / 2, H / 2);
    g.rotate(-Math.PI / 6);
    const tw = g.measureText(text).width + fs * 2;
    const step = fs * 3.2;
    const R = Math.hypot(W, H) / 2 + tw;
    let row = 0;
    for (let y = -R; y <= R; y += step, row++) {
      for (let x = -R - (row % 2 ? tw / 2 : 0); x <= R; x += tw) {
        g.strokeText(text, x, y);
        g.fillText(text, x, y);
      }
    }
    g.restore();
  }

  // 편집 화면 그리기 ----------------------------------------------------
  const cv = $('editCanvas');
  const ctx = cv.getContext('2d');

  function layoutCanvas() {
    if (!state.src) return;
    const wrap = cv.parentElement;
    const cssW = wrap.clientWidth;
    const maxH = Math.max(240, window.innerHeight * 0.7);
    let scale = cssW / state.src.width;
    if (state.src.height * scale > maxH) scale = maxH / state.src.height;
    const cssH = state.src.height * scale;
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = (state.src.width * scale) + 'px';
    cv.style.height = cssH + 'px';
    cv.style.margin = '0 auto';
    cv.width = Math.round(state.src.width * scale * dpr);
    cv.height = Math.round(cssH * dpr);
    state.view.scale = scale;
    state.view.dpr = dpr;
    draw();
  }
  window.addEventListener('resize', () => { if (!$('stepEdit').hidden) layoutCanvas(); });

  const HANDLE = 14; // 모서리 손잡이 반지름(CSS px)

  function draw() {
    if (!state.src) return;
    const { scale, dpr } = state.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(state.src, 0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    drawWatermark(ctx, state.src.width, state.src.height);
    for (const b of state.boxes) {
      ctx.fillStyle = '#000';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      // 이름표
      const fs = Math.min(b.h * 0.5, 13 / scale);
      if (fs * scale >= 8) {
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.font = `${fs}px sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(LABEL[b.type] || '가림', b.x + 4 / scale, b.y + b.h / 2, Math.max(0, b.w - 8 / scale));
      }
      if (b === state.selected) {
        ctx.save();
        ctx.lineWidth = 2.5 / scale;
        ctx.strokeStyle = '#facc15';
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);
        for (const [hx, hy] of corners(b)) {
          ctx.beginPath();
          ctx.arc(hx, hy, (HANDLE * 0.65) / scale, 0, Math.PI * 2);
          ctx.fillStyle = '#facc15';
          ctx.fill();
          ctx.lineWidth = 2 / scale;
          ctx.strokeStyle = '#000';
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    $('btnDelete').disabled = !state.selected;
  }

  function corners(b) {
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
  }

  // 손가락·마우스 조작 ---------------------------------------------------
  function toImg(e) {
    const r = cv.getBoundingClientRect();
    const s = state.view.scale;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  }

  function hitTest(p) {
    const tol = HANDLE / state.view.scale;
    if (state.selected) {
      const cs = corners(state.selected);
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(p.x - cs[i][0], p.y - cs[i][1]) <= tol * 1.4) return { box: state.selected, corner: i };
      }
    }
    for (let i = state.boxes.length - 1; i >= 0; i--) {
      const b = state.boxes[i];
      if (p.x >= b.x - tol * 0.3 && p.x <= b.x + b.w + tol * 0.3 && p.y >= b.y - tol * 0.3 && p.y <= b.y + b.h + tol * 0.3) return { box: b, corner: -1 };
    }
    return null;
  }

  function clampBox(b) {
    const W = state.src.width, H = state.src.height;
    const min = 6 / state.view.scale;
    if (b.w < min) b.w = min;
    if (b.h < min) b.h = min;
    b.x = Math.max(-b.w + min, Math.min(W - min, b.x));
    b.y = Math.max(-b.h + min, Math.min(H - min, b.y));
  }

  cv.addEventListener('pointerdown', (e) => {
    if (!state.src) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = toImg(e);
    if (state.pendingPreset) {
      const t = state.pendingPreset;
      const [rw, rh] = PRESET_SIZE[t];
      const base = Math.max(state.src.width, state.src.height);
      // 얼굴은 세로로 긴 칸, 나머지는 사진 가로 기준
      const w = t === 'face' ? state.src.width * rw : state.src.width * rw;
      const h = t === 'face' ? Math.min(state.src.height * rh, w * 1.35) : Math.min(state.src.height * rh, base * 0.08);
      const b = { id: nextId++, type: t, x: p.x - w / 2, y: p.y - h / 2, w, h };
      clampBox(b);
      state.boxes.push(b);
      state.selected = b;
      setPending(null);
      draw();
      return;
    }
    const hit = hitTest(p);
    if (hit) {
      state.selected = hit.box;
      if (hit.box.auto) delete hit.box.auto; // 손댄 자동·제안 칸은 직접 만든 칸으로 취급
      delete hit.box.suggest;
      state.drag = { mode: hit.corner >= 0 ? 'resize' : 'move', corner: hit.corner, start: p, orig: { ...hit.box }, box: hit.box };
    } else {
      state.selected = null;
      state.drag = { mode: 'create', start: p, box: null };
    }
    draw();
  });

  cv.addEventListener('pointermove', (e) => {
    const d = state.drag;
    if (!d) return;
    e.preventDefault();
    const p = toImg(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (d.mode === 'move') {
      d.box.x = d.orig.x + dx;
      d.box.y = d.orig.y + dy;
      clampBox(d.box);
    } else if (d.mode === 'resize') {
      const o = d.orig;
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (d.corner === 0 || d.corner === 2) x0 += dx; else x1 += dx;
      if (d.corner === 0 || d.corner === 1) y0 += dy; else y1 += dy;
      d.box.x = Math.min(x0, x1); d.box.y = Math.min(y0, y1);
      d.box.w = Math.abs(x1 - x0); d.box.h = Math.abs(y1 - y0);
      clampBox(d.box);
    } else if (d.mode === 'create') {
      const dist = Math.hypot(dx, dy) * state.view.scale;
      if (!d.box && dist > 10) {
        d.box = { id: nextId++, type: 'free', x: d.start.x, y: d.start.y, w: 0, h: 0 };
        state.boxes.push(d.box);
        state.selected = d.box;
      }
      if (d.box) {
        d.box.x = Math.min(d.start.x, p.x); d.box.y = Math.min(d.start.y, p.y);
        d.box.w = Math.abs(dx); d.box.h = Math.abs(dy);
      }
    }
    draw();
  });

  function endDrag() {
    if (state.drag && state.drag.box) clampBox(state.drag.box);
    state.drag = null;
    draw();
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  // 도구 버튼 -------------------------------------------------------------
  function setPending(t) {
    state.pendingPreset = t;
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === t));
    const el = $('pendingMsg');
    if (t) {
      el.textContent = `사진에서 "${LABEL[t] === '가림' ? '가릴 곳' : LABEL[t]}" 자리를 눌러 주세요.`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => setPending(state.pendingPreset === btn.dataset.preset ? null : btn.dataset.preset));
  });

  $('btnDelete').addEventListener('click', () => {
    if (!state.selected) return;
    state.boxes = state.boxes.filter((b) => b !== state.selected);
    state.selected = null;
    draw();
  });

  function rotateCanvas(s) {
    // 시계 방향 90도
    const c = document.createElement('canvas');
    c.width = s.height; c.height = s.width;
    const g = c.getContext('2d');
    g.translate(c.width, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(s, 0, 0);
    return c;
  }

  function rotateSrc() {
    const s = state.src;
    // 칸도 함께 시계 방향 90도 회전: (x, y) → (H - y, x)
    const H = s.height;
    const rot = (b) => ({ x: H - (b.y + b.h), y: b.x, w: b.h, h: b.w });
    for (const b of state.boxes) {
      Object.assign(b, rot(b));
      if (b.auto) b.auto = { partial: rot(b.auto.partial), full: rot(b.auto.full) };
    }
    state.src = rotateCanvas(s);
    state.ocrLines = []; // 돌린 뒤에는 "다시 자동 찾기"로 새로 인식
    layoutCanvas();
  }

  $('btnRotate').addEventListener('click', () => {
    if (!state.src) return;
    rotateSrc();
  });

  $('btnRescan').addEventListener('click', () => runDetect());

  $('btnRestart').addEventListener('click', () => {
    if (state.boxes.length && !confirm('지금까지 가린 칸이 모두 사라집니다. 처음으로 갈까요?')) return;
    resetAll();
  });

  function resetAll() {
    state.ocrRun++;
    state.src = null;
    state.boxes = [];
    state.selected = null;
    clearPreview();
    setPending(null);
    show('stepPick');
  }

  // 3단계: 내보내기·미리보기 -------------------------------------------
  function clearPreview() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    state.exportBlob = null;
    $('previewImg').removeAttribute('src');
  }

  function renderExport() {
    // 원본 픽셀 위에 불투명한 검은 칸을 직접 칠해 새 이미지를 만듭니다(흐림·모자이크 아님).
    const s = state.src;
    const c = document.createElement('canvas');
    c.width = s.width; c.height = s.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(s, 0, 0);
    drawWatermark(g, c.width, c.height); // 글씨를 먼저 새기고, 검은 칸은 그 위에 덮음
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000000';
    const rects = [];
    for (const b of state.boxes) {
      // 경계가 반 픽셀에 걸려도 빈틈이 없도록 바깥쪽으로 정수 픽셀에 맞춤
      const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
      const x1 = Math.min(c.width, Math.ceil(b.x + b.w)), y1 = Math.min(c.height, Math.ceil(b.y + b.h));
      if (x1 <= x0 || y1 <= y0) continue;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      rects.push([x0, y0, x1 - x0, y1 - y0]);
    }
    // 스스로 점검: 칠한 칸 안의 모든 픽셀이 완전한 검정(0,0,0,255)인지 확인
    let bad = 0;
    for (const [x, y, w, h] of rects) {
      const a = g.getImageData(x, y, w, h).data;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] | a[i + 1] | a[i + 2] || a[i + 3] !== 255) { bad++; break; }
      }
    }
    return { canvas: c, rects, bad };
  }


  // 신뢰 표시용 점검 ---------------------------------------------------------
  let cspBlocked = 0; // 보안 정책이 막은 외부 연결 시도 수
  document.addEventListener('securitypolicyviolation', () => { cspBlocked++; });

  function externalRequests() {
    // 이 페이지가 다른 주소로 보낸 요청 수(브라우저 기록 기준)
    try {
      return performance.getEntriesByType('resource')
        .filter((e) => new URL(e.name, location.href).origin !== location.origin && !e.name.startsWith('blob:') && !e.name.startsWith('data:')).length;
    } catch (e) { return 0; }
  }

  async function pngMetaChunks(blob) {
    // 저장될 PNG 파일을 직접 읽어 숨은 정보 묶음(eXIf, tEXt 등)이 있는지 확인
    const b = new Uint8Array(await blob.arrayBuffer());
    const meta = [];
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(t)) meta.push(t);
      p += 12 + len;
      if (t === 'IEND') break;
    }
    return meta;
  }

  async function showTrust(blob) {
    const ul = $('trustList');
    ul.innerHTML = '';
    const add = (txt, warn) => {
      const li = document.createElement('li');
      li.textContent = txt;
      if (warn) li.className = 'warn';
      ul.appendChild(li);
    };
    const meta = await pngMetaChunks(blob);
    if (meta.length === 0) add('저장될 파일에는 촬영 위치·기기 정보가 들어 있지 않습니다(파일 검사 결과). 휴대폰에 있는 원본 사진은 그대로 남아 있으니, 필요 없으면 직접 지워 주세요.');
    else add(`저장될 파일에 숨은 정보(${meta.join(', ')})가 있습니다.`, true);
    const ext = externalRequests();
    if (ext === 0 && cspBlocked === 0) add('이 페이지에는 사진을 인터넷으로 보내는 기능이 없고, 외부 주소 연결은 보안 설정으로 막아 두었습니다.');
    else add(`외부 연결 시도 ${ext + cspBlocked}건이 기록되었습니다. 저장하지 말고 창을 닫아 주세요.`, true);
    if (!navigator.onLine) add('지금 인터넷이 꺼진 상태에서 처리했습니다.');
    else add('비행기 모드로 켜고 써 보면 인터넷 없이 작동하는지 직접 확인할 수 있습니다.');
  }

  $('btnToPreview').addEventListener('click', async () => {
    if (!state.src) return;
    setPending(null);
    state.selected = null;
    draw();
    if (!state.boxes.some((b) => b.type === 'rrn') &&
        !confirm('"주민번호" 가림 칸이 없습니다. 그래도 미리보기로 갈까요?')) return;
    const { canvas, rects, bad } = renderExport();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) { alert('이미지를 만들지 못했습니다. 사진 크기를 줄여 다시 해 주세요.'); return; }
    clearPreview();
    state.exportBlob = blob;
    state.previewUrl = URL.createObjectURL(blob);
    $('previewImg').src = state.previewUrl;
    await showTrust(blob);
    const v = $('verifyMsg');
    if (rects.length === 0) {
      v.className = 'verify warn';
      v.textContent = '가린 칸이 하나도 없습니다. 이대로 저장하면 번호가 그대로 보입니다.';
    } else if (bad) {
      v.className = 'verify warn';
      v.textContent = `가린 칸 ${rects.length}개 중 ${bad}개가 완전한 검정이 아닙니다. "다시 고치기"를 눌러 주세요.`;
    } else {
      v.className = 'verify ok';
      v.textContent = `가린 칸 ${rects.length}개 모두 완전한 검정으로 덮인 것을 확인했습니다. 칸이 번호 위에 정확히 있는지는 눈으로 확인해 주세요.`;
    }
    $('chkConfirm').checked = false;
    $('btnSave').disabled = true;
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], 'x.png', { type: 'image/png' })] }));
    $('btnShare').hidden = !canShare;
    $('btnShare').disabled = true;
    show('stepPreview');
  });

  $('chkConfirm').addEventListener('change', (e) => {
    const ok = e.target.checked && !!state.exportBlob;
    $('btnSave').disabled = !ok;
    $('btnShare').disabled = !ok;
  });

  function fileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `가림_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`;
  }

  $('btnSave').addEventListener('click', () => {
    if (!$('chkConfirm').checked || !state.exportBlob) return; // 미리보기 확인 없이는 저장 불가
    const a = document.createElement('a');
    a.href = state.previewUrl;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $('btnShare').addEventListener('click', async () => {
    if (!$('chkConfirm').checked || !state.exportBlob) return;
    try {
      // 휴대폰의 공유 창을 엽니다. 어디로 보낼지는 사용자가 고릅니다(이 사이트 서버로 가지 않음).
      await navigator.share({ files: [new File([state.exportBlob], fileName(), { type: 'image/png' })] });
    } catch (e) { /* 사용자가 취소 */ }
  });

  $('btnBack').addEventListener('click', () => {
    clearPreview();
    show('stepEdit');
    layoutCanvas();
  });

})();
