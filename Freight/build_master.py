# -*- coding: utf-8 -*-
"""
Freight/build_master.py — 기준 CSV → 루트 freight_master.js 재생성

  python Freight/build_master.py

· 기준데이터_코드권역매핑.csv   : 코드,배송처명,통합도매장,권역,누적배송료  (KCTC 물류 기준 전체 코드 — Off 코드 섞여 있음)
· on_codes_dsr.csv             : DSR에서 Team=On(ALSM 제외)으로 등장한 코드 목록 → 매핑을 이 코드(+통합마스터)로만 필터
                                 (모든 기준은 DSR(On). 물류 기준 데이터의 Off 코드는 제외)
· 기준데이터_코드통합마스터.csv : 배송처코드,배송처명,통합그룹,권역,통합정산 (KCTC 통합정산 확정 75코드)
요율표·제외코드는 아래 상수(RATES/EXCLUDE)에 하드코딩 — 계약 변경 시 여기만 수정.
LY 비교는 DSR 2025 백필(on_freight_months)로 동일 소스끼리 하므로 KCTC 베이스라인 CSV는 쓰지 않는다.
"""
import json, os, sys
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REG = ['수도권', '충청권', '전라권', '경상권', '강원권', '제주권']
RATES = {  # 원/박스, 구간 [01~05, 06~10, 11~20, 21~60, Over60] — 2025=2026 동결
    '수도권': [870, 840, 820, 750, 600],
    '충청권': [1220, 1170, 1110, 1050, 990],
    '전라권': [1420, 1340, 1270, 1210, 1140],
    '경상권': [1370, 1320, 1260, 1200, 1130],
    '강원권': [2040, 1810, 1570, 1520, 1460],
    '제주권': [2500, 2500, 2500, 2500, 2500],   # 구간 무관 단일요율
}
EXCLUDE = ['34122', '34137', '33988', '85326']  # On 제외(Off 재분류): 중부한남체인, 디오니엘앤비

def main():
    mp = pd.read_csv(os.path.join(HERE, '기준데이터_코드권역매핑.csv'), encoding='utf-8-sig', dtype=str)
    cm = pd.read_csv(os.path.join(HERE, '기준데이터_코드통합마스터.csv'), encoding='utf-8-sig', dtype=str)
    for c in mp.columns: mp[c] = mp[c].astype(str).str.strip()
    for c in cm.columns: cm[c] = cm[c].astype(str).str.strip()
    ri = {r: i for i, r in enumerate(REG)}
    bad = set(mp['권역']) - set(REG)
    if bad: sys.exit(f'알 수 없는 권역: {bad}')
    if mp['코드'].duplicated().any(): sys.exit(f"중복 코드: {mp[mp['코드'].duplicated()]['코드'].tolist()}")
    # DSR(On) 코드로만 필터 — Off 코드 제외
    on_path = os.path.join(HERE, 'on_codes_dsr.csv')
    if os.path.exists(on_path):
        on_codes = set(pd.read_csv(on_path, dtype=str)['코드'].str.strip())
        before = len(mp)
        mp = mp[mp['코드'].isin(on_codes) | mp['코드'].isin(set(cm['배송처코드']))]
        print(f'DSR(On) 코드 필터: {before} → {len(mp)} (Off 코드 {before - len(mp)}개 제외) · DSR On 코드 중 매핑 없음: {sorted(on_codes - set(mp["코드"]))}')
    else:
        print('경고: on_codes_dsr.csv 없음 → 매핑 전체 사용(Off 코드 포함)')
    consol = {r['배송처코드']: [r['통합그룹'], ri[r['권역']]] for _, r in cm.iterrows()}
    codes = {r['코드']: [r['배송처명'], ri[r['권역']]] for _, r in mp.iterrows()}
    missing = [c for c in consol if c not in codes]
    if missing: print('경고: 통합마스터 코드가 권역매핑에 없음 →', missing)
    out = {
        'regions': REG, 'rates': RATES, 'tier_max': [5, 10, 20, 60],
        'tier_labels': ['01~05', '06~10', '11~20', '21~60', 'Over 60'],
        'exclude': EXCLUDE, 'consol': consol, 'codes': codes,
    }
    js = ("// ═══════════════════════════════════════════════════════════════════\n"
          "//  freight_master.js — On-Trade 운송비 기준 데이터 (생성 파일: 수정 시 Freight/build_master.py 로 재생성)\n"
          "//  · KCTC 계약 요율표(원/박스, 2025=2026 동결), 코드→배송처명·권역(DSR On 코드만), 통합정산 그룹, On 제외코드.\n"
          "//  · 소스: Freight/기준데이터_코드권역매핑.csv(+on_codes_dsr.csv 필터) / 기준데이터_코드통합마스터.csv\n"
          "// ═══════════════════════════════════════════════════════════════════\n"
          "window.FREIGHT_MASTER = " + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ";\n")
    dst = os.path.join(ROOT, 'freight_master.js')
    with open(dst, 'w', encoding='utf-8') as f: f.write(js)
    print(f'{dst}: {len(js):,} bytes · codes {len(codes)} · consol {len(consol)}')

if __name__ == '__main__':
    main()
