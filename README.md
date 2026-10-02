# Clip Shot

캡처하면 즉시 클립보드에 복사되고, 파일 저장은 원할 때만 하는 크롬 확장 프로그램.

## 현재 상태: v0.6

- **보이는 영역 캡처** → 캡처 즉시 PNG가 클립보드에 복사됩니다.
- **부분 캡처** → 드래그로 영역을 선택하면 그 부분만 클립보드에 복사됩니다 (DPR 보정, `Esc` 취소).
  - 드래그 중 스크롤하거나 **커서를 화면 상/하단 가장자리에 두면** (트랙패드용) 영역이 확장되고, 뷰포트보다 커지면 여러 장을 이어붙입니다.
- **전체 페이지 캡처** → 문서 전체 높이를 자동으로 스크롤하며 이어붙여 복사합니다. 진행률 표시, `Esc` 중간 취소, 스크롤 위치 복구를 지원합니다.
- **최대 높이 정책** → `min(사용자 설정, 32,000 ÷ DPR)`. 초과 시 잘라서 복사하거나 취소(설정에서 선택)합니다.
- **저장** → 완료 배지의 [저장] 버튼 또는 팝업의 [PNG으로 저장]으로 즉시 다운로드합니다. 설정에서 캡처 후 자동 저장도 가능합니다.
- **단축키** → 부분 캡처 Mac `⌘⇧S` / Windows·Linux `Alt+Shift+S`, 텍스트 추출 Mac `⌘⇧E` / Windows·Linux `Alt+Shift+E` (보이는 영역·전체 페이지는 팝업 버튼으로 실행)
- **텍스트 추출 (OCR)** → 드래그한 영역의 글자를 인식해 원문 위에 선택 가능한 투명 텍스트를 겹칩니다. 원하는 부분만 드래그해 `⌘C`로 복사하거나 [전체 복사]를 누릅니다. 복사가 막힌 페이지에서도 동작하며, 인식은 기기 안(Tesseract.js, 한국어+영어)에서만 이루어집니다. 인식 중에는 진행률을, 끝나면 영역 옆 패널에 인식 결과를 줄 단위로 보여주고(줄에 올리면 원문 위치 강조), [재시도]는 같은 영역을 다른 처리 방식(흑백·확대·페이지 분할 모드)으로 다시 인식합니다.
- **고정 요소 처리** → 이어붙임 캡처 중 fixed/sticky 요소(헤더 등)는 첫 조각에만 나타나고 이후 조각에서는 숨겨집니다. 종료 시 원상 복구됩니다.

## 설치 (Chrome 웹 스토어)

[Clip Shot - Chrome 웹 스토어](https://chromewebstore.google.com/detail/cibogmpampdcdbaoccmklfejlpeiailh)에서 설치합니다.

- 게시 버전: v0.5.2 (v0.6.0 심사 중)
- 개인정보처리방침: [PRIVACY.md](PRIVACY.md) — 웹스토어에는 raw URL(`https://raw.githubusercontent.com/whsanha55/clip-shot/main/PRIVACY.md`)로 등록되어 있다 (GitHub blob 페이지가 심사 서버의 연결 확인에 실패하는 경우가 있음)

## 설치 (개발 모드)

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램 로드** → 이 폴더(`clip-shot`) 선택

## 사용법

| 동작 | 방법 |
|---|---|
| 보이는 영역 복사 | 팝업 버튼 |
| 부분 캡처 | 팝업 버튼 또는 `⌘⇧S` (Windows/Linux: `Alt+Shift+S`) → 드래그 (확장: 스크롤/가장자리) |
| 전체 페이지 캡처 | 팝업 버튼 |
| 텍스트 추출 (OCR) | 팝업 버튼 또는 `⌘⇧E` (Windows/Linux: `Alt+Shift+E`) → 드래그 → 텍스트 선택 후 `⌘C` 또는 [전체 복사] (닫기: `Esc`, 바깥 클릭) |
| 저장 | 완료 배지의 [저장], 팝업의 [PNG으로 저장], 또는 자동 저장 설정 |

복사 결과는 Slack, Notion, 문서 등에 `Ctrl/Cmd + V`로 붙여넣습니다.

## 설정

확장 상세 페이지의 **확장 프로그램 옵션**에서:

- 최대 캡처 높이 (5,000 ~ 30,000 CSS px, 기본 15,000)
- 한도 도달 시 동작 (잘라서 복사 / 캡처 취소)
- 파일명 접두사 (기본 `clip-shot`)
- 캡처 후 자동 저장

## 구조

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 매니페스트 (권한: activeTab, clipboardWrite, offscreen, scripting, storage) |
| `background.js` | Service Worker — `captureVisibleTab` 호출, 엔진 주입, 단축키 라우팅, 설정 소유, OCR offscreen 관리 |
| `content/capture.js` | 캡처 엔진 — 선택 UI · DPR 보정 crop · 스크롤 이어붙임 · 고정 요소 숨김 · 클립보드 쓰기 · 저장 · OCR 텍스트 레이어 |
| `offscreen/` | OCR 실행용 offscreen 문서 — Tesseract worker 재사용, 120초 유휴 시 자동 종료 |
| `vendor/tesseract/` | Tesseract.js 6.0.1 + core 6.1.2 + kor/eng 언어 데이터 (`tools/vendor_tesseract.sh`로 재생성) |
| `tools/test-pages/` | OCR 수동 테스트 페이지 (기본 · 복사 차단 · 이미지) |
| `popup/` | 모드 선택 + 보이는 영역 클립보드 쓰기/저장 |
| `options/` | 사용자 설정 페이지 |
| `tools/make_icons.py` | 아이콘 생성 스크립트 (Python 표준 라이브러리만 사용) |

### 설계 메모

- **클립보드 쓰기는 포커스를 가진 문서에서만 동작**한다. 그래서 보이는 영역(팝업 클릭 직후)은 팝업이, 부분/전체/단축키(페이지 조작 직후)는 콘텐츠 스크립트가 쓴다.
- **이어붙임 속도**: `captureVisibleTab`이 Chrome 정책상 초당 2회로 제한되어 장당 최소 ~0.5초가 필요하다. 호출 간격을 추적해 불필요한 대기는 제거했다.
- **저장은 blob anchor 다운로드**로 동작한다 — `chrome.downloads` 권한 없이, 데이터 URL 크기 제한 없이, 클릭한 컨텍스트에서 즉시 내려받는다.
- **호스트 권한 없이 activeTab만 쓴다** — 팝업 클릭과 `commands` 단축키 모두 activeTab을 부여하므로 `<all_urls>`가 필요 없다.
- **OCR은 offscreen 문서에서 실행**한다 — Service Worker는 Web Worker를 쓸 수 없고, 콘텐츠 스크립트는 페이지 CSP에 막힐 수 있다. 웹스토어는 원격 코드를 금지하므로 worker·wasm·언어 데이터를 모두 패키지에 넣고, wasm 실행을 위해 CSP에 `wasm-unsafe-eval`을 둔다. blob worker는 CSP에 막히므로 `workerBlobURL: false`.
- **OCR 텍스트 레이어는 closed Shadow DOM**에 그린다 — 페이지 CSS와 복사 차단 스크립트(`user-select:none`, `copy`·`selectstart` 차단)의 영향을 줄인다. `⌘C`는 window 캡처 단계에서 먼저 가로채 직접 클립보드에 쓴다. 문단은 Tesseract의 문단 구분 대신 줄 중심 간격으로 나눈다.
- **이미지 미리보기는 제거됨** — 콘텐츠 스크립트가 만든 요소는 페이지 CSP를 따라 `blob:` 이미지가 깨지는 사이트가 있어 페이지 내 미리보기를 제거했고, 팝업 썸네일도 요청으로 함께 제거했다. 결과는 배지 텍스트(크기 포함)로 안내한다.

## 로드맵

- [x] **M1** 보이는 영역 캡처 + 클립보드 복사
- [x] **M2** 부분 캡처 + DPR 보정 (스크롤 확장 포함)
- [x] **M3** 전체 페이지 캡처 + 최대 높이 제한
- [x] **M4** 결과 배지 + 저장 버튼
- [x] **M5** 단축키, 옵션 페이지, 고정 요소 처리
- [x] **M6-a** 웹스토어 등록 (v0.5.2 게시)
- [ ] **M6-b** 내부 스크롤 대응, 분할 저장
- [x] **v0.6** 텍스트 추출 (OCR)

## 알려진 한계

- 이어붙임 조각 경계에 ±1px 이음새가 생길 수 있다.
- 스크롤 시점에 따라 lazy-load 이미지가 빈 채로 찍힐 수 있다.
- `chrome://`, 웹스토어 등 제한 페이지에서는 캡처할 수 없다 (안내 배지 표시).
- 가로로 스크롤되는 페이지는 뷰포트 폭까지만 캡처된다.
- OCR은 뷰포트 안에서만 선택된다. 한글 조사 앞에 영문이 붙은 경우(`Shot은` → `Shot2`)나 드문 음절은 잘못 인식될 수 있다.
- OCR 레이어의 `⌘C` 가로채기는 페이지가 window 캡처 단계에서 먼저 전파를 끊으면 동작하지 않는다. 이때는 [전체 복사]를 쓴다.

## 개발

아이콘 재생성: `python3 tools/make_icons.py`

Tesseract 파일 재생성: `./tools/vendor_tesseract.sh` (버전은 스크립트 상단에 고정, `vendor/tesseract/SHA256SUMS` 갱신)

OCR 테스트 페이지는 로컬 서버로 연다 (`file://`는 확장 상세의 "파일 URL에 대한 액세스 허용"이 꺼져 있으면 캡처가 막힘): `python3 -m http.server 8765` → `http://localhost:8765/tools/test-pages/`

코드 수정 후에는 `chrome://extensions`에서 확장 카드의 새로고침(↻) 버튼을 눌러 반영합니다.
