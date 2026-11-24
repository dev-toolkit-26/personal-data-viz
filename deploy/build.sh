#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  배포 산출물 만들기 — 사이트에 필요한 파일만 dist/로 복사한다 (허용 목록 방식)
#  · Cloudflare Pages: Build command = `bash deploy/build.sh`, Build output directory = `dist`
#  · 저장소에 있는 데이터 파일(JSON·SQL·CSV·백업)·스크립트·문서는 배포되지 않는다.
#  · 새 페이지·스크립트·템플릿을 추가하면 아래 FILES에 넣어야 사이트에 올라간다.
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  # 페이지
  index.html
  kpi.html
  keg_co2.html
  value_chain.html
  Off/index.html
  # 스크립트
  data_session.js
  off_ingest.js
  freight.js
  freight_master.js
  range_dc.js
  range_master.js
  transport_logic.js
  tts-dictionary.js
  chart.min.js
  xlsx.min.js
  Off/off_seed.js
  Off/tts-dictionary.js
  # 업로드 템플릿 (kpi.html 다운로드 링크)
  On_Trade_BD_template.xlsx
  "Snow_업데이트_템플릿.xlsx"
  # 호스팅 설정
  deploy/_headers
)

rm -rf dist
mkdir -p dist
missing=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "누락: $f" >&2; missing=1; continue; fi
  dest="dist/$f"
  [ "$f" = "deploy/_headers" ] && dest="dist/_headers"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
done
[ "$missing" -eq 0 ] || { echo "필수 파일 누락 — 배포 중단" >&2; exit 1; }
echo "dist/ 준비 완료: $(find dist -type f | wc -l)개 파일"
