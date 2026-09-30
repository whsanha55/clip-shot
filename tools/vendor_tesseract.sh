#!/usr/bin/env bash
# Tesseract.js 번들 파일을 vendor/tesseract/에 고정 버전으로 내려받는다.
# 웹스토어 정책(원격 코드 금지) 때문에 worker·wasm·언어 데이터를 모두 패키지에 포함한다.
set -euo pipefail

TESSERACT_JS=6.0.1
TESSERACT_CORE=6.1.2
LANG_DATA=1.0.0 # @tesseract.js-data/{kor,eng}, 4.0.0_best_int 모델 사용

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/tesseract"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
for pkg in "tesseract.js@$TESSERACT_JS" "tesseract.js-core@$TESSERACT_CORE" \
  "@tesseract.js-data/kor@$LANG_DATA" "@tesseract.js-data/eng@$LANG_DATA"; do
  tgz="$(npm pack "$pkg" --silent)"
  dir="${tgz%.tgz}"
  mkdir "$dir" && tar xzf "$tgz" -C "$dir" --strip-components=1
done

rm -rf "$OUT" && mkdir -p "$OUT/lang"
cp "tesseract.js-$TESSERACT_JS/dist/tesseract.min.js" "$OUT/"
cp "tesseract.js-$TESSERACT_JS/dist/worker.min.js" "$OUT/"
cp "tesseract.js-$TESSERACT_JS/LICENSE.md" "$OUT/LICENSE"
# minimum_chrome_version 116 → SIMD는 항상 지원되므로 SIMD+LSTM 코어 하나만 넣는다
cp "tesseract.js-core-$TESSERACT_CORE/tesseract-core-simd-lstm.wasm.js" "$OUT/"
cp "tesseract.js-data-kor-$LANG_DATA/4.0.0_best_int/kor.traineddata.gz" "$OUT/lang/"
cp "tesseract.js-data-eng-$LANG_DATA/4.0.0_best_int/eng.traineddata.gz" "$OUT/lang/"

cd "$OUT"
find . -type f ! -name SHA256SUMS | sort | xargs shasum -a 256 > SHA256SUMS
echo "vendor/tesseract 갱신 완료:"
du -sh "$OUT"
