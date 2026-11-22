/* 오프라인 작동용 서비스 워커: 페이지와 글자 인식 파일을 기기에 저장해 두고, 인터넷 없이도 그 파일로 엽니다.
 * 같은 사이트 파일만 다루며, 어떤 데이터도 밖으로 보내지 않습니다.
 * v7: 큰 파일(인식 엔진·데이터)은 한 번에 하나씩, 시간 제한과 재시도를 두고 받습니다.
 *     (실서버 CDN·HTTP/3에서 큰 파일 여러 개를 동시에 받다가 응답이 멈추면 설치가 끝나지 않던 문제 대비)
 *     큰 파일을 끝내 못 받아도 설치는 끝내고, 나중에(페이지 요청·실제 사용 시) 다시 받습니다. */
const CACHE = 'idmask-v10'; // 파일을 고치면 이 이름을 바꿔야 사용자 기기에 새 버전이 받아집니다.
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'privacy.html',
  'licenses.html',
  'vendor/tesseract/tesseract.min.js',
];
const BIG = [
  'vendor/tesseract/worker.min.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/core/tesseract-core-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz',
];
const TIMEOUT_MS = 30000; // 파일 하나를 끝까지 받는 데 허용하는 시간
const TRIES = 3;
const BIG_URLS = BIG.map((p) => new URL(p, self.registration.scope).href);

async function fetchWithRetry(url) {
  let last;
  for (let i = 1; i <= TRIES; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-cache', signal: ac.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.blob(); // 본문을 끝까지 받은 것만 저장(중간에 멈추면 시간 제한으로 끊김)
      return new Response(body, { status: 200, statusText: 'OK', headers: res.headers });
    } catch (e) {
      last = e;
      if (i < TRIES) await new Promise((r) => setTimeout(r, 1000 * i));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

let bigRunning = null;
function cacheBig() {
  // 동시에 여러 번 돌지 않도록 하나만 실행. 큰 파일은 순서대로 하나씩.
  if (bigRunning) return bigRunning;
  bigRunning = (async () => {
    const cache = await caches.open(CACHE);
    for (const u of BIG_URLS) {
      if (await cache.match(u)) continue;
      try { await cache.put(u, await fetchWithRetry(u)); } catch (e) { /* 다음 기회에 다시 받음 */ }
    }
  })().finally(() => { bigRunning = null; });
  return bigRunning;
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      // 큰 파일은 최대 60초까지만 기다리고 설치를 마침(못 받은 것은 이후 다시 받음)
      .then(() => Promise.race([cacheBig(), new Promise((r) => setTimeout(r, 60000))]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 페이지가 "오프라인 준비가 늦다"고 판단하면 큰 파일 받기를 다시 시도
self.addEventListener('message', (e) => {
  if (e.data === 'cache-big') e.waitUntil(cacheBig());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const bigUrl = BIG_URLS.find((u) => u === url.origin + url.pathname);
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (bigUrl) {
        // 아직 저장 못 한 큰 파일: 시간 제한·재시도로 받고, 받은 김에 저장
        return fetchWithRetry(bigUrl).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(bigUrl, copy)).catch(() => {});
          return res;
        }).catch(() => Response.error());
      }
      return fetch(req).catch(() =>
        req.mode === 'navigate' ? caches.match('index.html') : Response.error()
      );
    })
  );
});
