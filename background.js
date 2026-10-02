// Clip Shot - Service Worker
// 캡처 호출, 콘텐츠 스크립트(capture.js) 주입, 사용자 설정 소유

// 캡처가 금지된 브라우저 내부 페이지 (chrome://, 웹스토어 등)
const RESTRICTED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension):/i;

// 설정 기본값의 단일 소스 (옵션 페이지·엔진은 GET_SETTINGS로 받아 간다)
const DEFAULT_SETTINGS = {
  maxHeight: 15000,          // 최대 캡처 높이 (CSS px)
  onLimit: 'truncate',       // 한도 도달 시 동작: truncate(잘라서 복사) | cancel(취소)
  filenamePrefix: 'clip-shot',
  autoSave: false,           // 캡처 후 자동 저장
};

// 팝업 요청 → 탭에서 실행할 모드
const START_TO_RUN = {
  START_PARTIAL: 'RUN_PARTIAL',
  START_FULL: 'RUN_FULL',
  START_OCR: 'RUN_OCR',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return; // offscreen 문서가 처리한다
  if (message?.type === 'CAPTURE_VISIBLE') {
    captureVisible()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // 비동기 응답
  }
  if (START_TO_RUN[message?.type]) {
    runInTab(START_TO_RUN[message.type])
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // 비동기 응답
  }
  if (message?.type === 'OCR_PROGRESS') {
    if (ocrTabId !== null) {
      chrome.tabs.sendMessage(ocrTabId, { type: 'OCR_PROGRESS', status: message.status, progress: message.progress })
        .catch(() => {});
    }
    return;
  }
  if (message?.type === 'OCR_RECOGNIZE') {
    ocrTabId = sender.tab?.id ?? null;
    recognize(message.dataUrl, message.psm)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // 비동기 응답
  }
  if (message?.type === 'GET_SETTINGS') {
    getSettings()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
    return true; // 비동기 응답
  }
});

// 단축키 (chrome://extensions/shortcuts에서 변경 가능)
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-partial') {
    runInTab('RUN_PARTIAL').catch(console.error);
  } else if (command === 'ocr-partial') {
    runInTab('RUN_OCR').catch(console.error);
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function captureVisible() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, error: '활성 탭을 찾을 수 없습니다.' };
  }
  if (RESTRICTED_URL.test(tab.url ?? '')) {
    return { ok: false, error: '이 페이지(chrome:// 등)에서는 캡처할 수 없습니다.' };
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { ok: true, dataUrl };
}

// 엔진 주입 후 해당 모드 실행을 탭에 요청한다
async function runInTab(runType) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, error: '활성 탭을 찾을 수 없습니다.' };
  }
  if (RESTRICTED_URL.test(tab.url ?? '')) {
    return { ok: false, error: '이 페이지(chrome:// 등)에서는 캡처할 수 없습니다.' };
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/capture.js'],
  });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: runType });
  } catch (_err) {
    // 엔진이 즉시 응답하지 않는 경우는 무시 (작업은 비동기로 계속됨)
  }
  return { ok: true };
}

// ── OCR: Tesseract는 offscreen 문서에서 실행한다 (SW는 Web Worker를 쓸 수 없음) ──

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null; // 동시 호출 시 생성 중인 promise를 공유한다
let ocrTabId = null;          // 진행률을 전달할 탭 (가장 최근 OCR 요청)

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: '캡처 이미지에서 텍스트를 인식(OCR)하는 Tesseract Web Worker 실행',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function recognize(dataUrl, psm) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OCR_RUN', dataUrl, psm });
  return res ?? { ok: false, error: 'OCR 응답이 없습니다.' };
}

async function getSettings() {
  // get에 기본값을 넘기면 없는 키만 채워 반환된다
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ok: true, settings };
}

function describeError(err) {
  if (typeof err === 'string') return err;
  return err?.message ?? String(err);
}
