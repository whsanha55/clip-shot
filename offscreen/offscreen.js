// Clip Shot - OCR 실행용 offscreen 문서
// Tesseract worker를 한 번 만들어 재사용하고, 요청은 하나씩 순서대로 처리한다.
// 모든 파일은 패키지 안(vendor/tesseract)에서 읽는다 — 네트워크 요청 없음.

const IDLE_CLOSE_MS = 120000; // 마지막 응답 후 이 시간 동안 요청이 없으면 스스로 닫는다

let workerPromise = null;
let queue = Promise.resolve();
let pending = 0;
let idleTimer = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return; // content/popup 메시지도 여기로 온다
  if (message.type === 'OCR_RUN') {
    enqueue(message.dataUrl, message.psm).then(sendResponse);
    return true; // 비동기 응답
  }
});

function enqueue(dataUrl, psm) {
  pending += 1;
  clearTimeout(idleTimer); // 인식 중에는 닫히지 않게 한다
  const job = queue.then(() => run(dataUrl, psm));
  queue = job.catch(() => {});
  return job.finally(() => {
    pending -= 1;
    if (pending === 0) idleTimer = setTimeout(() => window.close(), IDLE_CLOSE_MS);
  });
}

async function run(dataUrl, psm) {
  try {
    const worker = await getWorker();
    // 재시도마다 페이지 분할 모드를 바꿔 본다 (3 자동, 6 단일 블록, 4 단일 열)
    await worker.setParameters({ tessedit_pageseg_mode: psm || '3' });
    const { data } = await worker.recognize(dataUrl, {}, { blocks: true });
    return { ok: true, lines: flattenLines(data.blocks ?? []) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function getWorker() {
  if (!workerPromise) {
    const base = chrome.runtime.getURL('vendor/tesseract/');
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker(['kor', 'eng'], 1 /* LSTM_ONLY */, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'tesseract-core-simd-lstm.wasm.js',
        langPath: base + 'lang',
        workerBlobURL: false, // blob: worker는 확장 프로그램 CSP에 막힌다
        cacheMethod: 'none',
        gzip: true,
        // 진행률은 background가 요청한 탭으로 전달한다
        logger: (m) => {
          chrome.runtime.sendMessage({ target: 'background', type: 'OCR_PROGRESS', status: m.status, progress: m.progress })
            .catch(() => {});
        },
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; }); // 실패하면 다음 요청에서 재시도
  }
  return workerPromise;
}

// blocks → paragraphs → lines를 줄 목록으로 평탄화한다 (문단은 content가 줄 간격으로 나눈다)
function flattenLines(blocks) {
  const lines = [];
  for (const block of blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const text = line.text.replace(/\s+$/, '');
        if (text) lines.push({ text, bbox: line.bbox });
      }
    }
  }
  return lines;
}
