/**
 * transport_logic.js — On-Trade 운송비 계산 참조 구현 (검증 완료 로직)
 *
 * 물류마감내역서 19개월 전수 대조로 검증된 실제 과금 규칙을 그대로 구현한 순수 함수 모듈.
 * Claude Code 지시: 이 파일의 함수를 수정 없이 사용하고 UI 연결만 구현할 것.
 * 계산 규칙 변경이 필요하면 코드를 고치지 말고 사용자에게 확인할 것.
 *
 * 입력 행 형식 (마감내역서/DSR 공통 정규화):
 *   { code: '33278', date: '2026-07-01', region: '수도권',
 *     type: '맥주배송'|'스마트오더'|'반품'|'회송'|..., qty: 20, note: '파손맞교환...' }
 */

// ── 기준 상수 ────────────────────────────────────────────────
const RATES = {
  '수도권': [870, 840, 820, 750, 600],
  '충청권': [1220, 1170, 1110, 1050, 990],
  '전라권': [1420, 1340, 1270, 1210, 1140],
  '경상권': [1370, 1320, 1260, 1200, 1130],
  '강원권': [2040, 1810, 1570, 1520, 1460],
  '제주권': [2500, 2500, 2500, 2500, 2500],
};
const BRACKET_LABELS = ['01~05', '06~10', '11~20', '21~60', 'Over 60'];
const EXCLUDED_CODES = new Set(['34122', '34137', '33988', '85326']); // Off 재분류 확정

// codeGroupMap: 기준데이터_코드통합마스터.csv 로드 결과 { code → 통합그룹명 }
// 마스터에 없는 코드는 자기 자신이 그룹 (단독 정산)

// ── 기본 함수 ────────────────────────────────────────────────
function bracketIdx(qty) {
  if (qty <= 5) return 0;
  if (qty <= 10) return 1;
  if (qty <= 20) return 2;
  if (qty <= 60) return 3;
  return 4;
}
function rate(region, qty) {
  const r = RATES[region];
  return r ? r[bracketIdx(qty)] : null; // 미지정 권역은 null → 미매핑 버킷
}
function isShipment(row) { return row.type === '맥주배송' || row.type === '스마트오더'; }
function isReturn(row)   { return row.type === '반품'; }
function isReship(row)   { return row.type === '회송'; }
function isExchange(row) { return isShipment(row) && /교환/.test(row.note || ''); }
function normCode(c) {
  const s = String(c).trim();
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// ── 핵심: 3개 스트림 분리 계산 ───────────────────────────────
/**
 * 규칙 (검증 완료 — 변경 금지):
 *  1) 출고 구간 = 출고행(맥주배송+스마트오더, 교환출고 포함)만의 [통합그룹×일] 합산 박스.
 *     반품·회송 수량은 출고 구간에 절대 합산하지 않는다.
 *  2) 교환출고는 이미 출고행이므로 자동 합산된다. 별도 가산 금지(이중계산).
 *  3) 반품·회송은 각각 [통합그룹×일] 자체 합산 수량으로 구간 판정, 동일 요율표 적용.
 */
function computeFees(rows, codeGroupMap) {
  const streams = { 출고: new Map(), 반품: new Map(), 회송: new Map() };
  const exchangeByKey = new Map(); // 단독 교환출고 알림용

  for (const raw of rows) {
    const code = normCode(raw.code);
    if (EXCLUDED_CODES.has(code)) continue;
    const group = codeGroupMap[code] || code;
    const key = `${group}|${raw.date}|${raw.region}`;
    const qty = Number(raw.qty) || 0;

    let bucket = null;
    if (isShipment(raw)) bucket = streams.출고;
    else if (isReturn(raw)) bucket = streams.반품;
    else if (isReship(raw)) bucket = streams.회송;
    else continue; // POSM 등 기타 유형은 이 모듈 범위 밖

    bucket.set(key, (bucket.get(key) || 0) + qty);
    if (isExchange(raw)) {
      exchangeByKey.set(key, (exchangeByKey.get(key) || 0) + qty);
    }
  }

  const detail = [];
  const totals = { 출고: 0, 반품: 0, 회송: 0 };
  for (const [stream, map] of Object.entries(streams)) {
    for (const [key, qty] of map) {
      const [group, date, region] = key.split('|');
      const r = rate(region, qty);
      const fee = r === null ? null : r * qty;
      if (fee !== null) totals[stream] += fee;
      detail.push({ stream, group, date, region, qty,
                    bracket: BRACKET_LABELS[bracketIdx(qty)], rate: r, fee });
    }
  }
  return { detail, totals, 총물류비: totals.출고 + totals.반품 + totals.회송, exchangeByKey };
}

// ── 알림 B-1: 단독 교환출고 ─────────────────────────────────
/** 교환 태그가 있는 [그룹×일] 중 그날 출고 합산이 5박스 이하인 건.
 *  절감액 = (01~05 요율 − 해당 그룹 최근 4주 최빈 구간 요율) × 교환박스 */
function soloExchangeAlerts(feeResult, recentModeRateByGroup) {
  const alerts = [];
  for (const [key, exQty] of feeResult.exchangeByKey) {
    const row = feeResult.detail.find(d => d.stream === '출고' && `${d.group}|${d.date}|${d.region}` === key);
    if (!row || row.qty > 5) continue;
    const modeRate = recentModeRateByGroup[row.group] ?? rate(row.region, 30); // 이력 없으면 21~60 가정
    const save = Math.max(0, (rate(row.region, row.qty) - modeRate) * exQty);
    alerts.push({ ...row, 교환박스: exQty, 예상절감: save,
      메시지: '교환 출고는 정기 배송일 합류를 원칙으로 (품질 이슈 등 긴급 건 제외)' });
  }
  return alerts.sort((a, b) => b.예상절감 - a.예상절감);
}

// ── 알림 B-2: 반품 비용 급증 ────────────────────────────────
/** 당월 (반품+회송) 비용이 LY 동월 대비 +20% 이상이면 경고.
 *  lyMap: 기준데이터_반품회송_베이스라인.csv에서 {`${월}|${권역}` → LY 배송료 합} */
function returnSurgeAlert(feeResult, month, lyMap, region = '전체') {
  const cur = feeResult.detail
    .filter(d => (d.stream === '반품' || d.stream === '회송') &&
                 (region === '전체' || d.region === region))
    .reduce((s, d) => s + (d.fee || 0), 0);
  const ly = lyMap[`${month}|${region}`] || 0;
  const pct = ly ? (cur / ly - 1) * 100 : null;
  const smallShare = (() => {
    const rets = feeResult.detail.filter(d => d.stream === '반품');
    const small = rets.filter(d => d.qty <= 5).reduce((s, d) => s + (d.fee || 0), 0);
    const tot = rets.reduce((s, d) => s + (d.fee || 0), 0);
    return tot ? small / tot * 100 : 0;
  })();
  return { 당월: cur, LY동월: ly, 증감률: pct, 소량반품비중: smallShare,
           경고: pct !== null && pct >= 20 };
}

// 내보내기 (모듈/전역 겸용)
if (typeof module !== 'undefined') {
  module.exports = { RATES, bracketIdx, rate, normCode, computeFees,
                     soloExchangeAlerts, returnSurgeAlert, EXCLUDED_CODES };
}
if (typeof window !== 'undefined') {
  window.TransportLogic = { RATES, BRACKET_LABELS, bracketIdx, rate, normCode, computeFees,
                            soloExchangeAlerts, returnSurgeAlert, EXCLUDED_CODES,
                            isShipment, isReturn, isReship, isExchange };
}
