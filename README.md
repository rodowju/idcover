# 신분증 번호 가리기 (idcover.kr)

신분증 사진(주민등록증·운전면허증·외국인등록증)에서 주민등록번호 뒷자리를 **불투명한 검은 칸**으로 덮어 새 이미지로 저장하는 웹 도구입니다. 설치·가입이 없습니다.

- 주소: https://idcover.kr/
- 자동 인식(기기 안 글자 인식) + 손으로 칸 추가·이동·크기 조절
- 흐림·모자이크가 아니라 픽셀 자체를 검정으로 덮고, 캔버스로 새로 그려 저장하므로 촬영 위치(EXIF/GPS) 정보가 들어가지 않습니다.
- 저장 전 미리보기 확인을 건너뛸 수 없습니다. 자동 인식은 틀릴 수 있으니 최종 확인은 직접 해 주세요.
- 운전면허번호는 자동으로 가리지 않습니다(필요하면 "면허번호" 버튼으로 직접 가림).

## 사진이 서버로 가지 않는지 확인하는 방법
1. **코드**: 화면 동작은 `site/app.js` 하나에 있습니다. 이 파일에는 이미지를 보내는 코드(`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`)가 없습니다. 직접 검색해 보세요.
2. **보안 정책(CSP)**: `site/index.html`의 `<meta http-equiv="Content-Security-Policy">`에 `connect-src 'none'`이 있어, 페이지 스크립트가 fetch·XHR·WebSocket 등으로 외부에 데이터를 보낼 수 없습니다. 서버 설정(`site/.htaccess`)의 CSP는 글자 인식 worker와 오프라인 저장(service worker)이 같은 사이트의 인식 파일을 받을 수 있게 `connect-src 'self'`만 허용합니다.
3. **오프라인 시험**: 한 번 열어 "오프라인 사용 준비됨"이 뜬 뒤 비행기 모드로 바꾸고 새로고침해도 처음부터 끝까지 작동합니다.
4. **개발자 도구**: 브라우저 개발자 도구의 네트워크 탭에서, 사진을 고른 뒤 외부 주소로 나가는 요청이 없는지 볼 수 있습니다.

## 구조
- `site/` — 서버(public_html)에 그대로 올리는 파일입니다. 빌드 과정이 없으며 이 파일들이 원본입니다.
- `site/sw.js` — 오프라인 작동용 service worker(같은 사이트 파일만 저장).
- `site/vendor/` — 글자 인식 라이브러리와 데이터(외부 CDN을 쓰지 않고 사이트에 포함).

## 사용 라이브러리와 라이선스
| 구성요소 | 라이선스 | 파일 |
|---|---|---|
| tesseract.js 5.1.1 | Apache-2.0 | `site/vendor/tesseract/` (LICENSE.md, *.LICENSE.txt) |
| tesseract.js-core 5.1.1 (Tesseract OCR, Leptonica 등 포함) | Apache-2.0 / Leptonica BSD-2-Clause 등 | `site/vendor/core/` (LICENSE, LEPTONICA-LICENSE.txt) |
| eng.traineddata (tessdata_best 정수화본, 4.0.0_best_int) | Apache-2.0 (npm 패키지 표기 MIT) | `site/vendor/lang/` (LICENSE) |

자세한 내용은 `site/licenses.html`을 보세요. 이 저장소의 원래 코드는 MIT 라이선스(`LICENSE`)입니다.

---

**English (short)** — A web tool that covers the back digits of a Korean resident registration number on ID photos with solid black boxes, entirely in the browser. Live: https://idcover.kr/ . No upload code in `site/app.js`; the page CSP sets `connect-src 'none'`, so page scripts cannot send data out via fetch/XHR/WebSocket; works offline after the first visit (airplane-mode test). Third-party: tesseract.js / tesseract.js-core (Apache-2.0, includes Leptonica BSD-2-Clause), tessdata_best eng (Apache-2.0). Our code: MIT.
