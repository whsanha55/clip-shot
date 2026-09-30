// Clip Shot - 팝업
// 보이는 영역: 클릭 직후 팝업이 포커스를 가지므로 팝업이 클립보드에 쓴다.
// 부분/전체: 엔진 주입만 요청하고 팝업을 닫는다 (페이지에서 상호작용).

const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save-png');
const captureVisibleBtn = document.getElementById('capture-visible');
const capturePartialBtn = document.getElementById('capture-partial');
const captureFullBtn = document.getElementById('capture-full');
const captureOcrBtn = document.getElementById('capture-ocr');

let settings = null;

// 단축키 안내는 플랫폼별 기본값(맥: ⌘⇧, 그 외: Alt+Shift)으로 표시한다
const isMac = /Mac/i.test(navigator.platform);
const SHORTCUTS = isMac
  ? { 'capture-partial': '⌘⇧S', 'ocr-partial': '⌘⇧E' }
  : { 'capture-partial': 'Alt+Shift+S', 'ocr-partial': 'Alt+Shift+E' };
document.querySelectorAll('kbd[data-cmd]').forEach((kbd) => {
  kbd.textContent = SHORTCUTS[kbd.dataset.cmd] ?? '';
});

captureVisibleBtn.addEventListener('click', () => capture(captureVisibleBtn));

// 페이지에서 드래그/스크롤해야 하므로 팝업은 즉시 닫는다
capturePartialBtn.addEventListener('click', () => startAndClose('START_PARTIAL', capturePartialBtn));
captureFullBtn.addEventListener('click', () => startAndClose('START_FULL', captureFullBtn));
captureOcrBtn.addEventListener('click', () => startAndClose('START_OCR', captureOcrBtn));

saveBtn.addEventListener('click', () => {
  if (!saveBtn.dataset.dataUrl) return;
  downloadDataUrl(saveBtn.dataset.dataUrl, buildFilename());
  saveBtn.textContent = '저장됨 ✓';
  saveBtn.disabled = true;
});

async function startAndClose(type, button) {
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type });
  } catch (err) {
    statusEl.textContent = `실패: ${err?.message ?? String(err)}`;
    button.disabled = false;
    return;
  }
  window.close();
}

async function capture(button) {
  button.disabled = true;
  setStatus('캡처 중…');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE' });
    if (!res?.ok) throw new Error(res?.error ?? '알 수 없는 오류');

    setStatus('클립보드에 쓰는 중…');
    await writePngToClipboard(res.dataUrl);

    if (!settings) settings = await loadSettings();
    if (settings.autoSave) {
      downloadDataUrl(res.dataUrl, buildFilename());
      setStatus('클립보드에 복사됨 ✓ · 저장됨');
    } else {
      saveBtn.dataset.dataUrl = res.dataUrl;
      saveBtn.hidden = false;
      setStatus('클립보드에 복사됨 ✓');
    }
  } catch (err) {
    setStatus(`실패: ${err?.message ?? String(err)}`);
  } finally {
    button.disabled = false;
  }
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.ok) return res.settings;
  } catch (_err) { /* 기본값 사용 */ }
  return {};
}

async function writePngToClipboard(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_'); // 파일명에 못 쓰는 문자 제거
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildFilename() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) +
    '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
  return ((settings && settings.filenamePrefix) || 'clip-shot') + '-' + stamp + '.png';
}

function setStatus(text) {
  statusEl.textContent = text;
}
