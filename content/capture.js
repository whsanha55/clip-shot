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

  // 기본값은 background가 소유한다 (GET_SETTINGS로 받음)
  let settings = { maxHeight: 15000, onLimit: 'truncate', filenamePrefix: 'clip-shot', autoSave: false };

  // ── 진입점 (background가 주입 후 tabs.sendMessage로 호출) ────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'RUN_PARTIAL') {
      sendResponse({ ok: true });
      startSelection();
    } else if (message?.type === 'RUN_FULL') {
      sendResponse({ ok: true });
      runFullPage();
    }
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

  function startSelection() {
    if (active) return;
    active = true;

    const overlay = document.createElement('div');
    overlay.setAttribute('data-clip-shot', '1');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:' + Z_INDEX +
      ';background:rgba(0,0,0,.35);cursor:crosshair;user-select:none;';

    const hint = document.createElement('span');
    hint.setAttribute('data-clip-shot', '1');
    hint.textContent = '드래그로 선택 · 가장자리에 두면 스크롤 · Esc 취소';
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
      if (!dragging) return;
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
    function onPointerMove(e) {
      if (!dragging) return;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      renderBox();
    }
    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(rafId);
      const endPageX = e.clientX + window.scrollX;
      const endPageY = e.clientY + window.scrollY;
      const rect = {
        x: Math.min(startPageX, endPageX),
        y: Math.min(startPageY, endPageY),
        w: Math.abs(endPageX - startPageX),
        h: Math.abs(endPageY - startPageY),
      };
      cleanup();
      if (rect.w >= MIN_SIZE && rect.h >= MIN_SIZE) {
        loadSettings()
          .then(() => captureAndCopy(rect))
          .catch((err) => showBadge('캡처 실패: ' + describeError(err), true));
      }
    }
    function onWheel(e) {
      e.preventDefault();
      if (!dragging) return; // 드래그 전 스크롤은 차단 (좌표 기준 유지)
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
