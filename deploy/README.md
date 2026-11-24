# 배포 — Cloudflare Pages (저장소 Private 전환)

- 결정: 2026-11-24 저장소 Private 전환(A안). GitHub Pages는 Private 저장소에서 유료라 Cloudflare Pages(무료)로 이전
- 배포 방식: `main`에 푸시 → Cloudflare가 자동으로 `bash deploy/build.sh` 실행 → `dist/`만 공개
- `build.sh`는 **허용 목록**: 사이트에 필요한 페이지·스크립트·템플릿만 복사. 데이터 JSON·SQL·CSV·백업·문서는 배포되지 않음
- 새 페이지·스크립트·템플릿을 추가하면 `build.sh`의 `FILES`에 넣어야 사이트에 올라감
- `_headers`: 검색 색인 금지 + HTML·JS 매번 새 버전 확인(캐시 때문에 "푸시했는데 반영 안 됨" 방지)

## 전환 순서 (끊김 없이: 새 주소 확인 → 그다음 Private)

### 1. 커밋 푸시
```
git push origin main
```

### 2. Cloudflare Pages 프로젝트 만들기 (사용자)
1. Cloudflare 계정 만들기 (무료)
2. Workers & Pages → Create → **Pages** → Connect to Git
3. GitHub 연결 승인 — 저장소 접근은 **Only select repositories → 이 저장소 하나만**
4. 설정
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: `bash deploy/build.sh`
   - Build output directory: `dist`
5. Save and Deploy → 주소 `https://<프로젝트명>.pages.dev` 생성
   - 프로젝트명은 회사·브랜드를 드러내지 않는 이름 권장 (주소에 그대로 노출)

### 3. 새 주소 점검
- [ ] On 로그인 → Summary·탭 정상, 콘솔 오류 없음
- [ ] Off 진입·로그인, KPI 로그인
- [ ] 로그인이 안 되면: Supabase `validate-token` 엣지함수의 CORS 허용 출처에 새 주소 추가 (지금 `*`면 그대로 됨)
- [ ] Data Update 업로드 1건 (저장까지)
- [ ] `<주소>/sku_Seoul.json`, `<주소>/Rofo/rofo.json` → 404 확인 (데이터 파일 미배포)

### 4. 사용자 공지
- 새 주소 공유, 기존 즐겨찾기 교체

### 5. GitHub Pages 끄기 → Private 전환 (사용자)
1. 저장소 Settings → Pages → 게시 해제(Unpublish)
2. Settings → General → Danger Zone → Change visibility → **Private**
3. 확인: 로그아웃 상태 브라우저에서 저장소 주소·기존 github.io 주소가 404

## 남는 노출 (후속 작업)
Private 전환으로 **저장소 파일과 커밋 이력**은 닫히지만, **배포된 페이지 안에 들어 있는 숫자**는 주소를 아는 사람에게 여전히 보인다:
- `index.html` 내장 시드(DASHBOARD_DATA), `Off/off_seed.js`
- `kpi.html` 하드코딩(인센티브 지역 할당·SR 타겟 등)
- `freight_master.js`, `range_master.js` (기준 데이터)

정리 방향: 시드는 빈 구조로 바꾸고(운영값은 이미 Supabase에서 로드), 하드코딩 숫자는 Supabase 테이블로 이전.
급하면 Cloudflare Access(무료, 이메일 인증)로 사이트 전체 앞에 로그인을 하나 더 둘 수 있음.

이미 공개됐던 내용(검색엔진·외부 캐시)은 회수할 수 없다. 포크는 0개(2026-11-24 확인).
