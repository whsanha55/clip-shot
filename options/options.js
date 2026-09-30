// Clip Shot - 옵션 페이지
// 기본값은 background가 소유한다 (GET_SETTINGS로 받아 온다)

const form = document.getElementById('options-form');
const maxHeightInput = document.getElementById('max-height');
const onLimitSelect = document.getElementById('on-limit');
const filenamePrefixInput = document.getElementById('filename-prefix');
const autoSaveInput = document.getElementById('auto-save');
const saveStatusEl = document.getElementById('save-status');

let saveStatusTimer = 0;

document.addEventListener('DOMContentLoaded', load);

async function load() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!res?.ok) throw new Error(res?.error);
    const s = res.settings;
    maxHeightInput.value = s.maxHeight;
    onLimitSelect.value = s.onLimit;
    filenamePrefixInput.value = s.filenamePrefix;
    autoSaveInput.checked = !!s.autoSave;
  } catch (err) {
    showSaveStatus('설정을 불러오지 못했습니다: ' + (err?.message ?? err), true);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const maxHeight = clamp(parseInt(maxHeightInput.value, 10) || 15000, 5000, 30000);
  maxHeightInput.value = maxHeight;

  try {
    await chrome.storage.sync.set({
      maxHeight,
      onLimit: onLimitSelect.value === 'cancel' ? 'cancel' : 'truncate',
      filenamePrefix: (filenamePrefixInput.value.trim() || 'clip-shot'),
      autoSave: autoSaveInput.checked,
    });
    showSaveStatus('저장됨 ✓');
  } catch (err) {
    showSaveStatus('저장 실패: ' + (err?.message ?? err), true);
  }
});

function showSaveStatus(text, isError) {
  saveStatusEl.textContent = text;
  saveStatusEl.style.color = isError ? '#dc2626' : '#16a34a';
  clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => (saveStatusEl.textContent = ''), 3000);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
