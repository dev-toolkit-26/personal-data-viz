# CLAUDE.md

## Weekly Review 프로젝트 연동
- 이 저장소의 Branch Check 작업은 claude.ai 프로젝트 "Weekly Review"와 로컬 공유 폴더 `.weekly-review/`로 연동한다
- 작업 시작 시 `.weekly-review/STATUS.md`와 `.weekly-review/연동규칙.md`를 먼저 읽는다
- 설계·항목 마스터는 `.weekly-review/설계_구조.md`, `.weekly-review/items.csv`를 따른다 (프로젝트 쪽이 관리)
- 커밋·푸시한 작업이 있을 때만 STATUS.md의 "코드" 칸을 갱신한다 (쓰기 직전 다시 읽고, 자기 칸만, 커밋 해시 포함)
- `.weekly-review/`는 gitignore 대상이다. 커밋에 넣지 않는다
- 이 저장소는 Public이다: 볼륨·GP·금액·거래처명·기준값은 코드와 커밋에 쓰지 않는다. 기준값은 Supabase에서 읽는다
