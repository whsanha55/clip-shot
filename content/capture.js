// Clip Shot - 캡처 엔진 (콘텐츠 스크립트)
// 부분 캡처(선택 UI), 전체 페이지 캡처, 보이는 영역 복사를 모두 수행한다.
// 클립보드 쓰기는 포커스를 가진 문서에서만 가능하므로 여기서 직접 실행한다.

(() => {
  // 재주입 시 리스너가 중복 등록되지 않게 한다 (실행은 메시지로 다시 요청됨)
  if (window.__clipShotEngine) return;

  const Z_INDEX = 2147483647;
  const MIN_SIZE = 4;       // 이보다 작으면 취소로 간주
  const STABILIZE_MS = 250; // 스크롤 직후 렌더 안정화 최소 대기
  // captureVisibleTab은 초당 2회 제한 → 연속 호출은 이 간격 이상 벌린다
  const MIN_CALL_GAP = 510;
  const MAX_CANVAS_DEVICE = 32000; // Canvas 하드 리밋
  const OCR_TIMEOUT_MS = 30000;

  // 기본값은 background가 소유한다 (GET_SETTINGS로 받음)
  let settings = { maxHeight: 15000, onLimit: 'truncate', filenamePrefix: 'clip-shot', autoSave: false };

  let ocrBusy = false;        // 캡처~인식 진행 중
  let closeTextLayer = null;  // 텍스트 레이어가 떠 있으면 닫는 함수

  // ── 진입점 (background가 주입 후 tabs.sendMessage로 호출) ────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;
    if (type === 'OCR_PROGRESS') {
      if (onOcrProgress) onOcrProgress(message);
      return;
    }
    if (type !== 'RUN_PARTIAL' && type !== 'RUN_FULL' && type !== 'RUN_OCR') return;
    sendResponse({ ok: true });
    if (ocrBusy) return; // 인식이 끝날 때까지 새 작업은 무시한다
    if (closeTextLayer) closeTextLayer();
    if (type === 'RUN_PARTIAL') startSelection('capture');
    else if (type === 'RUN_OCR') startSelection('ocr');
    else runFullPage();
  });

  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res?.ok) settings = res.settings;
    } catch (_err) {
      // 설정 조회 실패 시 기본값 유지
    }
  }

  // ── 모드 실행 ──────────────────────────────────────────────────────

  // 전체 페이지: 문서 전체 높이를 세로 스크롤하며 이어붙인다
  async function runFullPage() {
    try {
      await loadSettings();
      // clientWidth = 세로 스크롤바 제외 폭 (스크롤바가 조각마다 중복되지 않게)
      const w = Math.min(document.documentElement.clientWidth, window.innerWidth);
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      );
      if (h <= 0) return;
      await captureAndCopy({ x: 0, y: 0, w, h });
    } catch (err) {
      showBadge('캡처 실패: ' + describeError(err), true);
    }
  }

  async function captureAndCopy(rect) {
    const capPx = maxCaptureCss();
    if (settings.onLimit === 'cancel' && rect.h > capPx) {
      showBadge('최대 높이(' + capPx + 'px) 초과로 취소되었습니다', true);
      return;
    }

    const result = await captureRegion(rect, capPx);
    if (!result) return; // 취소됨 (배지는 captureRegion 안에서 표시)

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })]);
    await finishSave(result.blob, result.capped
      ? '최대 높이(' + capPx + 'px)까지만 캡처 · 클립보드에 복사됨 ✓'
      : '클립보드에 복사됨 ✓ (' + result.w + '×' + result.h + 'px)');
  }

  // 자동 저장 설정에 따라 저장까지 처리하고 배지를 띄운다
  async function finishSave(blob, text) {
    if (settings.autoSave) {
      try {
        downloadBlob(blob, buildFilename());
        showBadge(text + ' · 저장됨');
      } catch (_err) {
        showBadge(text + ' · 저장 실패');
      }
      return;
    }
    showBadge(text, { save: blob });
  }

  function maxCaptureCss() {
    // 기획서 3.2: 실제 적용값 = min(사용자 설정, 32,000 ÷ DPR)
    return Math.min(settings.maxHeight, Math.floor(MAX_CANVAS_DEVICE / window.devicePixelRatio));
  }

  // ── 부분 캡처 선택 UI ─────────────────────────────────────────────

  let active = false;

  // mode: 'capture'(이미지 복사) | 'ocr'(텍스트 추출, 뷰포트 안에서만 선택)
  function startSelection(mode) {
    if (active) return;
    active = true;
    const isOcr = mode === 'ocr';

    const overlay = document.createElement('div');
    overlay.setAttribute('data-clip-shot', '1');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:' + Z_INDEX +
      ';background:rgba(0,0,0,.35);cursor:crosshair;user-select:none;';

    const hint = document.createElement('span');
    hint.setAttribute('data-clip-shot', '1');
    hint.textContent = isOcr
      ? '드래그로 텍스트 영역 선택 · Esc 취소'
      : '드래그로 선택 · 가장자리에 두면 스크롤 · Esc 취소';
    hint.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
      'padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;' +
      'font:13px/1 system-ui,sans-serif;pointer-events:none;';
    overlay.appendChild(hint);

    const box = document.createElement('div');
    box.setAttribute('data-clip-shot', '1');
    box.style.cssText =
      'position:fixed;display:none;pointer-events:none;box-sizing:border-box;' +
      'border:2px solid #818cf8;background:rgba(99,102,241,.15);';
    overlay.appendChild(box);

    document.documentElement.appendChild(overlay);

    // 선택 앵커는 페이지 좌표로, 커서는 뷰포트 좌표로 추적한다.
    // 트랙패드는 드래그 중 휠 스크롤이 불가능하므로, 커서를 상/하 가장자리에
    // 두면 자동 스크롤되며 영역이 확장된다.
    let dragging = false;
    let startPageX = 0;
    let startPageY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let rafId = 0;

    const EDGE = 48;      // 가장자리 자동 스크롤 시작 거리 (px)
    const MAX_SPEED = 28; // 최대 스크롤 속도 (px/프레임)

    function curPageX() {
      return lastClientX + window.scrollX;
    }
    function curPageY() {
      return lastClientY + window.scrollY;
    }

    function renderBox() {
      // 페이지 좌표 → 현재 뷰포트 기준 위치로 그린다
      const left = Math.min(startPageX, curPageX()) - window.scrollX;
      const top = Math.min(startPageY, curPageY()) - window.scrollY;
      const w = Math.abs(curPageX() - startPageX);
      const h = Math.abs(curPageY() - startPageY);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = w + 'px';
      box.style.height = h + 'px';
    }

    function autoScrollStep() {
      if (!dragging || isOcr) return; // OCR은 스크롤 확장 없이 뷰포트 안에서만
      let dy = 0;
      if (lastClientY > window.innerHeight - EDGE) {
        // 하단 가장자리: 가까울수록 빠르게 아래로
        dy = Math.min(MAX_SPEED, Math.ceil((MAX_SPEED * (lastClientY - (window.innerHeight - EDGE))) / EDGE));
      } else if (lastClientY < EDGE) {
        // 상단 가장자리: 위로 확장
        dy = -Math.min(MAX_SPEED, Math.ceil((MAX_SPEED * (EDGE - lastClientY)) / EDGE));
      }
      if (dy !== 0) {
        window.scrollBy(0, dy);
        renderBox();
      }
      rafId = requestAnimationFrame(autoScrollStep);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') cleanup();
    }
    function onContextMenu(e) {
      e.preventDefault();
    }
    function onPointerDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      overlay.setPointerCapture(e.pointerId);
      dragging = true;
      startPageX = e.clientX + window.scrollX;
      startPageY = e.clientY + window.scrollY;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      box.style.display = 'block';
      renderBox();
      rafId = requestAnimationFrame(autoScrollStep);
    }
    // OCR은 포인터가 뷰포트 밖으로 나가도 선택을 뷰포트 안으로 제한한다
    function clampX(x) {
      return isOcr ? Math.min(Math.max(x, 0), window.innerWidth) : x;
    }
    function clampY(y) {
      return isOcr ? Math.min(Math.max(y, 0), window.innerHeight) : y;
    }
    function onPointerMove(e) {
      if (!dragging) return;
      lastClientX = clampX(e.clientX);
      lastClientY = clampY(e.clientY);
      renderBox();
    }
    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(rafId);
      const endPageX = clampX(e.clientX) + window.scrollX;
      const endPageY = clampY(e.clientY) + window.scrollY;
      const rect = {
        x: Math.min(startPageX, endPageX),
        y: Math.min(startPageY, endPageY),
        w: Math.abs(endPageX - startPageX),
        h: Math.abs(endPageY - startPageY),
      };
      cleanup();
      if (rect.w >= MIN_SIZE && rect.h >= MIN_SIZE && isOcr) {
        runOcr(rect);
      } else if (rect.w >= MIN_SIZE && rect.h >= MIN_SIZE) {
        loadSettings()
          .then(() => captureAndCopy(rect))
          .catch((err) => showBadge('캡처 실패: ' + describeError(err), true));
      }
    }
    function onWheel(e) {
      e.preventDefault();
      if (!dragging || isOcr) return; // 드래그 전 스크롤은 차단 (좌표 기준 유지)
      // 마우스처럼 드래그 중 휠 스크롤이 가능한 입력기의 확장 경로
      const dy = e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * window.innerHeight
        : e.deltaY;
      window.scrollBy(0, dy);
      renderBox();
    }
    function onScroll() {
      if (dragging) renderBox(); // 그 외 경로의 스크롤에도 박스 위치 유지
    }

    function cleanup() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.removeEventListener('wheel', onWheel);
      overlay.removeEventListener('contextmenu', onContextMenu);
      overlay.remove();
      active = false;
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('contextmenu', onContextMenu);
  }

  // ── OCR ───────────────────────────────────────────────────────────

  // 재시도할 때마다 순서대로 바꿔 보는 처리 방식 (같은 이미지·같은 설정이면 결과가 같다).
  // scale: 기기 픽셀 기준 확대 배율, psm: Tesseract 페이지 분할 모드(3 자동, 6 단일 블록, 4 단일 열)
  const OCR_VARIANTS = [
    { name: '기본', scale: (dpr) => (dpr < 2 ? 2 : 1), filter: 'none', psm: '3' },
    { name: '흑백·2배·단일 블록', scale: () => 2, filter: 'grayscale(1) contrast(1.5)', psm: '6' },
    { name: '3배·단일 열', scale: () => 3, filter: 'none', psm: '4' },
  ];
  const MAX_OCR_CANVAS = 8000; // 확대 후 한 변 최대 px (메모리·시간 제한)

  let onOcrProgress = null; // 인식 진행률 수신 (background가 offscreen 진행률을 전달)

  // rect: 페이지 CSS px (OCR 선택은 스크롤이 없으므로 뷰포트 안에 있다)
  async function runOcr(rect) {
    ocrBusy = true;
    try {
      // 오버레이 제거가 화면 프레임에 반영된 뒤에 캡처해야 선택 박스가 안 찍힌다
      await nextFrames(2);
      const sx = window.scrollX;
      const sy = window.scrollY;
      const dpr = window.devicePixelRatio;
      const res = await requestCapture();
      const bmp = await fetchBitmap(res.dataUrl);
      const r = computeCropRect({ x: rect.x - sx, y: rect.y - sy, w: rect.w, h: rect.h }, dpr, bmp.width, bmp.height);
      // 재시도에 다시 쓰도록 잘라낸 원본(기기 px)을 보관한다
      const source = document.createElement('canvas');
      source.width = r.w;
      source.height = r.h;
      source.getContext('2d').drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      bmp.close();
      const region = { left: r.x / dpr + sx, top: r.y / dpr + sy, w: r.w / dpr, h: r.h / dpr };
      await recognizeAndShow(source, region, dpr, 0);
    } catch (err) {
      showBadge('텍스트 인식 실패: ' + describeError(err), true);
    } finally {
      ocrBusy = false;
    }
  }

  // 실패·취소 시 기존 레이어(재시도 전 결과)는 그대로 둔다
  async function recognizeAndShow(source, region, dpr, variantIndex) {
    ocrBusy = true;
    const variant = OCR_VARIANTS[variantIndex];
    const t0 = performance.now();
    let onEsc = null;
    const aborted = new Promise((resolve) => {
      onEsc = (e) => { if (e.key === 'Escape') resolve('aborted'); };
      window.addEventListener('keydown', onEsc, true);
    });
    const shield = createShield('텍스트 인식 준비 중… (Esc 취소)');
    onOcrProgress = (p) => {
      shield.update(p.status === 'recognizing text'
        ? '텍스트 인식 중… ' + Math.round(p.progress * 100) + '% (Esc 취소)'
        : '텍스트 인식 준비 중… (Esc 취소)');
    };

    try {
      const scale = Math.min(variant.scale(dpr), MAX_OCR_CANVAS / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(source.width * scale);
      canvas.height = Math.round(source.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.filter = variant.filter;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: 'OCR_RECOGNIZE', dataUrl: canvas.toDataURL('image/png'), psm: variant.psm }),
        aborted,
        sleep(OCR_TIMEOUT_MS).then(() => ({ ok: false, error: '인식 시간 초과' })),
      ]);
      if (result === 'aborted') {
        showBadge('텍스트 추출이 취소되었습니다', true);
        return;
      }
      if (!result?.ok) throw new Error(result?.error ?? '알 수 없는 오류');
      if (result.lines.length === 0) {
        showBadge('인식된 텍스트가 없습니다 (' + variant.name + ')', true);
        return;
      }

      // bbox(확대된 이미지 px) → 영역 기준 CSS px
      const k = canvas.width / (source.width / dpr);
      const lines = assignParagraphs(result.lines.map((l) => ({
        text: l.text,
        x: l.bbox.x0 / k,
        y: l.bbox.y0 / k,
        w: (l.bbox.x1 - l.bbox.x0) / k,
        h: (l.bbox.y1 - l.bbox.y0) / k,
      })));
      if (closeTextLayer) closeTextLayer();
      renderTextLayer(region, lines, {
        variantName: variant.name,
        onRetry: () => recognizeAndShow(source, region, dpr, (variantIndex + 1) % OCR_VARIANTS.length),
      });
      console.log('[clip-shot] ocr ms', Math.round(performance.now() - t0), variant.name);
    } catch (err) {
      showBadge('텍스트 인식 실패: ' + describeError(err), true);
    } finally {
      window.removeEventListener('keydown', onEsc, true);
      onOcrProgress = null;
      shield.remove();
      ocrBusy = false;
    }
  }

  // Tesseract의 문단 구분은 줄마다 끊기는 경우가 많아, 줄 간격(중심 사이 거리)으로 문단을 나눈다.
  // 글자 높이는 줄마다 들쭉날쭉하므로 bbox 사이 빈 공간이 아니라 중심 간격을 비교한다.
  function assignParagraphs(lines) {
    const sorted = [...lines].sort((a, b) => a.y - b.y);
    const center = (l) => l.y + l.h / 2;
    const pitches = sorted.slice(1).map((l, i) => center(l) - center(sorted[i])).sort((a, b) => a - b);
    const medianPitch = pitches[Math.floor(pitches.length / 2)] || 0;
    let paragraph = 0;
    sorted.forEach((l, i) => {
      if (i > 0 && center(l) - center(sorted[i - 1]) > medianPitch * 1.4) paragraph += 1;
      l.paragraph = paragraph;
    });
    return sorted;
  }

  // 원문 위에 선택 가능한 투명 텍스트를 겹친다 (macOS 라이브 텍스트 방식).
  // 페이지 CSS·복사 차단 스크립트의 영향을 줄이려고 closed Shadow DOM에 그린다.
  // opts: { variantName, onRetry } — 툴바의 처리 방식 표시와 [재시도] 동작
  function renderTextLayer(region, lines, opts) {
    const host = document.createElement('div');
    host.setAttribute('data-clip-shot', '1');
    host.style.cssText =
      'position:absolute;margin:0;padding:0;border:0;z-index:' + Z_INDEX +
      ';left:' + region.left + 'px;top:' + region.top + 'px;width:' + region.w + 'px;height:' + region.h + 'px;';
    const root = host.attachShadow({ mode: 'closed' });

    const barInside = region.top - window.scrollY < 40; // 위에 공간이 없으면 영역 안쪽에 둔다
    // 결과 패널: 오른쪽 → 왼쪽 → 아래 순서로 화면 안에 들어가는 곳에 둔다
    const PANEL_W = 320;
    const GAP = 12;
    const vpLeft = region.left - window.scrollX;
    const panelPos = vpLeft + region.w + GAP + PANEL_W <= window.innerWidth
      ? 'left:' + (region.w + GAP) + 'px;top:0'
      : vpLeft >= PANEL_W + GAP
        ? 'left:' + -(PANEL_W + GAP) + 'px;top:0'
        : 'left:0;top:' + (region.h + GAP) + 'px';
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.frame{position:absolute;inset:0;outline:2px solid rgba(99,102,241,.9);background:rgba(99,102,241,.06);cursor:text}' +
      '.line{position:absolute;white-space:pre;color:transparent;font-family:system-ui,sans-serif;' +
      'transform-origin:0 0;cursor:text;user-select:text;-webkit-user-select:text}' +
      '.line::selection{background:rgba(99,102,241,.35);color:transparent}' +
      '.bar{position:absolute;left:0;top:' + (barInside ? '6px' : '-38px') + ';display:flex;align-items:center;gap:6px;' +
      'padding:5px 6px;border-radius:8px;background:#1f2430;color:#fff;font:12px/1 system-ui,sans-serif;' +
      'white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.25);user-select:none;-webkit-user-select:none}' +
      '.bar button{padding:5px 10px;border:none;border-radius:6px;font:inherit;font-weight:600;cursor:pointer;' +
      'background:#374151;color:#fff}' +
      '.bar button.primary{background:#4f46e5}' +
      '.bar span{padding:0 4px;color:#cbd5e1}' +
      '.line.hl{background:rgba(250,204,21,.35)}' +
      '.panel{position:absolute;' + panelPos + ';width:' + PANEL_W + 'px;max-height:' + Math.max(region.h, 240) + 'px;' +
      'overflow:auto;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:#fff;color:#1f2430;' +
      'border:1px solid #e5e7eb;box-shadow:0 8px 24px rgba(0,0,0,.18);font:13px/1.55 system-ui,sans-serif;' +
      'user-select:text;-webkit-user-select:text;cursor:text}' +
      '.panel h2{margin:0 0 6px;font-size:12px;font-weight:600;color:#6b7280;user-select:none;-webkit-user-select:none}' +
      '.row{padding:1px 4px;border-radius:4px;white-space:pre-wrap;word-break:break-all}' +
      '.row.para{margin-top:10px}' +
      '.row:hover{background:#eef2ff}' +
      '</style>' +
      '<div class="frame"></div>' +
      '<div class="bar"><button class="primary" data-act="copy">전체 복사</button>' +
      '<button data-act="retry">재시도</button>' +
      '<button data-act="close">닫기</button><span></span></div>' +
      '<div class="panel"><h2></h2></div>';
    root.querySelector('.bar span').textContent = lines.length + '줄 · ' + opts.variantName;
    root.querySelector('.panel h2').textContent = '인식 결과 — 줄에 올리면 원문 위치 표시';

    const frame = root.querySelector('.frame');
    const lineEls = lines.map((l) => {
      const el = document.createElement('div');
      el.className = 'line';
      el.textContent = l.text;
      el.style.left = l.x + 'px';
      el.style.top = l.y + 'px';
      el.style.height = l.h + 'px';
      el.style.lineHeight = l.h + 'px';
      el.style.fontSize = l.h * 0.85 + 'px';
      frame.appendChild(el);
      return el;
    });

    // 결과 패널: 줄마다 한 행, 올리면 원문의 해당 줄을 강조한다
    const panel = root.querySelector('.panel');
    lines.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i > 0 && l.paragraph !== lines[i - 1].paragraph ? ' para' : '');
      row.textContent = l.text;
      row.addEventListener('mouseenter', () => lineEls[i].classList.add('hl'));
      row.addEventListener('mouseleave', () => lineEls[i].classList.remove('hl'));
      panel.appendChild(row);
    });

    document.documentElement.appendChild(host);
    // 글꼴 폭이 원문과 다르므로 측정 후 가로로 늘리거나 줄여 원문 폭에 맞춘다
    lineEls.forEach((el, i) => {
      const natural = el.getBoundingClientRect().width;
      if (natural > 0) el.style.transform = 'scaleX(' + lines[i].w / natural + ')';
    });

    // 선택 범위에 걸친 줄만 모아 복사 텍스트를 만든다 (줄 \n, 문단 \n\n)
    function joinLines(parts) {
      let out = '';
      let prev = null;
      for (const p of parts) {
        if (prev !== null) out += p.paragraph === prev ? '\n' : '\n\n';
        out += p.text;
        prev = p.paragraph;
      }
      return out;
    }
    function selectedText() {
      const sel = root.getSelection ? root.getSelection() : document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
      if (panel.contains(sel.anchorNode)) return sel.toString(); // 패널에서 고른 글은 그대로
      const range = sel.getRangeAt(0);
      const parts = [];
      lineEls.forEach((el, i) => {
        if (!range.intersectsNode(el)) return;
        const node = el.firstChild;
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset
          : range.endContainer === el && range.endOffset === 0 ? 0 : node.length;
        const text = node.data.slice(start, end);
        if (text) parts.push({ text, paragraph: lines[i].paragraph });
      });
      return joinLines(parts);
    }
    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        showBadge(text.length + '자 복사됨 ✓');
      } catch (_err) {
        showBadge('복사 실패', true);
      }
    }

    function onKeyDown(e) {
      if (ocrBusy) return; // 재시도 중 Esc는 인식 취소로만 쓴다
      if (e.key === 'Escape') {
        close();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const text = selectedText();
        if (!text) return;
        // 페이지의 복사 차단 핸들러보다 먼저 처리하고 전파를 끊는다
        e.preventDefault();
        e.stopImmediatePropagation();
        copy(text);
      }
    }
    function onOutsidePointer(e) {
      if (ocrBusy) return; // 재시도 중에는 진행 표시가 화면을 덮는다
      if (!e.composedPath().includes(host)) close();
    }
    function close() {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onOutsidePointer, true);
      window.removeEventListener('resize', close);
      host.remove();
      closeTextLayer = null;
    }

    root.querySelector('.bar').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'copy') copy(joinLines(lines));
      else if (act === 'retry' && !ocrBusy) opts.onRetry();
      else if (act === 'close') close();
    });
    // 레이어 안의 선택·복사 이벤트가 페이지의 차단 핸들러까지 올라가지 않게 한다
    for (const type of ['selectstart', 'mousedown', 'mouseup', 'pointerdown', 'dragstart', 'contextmenu', 'copy']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('resize', close);
    closeTextLayer = close;
  }

  // ── 캡처 엔진 ─────────────────────────────────────────────────────

  async function captureRegion(rect, capPx) {
    const dpr = window.devicePixelRatio;
    const vpH = window.innerHeight;
    const capped = rect.h > capPx;
    const end = rect.y + Math.min(rect.h, capPx);

    // 뷰포트 안에 전부 들어오면 스크롤 없이 1회 캡처 (빠른 경로)
    if (!capped && rect.y >= window.scrollY - 1 && end <= window.scrollY + vpH + 1) {
      // 오버레이 제거가 화면 프레임에 반영된 뒤에 캡처해야 선택 박스가 안 찍힌다
      await nextFrames(2);
      const res = await requestCapture();
      const bmp = await fetchBitmap(res.dataUrl);
      const r = computeCropRect(
        { x: rect.x, y: rect.y - window.scrollY, w: rect.w, h: rect.h },
        dpr, bmp.width, bmp.height
      );
      return await cropToPng(bmp, r);
    }

    // 뷰포트보다 큰 영역: 스크롤하며 조각 캡처 후 세로로 이어붙임
    const savedX = window.scrollX;
    const savedY = window.scrollY;
    let aborted = false;
    const onEsc = (e) => { if (e.key === 'Escape') aborted = true; };
    window.addEventListener('keydown', onEsc, true);
    const shield = createShield('캡처 중… 0%');
    let fixedEls = null; // 첫 조각 이후 숨긴 고정 요소 (기획서 2.2③)

    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(rect.w * dpr);
      canvas.height = Math.round((end - rect.y) * dpr);
      const ctx = canvas.getContext('2d');

      let y = rect.y;
      let drawnTo = rect.y; // 실제 그린 마지막 지점 (페이지가 짧으면 end보다 작을 수 있음)
      let lastCaptureAt = performance.now() - MIN_CALL_GAP; // 첫 장은 안정화 대기만
      while (y < end && !aborted) {
        window.scrollTo(0, y);
        // 쿼터 간격을 넘었는지 계산해 필요한 만큼만 기다린다 (스크롤 안정화 포함)
        const remain = MIN_CALL_GAP - (performance.now() - lastCaptureAt);
        await sleep(Math.max(STABILIZE_MS, remain));
        if (aborted) break;

        const sy = window.scrollY; // 스크롤은 클램프/소수 가능 → 실제 값 기준으로 계산
        const from = Math.max(y, sy);
        const to = Math.min(end, sy + vpH);
        if (to <= from || to <= y) break; // 더 이상 진행 불가 (페이지 끝)

        await shield.hideForCapture(); // 진행 표시가 결과에 찍히지 않게
        const res = await requestCapture();
        lastCaptureAt = performance.now();
        shield.show();
        const bmp = await fetchBitmap(res.dataUrl);

        const srcX = clampInt(rect.x * dpr, 0, bmp.width - 1);
        const srcW = clampInt(rect.w * dpr, 1, bmp.width - srcX);
        const srcY = clampInt((from - sy) * dpr, 0, bmp.height - 1);
        const srcH = clampInt((to - from) * dpr, 1, bmp.height - srcY);
        const dstY = Math.round((from - rect.y) * dpr);
        ctx.drawImage(bmp, srcX, srcY, srcW, srcH, 0, dstY, srcW, srcH);
        bmp.close();

        // 첫 조각에는 헤더 등이 보이고, 이후 조각에는 반복되지 않게 숨긴다
        if (!fixedEls) {
          fixedEls = collectFixedElements();
          setFixedHidden(fixedEls, true);
        }

        drawnTo = to;
        y = to;
        shield.update('캡처 중… ' + Math.round(((drawnTo - rect.y) / (end - rect.y)) * 100) + '%');
      }

      if (aborted) {
        showBadge('캡처가 취소되었습니다', true);
        return null;
      }
      if (drawnTo <= rect.y) throw new Error('캡처할 수 있는 영역이 없습니다.');

      // 페이지가 짧아 end까지 못 채운 경우 그린 만큼으로 자른다
      let finalCanvas = canvas;
      if (drawnTo < end) {
        finalCanvas = document.createElement('canvas');
        finalCanvas.width = canvas.width;
        finalCanvas.height = Math.round((drawnTo - rect.y) * dpr);
        finalCanvas.getContext('2d').drawImage(canvas, 0, 0);
      }
      const result = await canvasToPng(finalCanvas);
      return { blob: result.blob, w: result.w, h: result.h, capped, capPx };
    } finally {
      if (fixedEls) setFixedHidden(fixedEls, false);
      window.removeEventListener('keydown', onEsc, true);
      shield.remove();
      window.scrollTo(savedX, savedY); // 스크롤 위치 복구
    }
  }

  // fixed/sticky 요소 찾기 (확장 UI는 제외)
  function collectFixedElements() {
    const out = [];
    if (!document.body) return out;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[data-clip-shot]')) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') out.push(el);
    }
    return out;
  }

  function setFixedHidden(els, hidden) {
    for (const el of els) {
      if (hidden) {
        el.setAttribute('data-clip-shot-visibility', el.style.visibility);
        el.style.visibility = 'hidden';
      } else {
        el.style.visibility = el.getAttribute('data-clip-shot-visibility') ?? '';
        el.removeAttribute('data-clip-shot-visibility');
      }
    }
  }

  async function requestCapture() {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE' });
    if (!res?.ok) throw new Error(res?.error ?? '알 수 없는 오류');
    return res;
  }

  function computeCropRect(rect, dpr, imgW, imgH) {
    // CSS px → device px. captureVisibleTab 결과는 device px 좌표계다.
    const x = Math.min(Math.max(Math.round(rect.x * dpr), 0), imgW - 1);
    const y = Math.min(Math.max(Math.round(rect.y * dpr), 0), imgH - 1);
    const w = Math.min(Math.max(Math.round(rect.w * dpr), 1), imgW - x);
    const h = Math.min(Math.max(Math.round(rect.h * dpr), 1), imgH - y);
    return { x, y, w, h };
  }

  async function cropToPng(bmp, r) {
    const canvas = document.createElement('canvas');
    canvas.width = r.w;
    canvas.height = r.h;
    canvas.getContext('2d').drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return await canvasToPng(canvas);
  }

  function canvasToPng(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve({ blob: b, w: canvas.width, h: canvas.height }) : reject(new Error('PNG 변환 실패'))), 'image/png')
    );
  }

  async function fetchBitmap(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    return await createImageBitmap(blob);
  }

  // 캡처 중 입력 차단 + 진행 표시 (캡처 순간에는 숨겨 결과에 찍히지 않게 한다)
  function createShield(initialText) {
    const shield = document.createElement('div');
    shield.setAttribute('data-clip-shot', '1');
    shield.style.cssText = 'position:fixed;inset:0;z-index:' + Z_INDEX + ';cursor:wait;';
    const label = document.createElement('div');
    label.setAttribute('data-clip-shot', '1');
    label.textContent = initialText;
    label.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
      'padding:8px 14px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;' +
      'font:13px/1 system-ui,sans-serif;';
    shield.appendChild(label);
    const block = (e) => e.preventDefault();
    shield.addEventListener('wheel', block, { passive: false });
    shield.addEventListener('contextmenu', block);
    document.documentElement.appendChild(shield);

    return {
      update(text) { label.textContent = text; },
      show() { shield.style.visibility = 'visible'; },
      async hideForCapture() {
        shield.style.visibility = 'hidden';
        await nextFrames(2); // 화면에서 사라진 프레임이 캡처되도록
      },
      remove() { shield.remove(); },
    };
  }

  // ── 결과 표시 · 저장 ───────────────────────────────────────────────

  // opts: true → 오류 스타일, {save: Blob} → 성공 + [저장] 버튼
  function showBadge(text, opts) {
    const isError = opts === true;
    const el = document.createElement('div');
    el.setAttribute('data-clip-shot', '1');
    el.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:' + Z_INDEX +
      ';display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;' +
      'background:' + (isError ? '#dc2626' : '#1f2430') +
      ';color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
      'opacity:0;transition:opacity .2s;';

    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);

    if (opts && opts.save) {
      const btn = document.createElement('button');
      btn.textContent = '저장';
      btn.style.cssText =
        'padding:4px 12px;border:none;border-radius:6px;background:#4f46e5;color:#fff;' +
        'font:inherit;font-weight:600;cursor:pointer;';
      btn.addEventListener('click', () => {
        try {
          downloadBlob(opts.save, buildFilename());
          btn.textContent = '저장됨 ✓';
          btn.disabled = true;
        } catch (_err) {
          btn.textContent = '실패';
        }
      });
      el.appendChild(btn);
    }

    document.documentElement.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));

    let hideTimer = 0;
    el.addEventListener('mouseenter', () => clearTimeout(hideTimer)); // 올려두면 유지
    hideTimer = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, opts && opts.save ? 6000 : isError ? 5000 : 2500);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('data-clip-shot', '1');
    a.href = url;
    a.download = filename.replace(/[\\/:*?"<>|]/g, '_'); // 파일명에 못 쓰는 문자 제거
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function buildFilename() {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
      '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
    return (settings.filenamePrefix || 'clip-shot') + '-' + stamp + '.png';
  }

  // ── 유틸 ──────────────────────────────────────────────────────────

  function clampInt(v, min, max) {
    return Math.min(Math.max(Math.round(v), min), max);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrames(n) {
    return new Promise((resolve) => {
      const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
      step(n);
    });
  }

  function describeError(err) {
    if (typeof err === 'string') return err;
    return err?.message ?? String(err);
  }

  window.__clipShotEngine = true;
})();
