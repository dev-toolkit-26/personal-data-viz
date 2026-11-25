// ════════════════════════════════════════════════════════════════════
//  branch_weekly.js — 지점별 주간 분석 (Weekly Review 지점별분석 스펙 1단계) · Weekly Meeting 회의록 자동 카드
//
//  · 계산(compute)과 카드 HTML(cards)만 담당. 회의록 저장·잠금은 index.html(Minutes)이 한다.
//  · 입력은 대시보드 데이터(DASHBOARD_DATA)와 ALSM 모델(window._ALSM)뿐 — 새 데이터 소스 없음.
//  · 이 파일에는 규칙만 둔다. 물량·목표는 런타임에 Supabase 데이터에서 온다 (저장소 규칙).
//
//  지표 (2026-11-25 직관형으로 변경)
//   진도      : 지금 진도(MTD ÷ 월 FCST) vs 평소 이맘때 진도(발주패턴 연평균 누적비율) → 차이 %p
//   마감 전망 : MTD + 최근 2주 일평균 × 남은 영업일 → 월 FCST 대비 % 와 부족/초과 HL(c/s)
//   FCST 추이 : 이번 달 주차별 제출 FCST 흐름, 2주 연속 낮아지면 표시
//   목표 대비 : FCST·RoFo·AP 각각에 대해 "FCST가 목표의 몇 %" / "마감 전망이 목표의 몇 %"
//   단위      : HL + c/s 병기 (지점 합계 = 환산 c/s = HL ÷ 0.0792, SKU = 실제 박스 = HL ÷ SKU 계수, 20L은 keg)
//  월 전환 주(회의 주가 두 달에 걸침): ① 전월 마감 전망 ② 다음 달 시작(FCST 또는 미제출 시 RoFo, 필요 속도)
//  1단계 제외: NKA·미니바·DC 코드 구분(현재 집계에 없음), FCST 정확도(회의록 이력 쌓이면), 실행 진척(1월)
// ════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // ── 지점 정의: 데이터마다 키 표기가 달라 한곳에 모은다 ──
  const BRANCHES = [
    { key: 'seoul',   label: '서울',      hl: 'Seoul',        sku: 'Seoul',      book: 'Seoul',      groups: ['Seoul'],          cat: 'seoul'   },
    { key: 'busan',   label: '부산',      hl: 'Busan',        sku: 'BuSan',      book: 'BuSan',      groups: ['Busan'],          cat: 'busan'   },
    { key: 'daegu',   label: '대구·제주', hl: 'DaeGu & JeJu', sku: 'DaeGu&JeJu', book: 'DaeGu&JeJu', groups: ['Daegu', 'Jeju'],  cat: 'daegu'   },
    { key: 'gwangju', label: '광주',      hl: 'GwangJu',      sku: 'GwangJu',    book: 'GwangJu',    groups: ['Gwangju'],        cat: 'gwangju' },
    { key: 'daejeon', label: '대전',      hl: 'DaeJeon',      sku: 'DaeJeon',    book: 'DaeJeon',    groups: ['Daejeon'],        cat: 'daejeon' },
  ];

  // ── 핵심 SKU (지점별분석_스펙 3장). match = SKU 코드 판정 ──
  const SKU = {
    he20:  { label: 'HE 20L',       match: s => s === 'HE ORI 20000 Air Keg', unit: 'keg' },
    pa20:  { label: 'PA 20L',       match: s => /^PA \S+ 20000 Keg$/i.test(s), unit: 'keg' },
    he330b:{ label: 'HE 330병',     match: s => s === 'HE ORI 330 Bottle' },
    he00b: { label: 'HE 0.0 330병', match: s => s === 'HE 0.0 330 Bottle' },
    he330c:{ label: 'HE 330캔',     match: s => s === 'HE ORI 330 Can' },
    su500b:{ label: 'SNOW 500병',   match: s => s === 'SU ORI 500 Bottle' },
    he500c:{ label: 'HE 500캔',     match: s => s === 'HE ORI 500 Can' },
    pa500c:{ label: 'PA 500캔',     match: s => /^PA (WHE|HEL) 500 Can$/i.test(s) },
    ti500r:{ label: 'TI RAD 500캔', match: s => s === 'TI RAD 500 Can' },
  };
  const CORE = {
    seoul:   ['he20', 'pa20', 'he330b', 'he00b', 'su500b'],
    busan:   ['he20', 'pa20', 'he330b', 'he00b'],
    daegu:   ['he20', 'he330b', 'he330c', 'su500b'],
    gwangju: ['he20', 'he330b', 'su500b'],
    daejeon: ['he20', 'he330b'],
    alsm:    ['he500c', 'pa500c', 'ti500r'],
  };

  // ── 규칙 상수 ──
  const RULE = {
    progressWarn: -0.05, progressBad: -0.10,   // 진도: 지금 − 평소 이맘때  (−5%p 이내 유효 / −10%p 이내 주의 / 그 밖 깨짐)
    closeOk: 0.97, closeWarn: 0.90,            // 마감 전망 ÷ 월 FCST       (97%↑ 유효 / 90%↑ 주의 / 미만 깨짐)
    speedWarn: 0.0, speedBad: 0.20,            // 다음 달 필요 속도: 주당 필요 ÷ 최근 주당 − 1 (0% 이하 유효 / +20% 이하 주의)
    gapWarn: -0.05,                            // FCST가 RoFo보다 5% 넘게 낮으면 질문
    recentCalDays: 14,                         // 최근 실적 = DSR 기준일까지 최근 14일 구간 ÷ 그 구간 영업일 × 5
    weekDays: 5,
    csStd: 0.0792,                             // 환산 c/s 기준 (330ml × 24)
    downTol: 0.5,                              // FCST 연속 하향 판정 허용오차(HL)
    skuQuestionMinShare: 0.10,                 // SKU 질문은 지점 부족분의 10% 이상인 SKU만
    newSkuLyMin: 0.10,                         // 재고 예상 수요: 전년 누계가 올해 누계의 10% 미만이면 신규 SKU로 보고 계절지수 방식
    fcstLowVsDemand: 0.85,                     // 재고 과다인데 FCST가 예상 수요의 85% 미만이면 질문(재고 소진 대기 확인)
    fcstHighVsDemand: 1.15,                    // 재고 과다인데 FCST가 예상 수요의 115% 초과면 질문(도매장 재고 더 쌓일 위험)
    maxQuestions: 3,
  };

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const sumArr = (a, from, to) => { let s = 0; if (Array.isArray(a)) for (let i = from; i <= to; i++) s += +a[i] || 0; return s; };
  const SIG = { ok: { k: 'ok', lbl: '유효', rank: 0 }, warn: { k: 'warn', lbl: '주의', rank: 1 }, bad: { k: 'bad', lbl: '깨짐', rank: 2 } };
  const worst = (...s) => s.filter(Boolean).sort((a, b) => b.rank - a.rank)[0] || null;
  const ratio = (a, b) => (a != null && b > 0) ? a / b : null;
  const sigOfProgress = gap => gap == null ? null : gap >= RULE.progressWarn ? SIG.ok : gap >= RULE.progressBad ? SIG.warn : SIG.bad;
  const sigOfClose = r => r == null ? null : r >= RULE.closeOk ? SIG.ok : r >= RULE.closeWarn ? SIG.warn : SIG.bad;
  const sigOfSpeed = u => u == null ? null : u <= RULE.speedWarn ? SIG.ok : u <= RULE.speedBad ? SIG.warn : SIG.bad;

  // 'MM/DD' 라벨 → Date (기준일보다 뒤 달이면 전년도)
  function labelDate(lbl, ref) {
    const p = String(lbl).split('/'); const m = parseInt(p[0], 10), d = parseInt(p[1], 10);
    if (!(m >= 1) || !(d >= 1)) return null;
    const y = ref ? (m > ref.getMonth() + 2 ? ref.getFullYear() - 1 : ref.getFullYear()) : new Date().getFullYear();
    return new Date(y, m - 1, d);
  }
  function weekdays(a, b) { let c = 0; const d = new Date(a); while (d <= b) { const w = d.getDay(); if (w >= 1 && w <= 5) c++; d.setDate(d.getDate() + 1); } return c; }
  const lastDayOf = (y, m) => new Date(y, m, 0);

  // 최근 주당 실적(HL): DSR 기준일까지 최근 14일 구간 합 ÷ 구간 영업일 × 5 (주말 출고·반품 포함)
  function recentWeekly(op, groups, skuFilter, year) {
    if (!op || !op.daily_hl || !Array.isArray(op.daily_labels) || !op.daily_labels.length) return null;
    const L = op.daily_labels, n = L.length;
    const asOf = labelDate(L[n - 1], new Date(year || new Date().getFullYear(), 11, 31)); if (!asOf) return null;
    const from = new Date(asOf); from.setDate(asOf.getDate() - (RULE.recentCalDays - 1));
    const idx = []; L.forEach((l, i) => { const d = labelDate(l, asOf); if (d && d >= from && d <= asOf) idx.push(i); });
    const biz = weekdays(from, asOf);
    if (!idx.length || !biz) return null;
    let s = 0, any = false;
    groups.forEach(g => {
      const bySku = op.daily_hl[g]; if (!bySku) return;
      Object.keys(bySku).forEach(sku => {
        if (skuFilter && !skuFilter(sku)) return;
        const a = bySku[sku]; if (!Array.isArray(a)) return;
        idx.forEach(i => { s += +a[i] || 0; }); any = true;
      });
    });
    return any ? { v: s / biz * RULE.weekDays, days: biz } : null;
  }

  // ── 이번 달 보기 (진도·마감 전망·목표 대비) ──
  //  t = { fcst, rofo, ap, mtd, recent(주당 HL), remainWd, baseline(평소 이맘때 누적비율), csf(c/s 계수) }
  function monthView(t) {
    const { fcst, rofo, ap, mtd, recent, remainWd, baseline, csf } = t;
    const progress = ratio(mtd, fcst);
    const progressGap = (progress != null && baseline != null) ? progress - baseline : null;
    const expClose = mtd != null ? mtd + (recent != null ? recent / RULE.weekDays * remainWd : 0) : null;
    const vsFcst = ratio(expClose, fcst);
    const need = (fcst != null && mtd != null) ? Math.max(fcst - mtd, 0) : null;
    return {
      fcst, rofo, ap, mtd, csf, remainWd, recentWeekly: recent,
      progress, baseline, progressGap, sigProgress: sigOfProgress(progressGap),
      expClose, vsFcst, short: (expClose != null && fcst != null) ? expClose - fcst : null, sigClose: sigOfClose(vsFcst),
      fcstVsRofo: ratio(fcst, rofo), fcstVsAp: ratio(fcst, ap), expVsRofo: ratio(expClose, rofo), expVsAp: ratio(expClose, ap),
      need, needWeekly: (need != null && remainWd > 0) ? need / remainWd * RULE.weekDays : null,
    };
  }
  // ── 다음 달 보기 (월 전환 주) ──
  function startView(t) {
    const { fcst, rofo, ap, ly, totalWd, recent, csf } = t;
    const target = fcst != null ? fcst : rofo;
    const needWeekly = (target != null && totalWd > 0) ? target / totalWd * RULE.weekDays : null;
    const speedUp = (needWeekly != null && recent > 0) ? needWeekly / recent - 1 : null;
    return { fcst, rofo, ap, ly, target, basis: fcst != null ? 'FCST' : (rofo != null ? 'RoFo' : null), totalWd, csf,
      needWeekly, recentWeekly: recent, speedUp, sigSpeed: sigOfSpeed(speedUp),
      fcstVsRofo: ratio(fcst, rofo), fcstVsAp: ratio(fcst, ap), vsLy: (target != null && ly > 0) ? target / ly - 1 : null };
  }

  // 지점 SKU 맵: sku → {fcst, mtd, hf, d}(HL)
  function skuRows(D, skuKey) {
    const out = {};
    ((D.sku_detail || {})[skuKey] || []).forEach(b => (b.skus || []).forEach(s => {
      const d = s.data || {}, f = d.hl_factor != null ? d.hl_factor : RULE.csStd;
      out[s.sku] = { sku: s.sku, brand: b.brand, hf: f, fcst: (num(d.this_week_fcst) || 0) * f, mtd: (num(d.mtd) || 0) * f,
        d: num(d.differ_vs_last) != null ? d.differ_vs_last * f : 0,
        ty: Array.isArray(d.act_monthly) ? d.act_monthly : [], ly: Array.isArray(d.act_2025_monthly) ? d.act_2025_monthly : [] };   // 월 출고(박스)
    }));
    return out;
  }
  // 통합 양식 저장본의 m월 마지막 제출 FCST (HL, SKU별)
  function bookFcst(D, bookKey, y, m, hfOf) {
    const M = D.on_fcst_book && D.on_fcst_book.months && D.on_fcst_book.months[`${y}-${String(m).padStart(2, '0')}`];
    if (!M || !M.rows || !M.rows[bookKey]) return null;
    const sub = (M.submitted && M.submitted[bookKey]) || [];
    let col = 0; sub.forEach((v, k) => { if (v) col = k + 1; });
    if (!col) return null;
    const bySku = {}; let total = 0;
    Object.entries(M.rows[bookKey]).forEach(([sku, x]) => { const v = (+((x.w || [])[col - 1]) || 0) * hfOf(sku); bySku[sku] = v; total += v; });
    return { hl: total, col, bySku };
  }
  // 이번 달 주차별 제출 FCST 흐름 (지점 HL)
  function fcstTrend(D, bookKey, y, m, hfOf) {
    const M = D.on_fcst_book && D.on_fcst_book.months && D.on_fcst_book.months[`${y}-${String(m).padStart(2, '0')}`];
    if (!M || !M.rows || !M.rows[bookKey]) return null;
    const sub = (M.submitted && M.submitted[bookKey]) || [];
    const series = [];
    for (let k = 0; k < 5; k++) {
      if (!sub[k]) continue;
      let s = 0; Object.entries(M.rows[bookKey]).forEach(([sku, x]) => { s += (+((x.w || [])[k]) || 0) * hfOf(sku); });
      series.push({ w: k + 1, hl: s });
    }
    const n = series.length;
    return { series, down2: n >= 3 && series[n - 1].hl < series[n - 2].hl - RULE.downTol && series[n - 2].hl < series[n - 3].hl - RULE.downTol };
  }
  // ── 도매장 예상 수요 (월초 재고 판정용) ──
  //  월초 재고는 도매장 재고 → 우리 출고(FCST·MTD)는 지점이 그 재고를 보고 조절한 값이라 분모로 쓰면 순환.
  //  예상 수요 = 전년 같은 달 출고 × (1 + 올해 증감률[마감월 누계 vs 전년 같은 기간]) — 계절성 반영, 올해 재고 판단과 무관.
  //  신규 SKU(전년 같은 달 0 또는 전년 누계 < 올해의 10%): 최근 3개 마감월 평균 × 지점 계절지수(전년 이번 달 ÷ 전년 그 3개월 평균).
  function expDemand(row, m, ctx, brLy) {
    const closed = ctx.mon - 1;   // 마감월 수 (데이터 월 직전까지)
    const ly = +row.ly[m - 1] || 0;
    const tyYtd = sumArr(row.ty, 0, closed - 1), lyYtd = sumArr(row.ly, 0, closed - 1);
    if (ly > 0 && lyYtd > 0 && lyYtd >= tyYtd * RULE.newSkuLyMin) {
      const g = tyYtd / lyYtd - 1;
      return { qty: ly * (1 + g), src: 'ly', ly, growth: g };
    }
    const i0 = Math.max(closed - 3, 0), n = closed - i0;
    if (!n) return null;
    const tyAvg = sumArr(row.ty, i0, closed - 1) / n;
    const brBase = brLy ? sumArr(brLy, i0, closed - 1) / n : 0;
    const season = (brLy && brBase > 0 && +brLy[m - 1] > 0) ? +brLy[m - 1] / brBase : 1;
    return tyAvg > 0 ? { qty: tyAvg * season, src: 'new', tyAvg, season } : null;
  }
  // 월초 재고 (통합 양식 '월초 재고' 칸 = 도매장 재고, 단위 박스·keg) → 재고일수 = 재고 ÷ (예상 수요 ÷ 달력일)
  //  부족·과다 기준은 통합 양식 Total 시트(기본 7일 미만·14일 초과). Stock & Cover 탭(엑셀 지점 시트와 동일 계산)과는 분모가 다름.
  function stockOf(D, bookKey, y, m, hitRows, hfOf, ctx, brLy, fcstQty) {
    const M = D.on_fcst_book && D.on_fcst_book.months && D.on_fcst_book.months[`${y}-${String(m).padStart(2, '0')}`];
    if (!M || !M.rows || !M.rows[bookKey]) return null;
    let qty = 0, hl = 0, any = false, demand = 0, dmAny = false;
    const parts = [];
    hitRows.forEach(r => {
      const x = M.rows[bookKey][r.sku];
      if (x && x.stock != null) { qty += +x.stock || 0; hl += (+x.stock || 0) * hfOf(r.sku); any = true; }
      const e = r.ty ? expDemand(r, m, ctx, brLy) : null;
      if (e) { demand += e.qty; dmAny = true; parts.push(e); }
    });
    if (!any) return null;
    const T = new Date(y, m, 0).getDate();
    const TH = Object.assign({ short: 7, over: 14 }, (D.on_fcst_book && D.on_fcst_book.thresholds) || {});
    const days = (dmAny && demand > 0) ? qty / (demand / T) : null;
    let status = days == null ? (qty > 0 ? 'idle' : 'none') : days < TH.short ? 'short' : days > TH.over ? 'over' : 'ok';
    if (qty <= 0 && demand > 0) status = 'short';
    const one = parts.length === 1 ? parts[0] : null;
    return { qty, hl, days, demand: dmAny ? demand : null, status, th: TH,
      basis: one ? one : { src: parts.some(p => p.src === 'new') ? 'new' : 'ly' },
      fcstVsDemand: (fcstQty != null && demand > 0) ? fcstQty / demand : null };
  }
  // 지점의 m월 AP (현재 월이면 지점 합계 값, 아니면 월별 AP 표)
  function apOf(D, hlKey, m, ctx) {
    if (m === ctx.mon) { const v = num((((D.wk10_summary || {}).hl || {})[hlKey] || {}).ap); if (v != null) return v; }
    return num(((D.monthly_regional_ap || {})[hlKey] || [])[m - 1]);
  }

  // ── 질문 ──
  const fq = v => (+v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  const fcs = (hl, csf) => Math.round(Math.abs(hl) / (csf || RULE.csStd)).toLocaleString('ko-KR');
  function questions(br, A, B, C, isDec) {
    const q = [], push = (pri, text) => q.push({ pri, text });
    if (A.sigProgress && A.sigProgress.k === 'bad')
      push(isDec ? 0 : 2, `${br} 평소보다 진도 ${Math.round(Math.abs(A.progressGap * 100))}%p 늦음 — ${isDec ? '연말 ' : '월말에 몰릴 수 있음, '}노멀 마감 가능한가?`);
    if (A.sigClose && A.sigClose.k === 'bad' && A.remainWd > 0)
      push(1, `${br} 지금 속도면 FCST보다 ${fq(-A.short)} HL(${fcs(A.short, A.csf)} c/s) 부족(전망 ${Math.round(A.vsFcst * 100)}%) — 남은 ${A.remainWd}일 어디서 메우나?`);
    const sk = (B || []).filter(x => x.sigClose && x.sigClose.k === 'bad' && x.short < 0 && (A.short == null || A.short >= 0 || x.short / A.short >= RULE.skuQuestionMinShare))
      .sort((a, b) => a.short - b.short)[0];
    if (sk) push(3, `${sk.label} 지금 속도면 FCST의 ${Math.round(sk.vsFcst * 100)}% (${fcs(sk.short, sk.csf)} ${sk.unit === 'keg' ? 'keg' : 'c/s'} 부족) — 원인과 대응은?`);
    const st = (B || []).filter(x => x.stock && x.stock.status === 'short').sort((a, b) => (a.stock.days ?? -1) - (b.stock.days ?? -1))[0];
    if (st) push(3.5, `${st.label} 월초 재고 ${st.stock.days != null ? Math.round(st.stock.days) + '일분' : '없음'}(부족 기준 ${st.stock.th.short}일 미만) — 보충·출고 계획은?`);
    const lo = (B || []).filter(x => x.stock && x.stock.status === 'over' && x.stock.fcstVsDemand != null && x.stock.fcstVsDemand < RULE.fcstLowVsDemand)
      .sort((a, b) => a.stock.fcstVsDemand - b.stock.fcstVsDemand)[0];
    if (lo) push(4.5, `${lo.label} 도매장 재고 ${Math.round(lo.stock.days)}일분(과다) — FCST가 예상 수요의 ${Math.round(lo.stock.fcstVsDemand * 100)}%. 재고 소진 계획은?`);
    const hiS = (B || []).filter(x => x.stock && x.stock.status === 'over' && x.stock.fcstVsDemand != null && x.stock.fcstVsDemand > RULE.fcstHighVsDemand)
      .sort((a, b) => b.stock.fcstVsDemand - a.stock.fcstVsDemand)[0];
    if (hiS) push(3.6, `${hiS.label} 도매장 재고 ${Math.round(hiS.stock.days)}일분(과다)인데 FCST가 예상 수요의 ${Math.round(hiS.stock.fcstVsDemand * 100)}% — 도매장 재고가 더 쌓이지 않나?`);
    if (C.trend && C.trend.down2) { const s = C.trend.series, n = s.length; push(4, `${br} FCST 2주 연속 하향(${fq(s[n - 3].hl)}→${fq(s[n - 1].hl)} HL) — 일시적인가, 구조적인가?`); }
    if (A.fcstVsRofo != null && A.fcstVsRofo < 1 + RULE.gapWarn) push(5, `${br} FCST가 RoFo의 ${Math.round(A.fcstVsRofo * 100)}% — RoFo 갭 계획은?`);
    return q.sort((a, b) => a.pri - b.pri).slice(0, RULE.maxQuestions).map(x => x.text);
  }
  function transitionQuestions(br, cl, st, pm, nm) {
    const q = [], push = (pri, text) => q.push({ pri, text });
    if (st.speedUp != null && (nm === 12 ? st.speedUp > RULE.speedWarn : st.speedUp > RULE.speedBad))
      push(nm === 12 ? 0 : 2, `${br} ${nm}월 ${st.basis} 달성에 주당 ${fq(st.needWeekly)} HL(${fcs(st.needWeekly, st.csf)} c/s) 필요 — 최근보다 ${Math.round(st.speedUp * 100)}% 더. ${nm === 12 ? '연말 노멀 마감 계획은?' : '첫 주부터 어떻게 확보하나?'}`);
    if (st.fcst == null) push(1, `${br} ${nm}월 FCST 미제출 — 제출 일정은? (지금은 RoFo 기준)`);
    else if (st.fcstVsRofo != null && st.fcstVsRofo < 1 + RULE.gapWarn) push(3, `${br} ${nm}월 FCST가 RoFo의 ${Math.round(st.fcstVsRofo * 100)}% — 갭 메울 계획은?`);
    if (cl.sigClose && cl.sigClose.k === 'bad' && cl.remainWd > 0)
      push(1, `${br} ${pm}월 지금 속도면 FCST보다 ${fq(-cl.short)} HL(${fcs(cl.short, cl.csf)} c/s) 부족 — 남은 ${cl.remainWd}일 마감 가능한가?`);
    return q.sort((a, b) => a.pri - b.pri).slice(0, RULE.maxQuestions).map(x => x.text);
  }

  // ── 지점 1개 (이번 달) ──
  function computeBranch(D, b, ctx) {
    const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
    const op = D.order_pattern;
    const rofoArr = Array.isArray(hl.rofo_monthly) ? hl.rofo_monthly : null;
    const rw = recentWeekly(op, b.groups, null, ctx.year);
    const A = monthView({ fcst: num(hl.this_week_fcst), rofo: rofoArr ? num(rofoArr[ctx.ci]) : null, ap: apOf(D, b.hl, ctx.mon, ctx),
      mtd: num(hl.mtd_actual), recent: rw ? rw.v : null, remainWd: ctx.remainWd, baseline: ctx.baseline, csf: RULE.csStd });
    // 연간 착지 = 마감월 실적 + max(당월 FCST, MTD) + 이후 월 RoFo
    const fwd = rofoArr ? sumArr(rofoArr, ctx.ci + 1, 11) : null;
    A.landing = fwd != null && (A.fcst != null || A.mtd != null) ? sumArr((D.dsr_by_region_monthly || {})[b.hl], 0, ctx.ci - 1) + Math.max(A.fcst || 0, A.mtd || 0) + fwd : null;

    const rows = skuRows(D, b.sku);
    const B = (CORE[b.key] || []).map(id => {
      const def = SKU[id];
      const hit = Object.values(rows).filter(r => def.match(r.sku));
      if (!hit.length) return null;
      const r = recentWeekly(op, b.groups, def.match, ctx.year);
      const x = monthView({ fcst: hit.reduce((s, h) => s + h.fcst, 0), mtd: hit.reduce((s, h) => s + h.mtd, 0), recent: r ? r.v : null,
        remainWd: ctx.remainWd, baseline: ctx.baseline, csf: hit[0].hf });
      const stock = b.book ? stockOf(D, b.book, ctx.year, ctx.mon, hit, sku => (rows[sku] && rows[sku].hf) || ctx.hfOf(sku), ctx,
        (D.monthly_regional_2025 || {})[b.hl], hit.reduce((s, h) => s + h.fcst / h.hf, 0)) : null;
      return Object.assign(x, { id, label: def.label, unit: def.unit || 'cs', skus: hit.map(h => h.sku), stock });
    }).filter(Boolean);

    const C = {
      thisWeek: A.fcst, lastWeek: num(hl.last_week_fcst), change: num(hl.differ_vs_last),
      changePct: ratio(num(hl.differ_vs_last), num(hl.last_week_fcst)),
      topSku: Object.values(rows).filter(r => Math.abs(r.d) >= 0.05).sort((a, c) => Math.abs(c.d) - Math.abs(a.d)).slice(0, 3)
        .map(r => ({ sku: r.sku, d: r.d, csf: r.hf })),
      trend: b.book ? fcstTrend(D, b.book, ctx.year, ctx.mon, sku => (rows[sku] && rows[sku].hf) || ctx.hfOf(sku)) : null,
    };
    const E = questions(b.label, A, B, C, ctx.mon === 12);
    return { key: b.key, label: b.label, cat: b.cat, A, B, C, E, signal: worst(A.sigProgress, A.sigClose) };
  }

  // ── ALSM (Off 스냅샷 모델, 권역 FCST 없음 → 합계) ──
  function computeAlsm(Am, ctx) {
    if (!Am || Am.error) return null;
    const ci = ctx.ci;
    const arr = Am.wf && Am.wf[ci];
    let wk = null;
    if (Array.isArray(arr)) for (let w = 4; w >= 0; w--) if ((+arr[w] || 0) > 0) { wk = { tw: +arr[w], lw: w > 0 ? (+arr[w - 1] || 0) : null }; break; }
    const fcst = Am.fcst[ci] > 0 ? Am.fcst[ci] : (wk ? wk.tw : null);
    // 최근 주당: 주간 발주(1~7일 단위) 중 끝난 주 최근 2개 평균 → 없으면 MTD 런레이트
    let recent = null;
    const wa = Am.wacct && Am.wacct[ci];
    if (Array.isArray(wa)) {
      const vals = wa.slice(0, Math.floor((ctx.asOfDay || 0) / 7)).filter(v => v > 0).slice(-2);
      if (vals.length) recent = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    const mtd = num(Am.act[ci]);
    if (recent == null && mtd != null && ctx.wd.elapsed > 0) recent = mtd / ctx.wd.elapsed * RULE.weekDays;
    const A = monthView({ fcst, rofo: num(Am.rofo[ci]), ap: Am.ap && Am.ap[ci] > 0 ? Am.ap[ci] : null, mtd, recent,
      remainWd: ctx.remainWd, baseline: ctx.baseline, csf: RULE.csStd });
    A.landing = (fcst != null || mtd != null) ? sumArr(Am.act, 0, ci - 1) + Math.max(fcst || 0, mtd || 0) + sumArr(Am.rofo, ci + 1, 11) : null;
    const B = CORE.alsm.map(id => {
      const def = SKU[id];
      const hit = (Am.skus || []).filter(s => def.match(s.sku));
      if (!hit.length) return null;
      const f = hit.reduce((s, r) => s + (+r.fcst[ci] || 0), 0), m = hit.reduce((s, r) => s + (+r.act[ci] || 0), 0);
      const x = monthView({ fcst: f, mtd: m, recent: ctx.wd.elapsed > 0 ? m / ctx.wd.elapsed * RULE.weekDays : null,
        remainWd: ctx.remainWd, baseline: ctx.baseline, csf: ctx.hfOf(hit[0].sku) });
      return Object.assign(x, { id, label: def.label, unit: 'cs', skus: hit.map(h => h.sku) });
    }).filter(Boolean);
    const series = Array.isArray(arr) ? arr.map((v, k) => ({ w: k + 1, hl: +v || 0 })).filter(x => x.hl > 0) : [];
    const n = series.length;
    const C = { thisWeek: wk ? wk.tw : fcst, lastWeek: wk ? wk.lw : null, change: (wk && wk.lw != null) ? wk.tw - wk.lw : null,
      changePct: wk ? ratio(wk.tw - (wk.lw || 0), wk.lw) : null, topSku: [],
      trend: n ? { series, down2: n >= 3 && series[n - 1].hl < series[n - 2].hl - RULE.downTol && series[n - 2].hl < series[n - 3].hl - RULE.downTol } : null };
    const regions = (Am.regions || []).map(r => ({ key: r.key, mtd: num(r.act[ci]), ytd: sumArr(r.act, 0, ci - 1), ytdLy: sumArr(r.ly, 0, ci - 1) }));
    return { key: 'alsm', label: 'ALSM', cat: 'alsm', A, B, C, E: questions('ALSM', A, B, C, ctx.mon === 12), regions,
      signal: worst(A.sigProgress, A.sigClose), basis: '합계(권역 FCST 없음)' };
  }

  // ── 월 전환 주: ① 전월 마감 ② 다음 달 시작 ──
  function monthFcst(D, b, ctx, y, m) {
    if (ctx.mon === m && y === ctx.year) {
      const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
      if (num(hl.this_week_fcst) == null) return null;
      const bySku = {}; Object.values(skuRows(D, b.sku)).forEach(r => { bySku[r.sku] = r.fcst; });
      return { hl: hl.this_week_fcst, bySku, src: '이번 주 제출' };
    }
    const bf = b.book ? bookFcst(D, b.book, y, m, sku => ctx.hfOf(sku)) : null;
    return bf ? { hl: bf.hl, bySku: bf.bySku, src: `W${bf.col} 제출` } : null;
  }
  function computeTransition(D, ctx, span, alsmModel, alsmRes) {
    const op = D.order_pattern;
    const pm = span.prev.month, nm = span.next.month, py = span.prev.year, ny = span.next.year;
    const L = (op && op.daily_labels) || [];
    const asOfDate = L.length ? labelDate(L[L.length - 1], new Date(ctx.year, 11, 31)) : null;
    let remainWd = 0;
    if (asOfDate && asOfDate < lastDayOf(py, pm)) { const from = new Date(asOfDate); from.setDate(from.getDate() + 1); remainWd = weekdays(from, lastDayOf(py, pm)); }
    const nmWd = weekdays(new Date(ny, nm - 1, 1), lastDayOf(ny, nm));
    const inFY = y => y === ctx.year;   // RoFo·실적·AP 배열은 데이터 연도 12개월
    const ly25 = D.monthly_regional_2025 || {};
    const one = b => {
      const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
      const rofo = Array.isArray(hl.rofo_monthly) ? hl.rofo_monthly : null;
      const rw = recentWeekly(op, b.groups, null, ctx.year), recent = rw ? rw.v : null;
      const pf = monthFcst(D, b, ctx, py, pm), nf = monthFcst(D, b, ctx, ny, nm);
      const close = monthView({ fcst: pf ? pf.hl : null, rofo: rofo && inFY(py) ? num(rofo[pm - 1]) : null, ap: inFY(py) ? apOf(D, b.hl, pm, ctx) : null,
        mtd: inFY(py) ? num(((D.dsr_by_region_monthly || {})[b.hl] || [])[pm - 1]) : null, recent, remainWd, baseline: null, csf: RULE.csStd });
      close.fcstSrc = pf ? pf.src : null;
      const start = startView({ fcst: nf ? nf.hl : null, rofo: rofo && inFY(ny) ? num(rofo[nm - 1]) : null, ap: inFY(ny) ? apOf(D, b.hl, nm, ctx) : null,
        ly: inFY(ny) ? num((ly25[b.hl] || [])[nm - 1]) : null, totalWd: nmWd, recent, csf: RULE.csStd });
      start.fcstSrc = nf ? nf.src : null;
      const B = nf ? (CORE[b.key] || []).map(id => {
        const def = SKU[id];
        const skus = Object.keys(nf.bySku).filter(s => def.match(s));
        if (!skus.length) return null;
        const r = recentWeekly(op, b.groups, def.match, ctx.year);
        const x = startView({ fcst: skus.reduce((s, k) => s + (nf.bySku[k] || 0), 0), totalWd: nmWd, recent: r ? r.v : null, csf: ctx.hfOf(skus[0]) });
        const rowsAll = skuRows(D, b.sku);
        const hitRows = skus.map(k => rowsAll[k] || { sku: k, ty: null, ly: null });
        const stock = b.book && inFY(ny) ? stockOf(D, b.book, ny, nm, hitRows, sku => ctx.hfOf(sku), ctx, (D.monthly_regional_2025 || {})[b.hl],
          skus.reduce((s, k) => s + (nf.bySku[k] || 0) / ctx.hfOf(k), 0)) : null;
        return Object.assign(x, { id, label: def.label, unit: def.unit || 'cs', skus, share: ratio(x.fcst, start.target), stock });
      }).filter(Boolean) : [];
      return { key: b.key, label: b.label, cat: b.cat, close, start, B, E: transitionQuestions(b.label, close, start, pm, nm),
        signal: worst(close.sigClose, start.sigSpeed) };
    };
    const branches = BRANCHES.map(one);
    const ttl = one({ key: 'ttl', label: 'On TTL', hl: 'TTL', sku: 'On Trade Total', book: null, groups: (op && op.groups) || [], cat: 'on_trade' });
    // TTL FCST가 데이터 월이 아니면 저장본에 TTL이 없음 → 지점 합 (다음 달은 전 지점 제출 시에만)
    if (ttl.close.fcst == null) { const s = branches.reduce((a, x) => a + (x.close.fcst || 0), 0); if (s > 0) Object.assign(ttl.close, monthView(Object.assign({}, ttl.close, { fcst: s, recent: ttl.close.recentWeekly, baseline: null })), { fcstSrc: '지점 합' }); }
    if (ttl.start.fcst == null && branches.every(x => x.start.fcst != null)) Object.assign(ttl.start, startView(Object.assign({}, ttl.start, { fcst: branches.reduce((a, x) => a + x.start.fcst, 0), recent: ttl.start.recentWeekly })), { fcstSrc: '지점 합' });
    ttl.B = []; ttl.E = [];
    let alsm = null;
    if (alsmModel && !alsmModel.error && alsmRes) {
      const lastWf = m => { const a = alsmModel.wf && alsmModel.wf[m - 1]; if (!Array.isArray(a)) return null; for (let w = 4; w >= 0; w--) if (+a[w] > 0) return +a[w]; return null; };
      const recent = alsmRes.A.recentWeekly;
      const close = monthView({ fcst: inFY(py) ? (alsmModel.fcst[pm - 1] > 0 ? alsmModel.fcst[pm - 1] : lastWf(pm)) : null, rofo: inFY(py) ? num(alsmModel.rofo[pm - 1]) : null,
        ap: inFY(py) && alsmModel.ap && alsmModel.ap[pm - 1] > 0 ? alsmModel.ap[pm - 1] : null, mtd: inFY(py) ? num(alsmModel.act[pm - 1]) : null, recent, remainWd, baseline: null, csf: RULE.csStd });
      const start = startView({ fcst: inFY(ny) ? (alsmModel.fcst[nm - 1] > 0 ? alsmModel.fcst[nm - 1] : lastWf(nm)) : null, rofo: inFY(ny) ? num(alsmModel.rofo[nm - 1]) : null,
        ap: inFY(ny) && alsmModel.ap && alsmModel.ap[nm - 1] > 0 ? alsmModel.ap[nm - 1] : null, ly: inFY(ny) ? num(alsmModel.ly[nm - 1]) : null, totalWd: nmWd, recent, csf: RULE.csStd });
      alsm = { key: 'alsm', label: 'ALSM', cat: 'alsm', close, start, B: [], E: transitionQuestions('ALSM', close, start, pm, nm), signal: worst(close.sigClose, start.sigSpeed) };
    }
    return { prev: { year: py, month: pm, remainWd }, next: { year: ny, month: nm, totalWd: nmWd }, ttl, branches, alsm };
  }

  // ── 전체 ──
  //  opts: { alsm: window._ALSM, hfOf: sku → HL 계수, meeting: { label, span:{prev,next} } }
  function compute(D, opts) {
    opts = opts || {};
    const wd = D.wd_progress || {};
    const mon = (D.wk_meta && D.wk_meta.month) || (new Date().getMonth() + 1);
    const year = (D.on_fcst_book && D.on_fcst_book.year) || new Date().getFullYear();
    const op = D.order_pattern;
    // 평소 이맘때 진도 = 발주패턴(완료월 연평균) 누적비율, 없으면 영업일 경과율
    let baseline = wd.pct || null, baseSrc = '영업일 경과율';
    if (typeof global._wrPatternClose === 'function') {
      try { const p = global._wrPatternClose(op, mon, wd.total || 0, wd.elapsed || 0); if (p) { baseline = p.cumFrac; baseSrc = '발주패턴 ' + p.refLabel; } } catch (e) { /* 경과율 유지 */ }
    }
    const asOf = op && Array.isArray(op.daily_labels) ? op.daily_labels[op.daily_labels.length - 1] : null;
    const asOfDay = asOf ? parseInt(String(asOf).split('/')[1], 10) || 0 : 0;
    const asOfMon = asOf ? parseInt(String(asOf).split('/')[0], 10) || 0 : 0;
    const elapsedCal = asOfMon === mon ? asOfDay : (asOfMon > mon ? new Date(year, mon, 0).getDate() : 0);
    const ctx = { wd, mon, ci: mon - 1, year, baseline, asOfDay, elapsedCal, remainWd: Math.max((wd.total || 0) - (wd.elapsed || 0), 0), hfOf: opts.hfOf || (() => RULE.csStd) };

    const branches = BRANCHES.map(b => computeBranch(D, b, ctx));
    const ttl = computeBranch(D, { key: 'ttl', label: 'On TTL', hl: 'TTL', sku: 'On Trade Total', book: null, groups: (op && op.groups) || [], cat: 'on_trade' }, ctx);
    ttl.B = []; ttl.E = [];
    const alsm = computeAlsm(opts.alsm, ctx);
    const span = opts.meeting && opts.meeting.span;
    return {
      generatedAt: new Date().toISOString(),
      week: D.wk_meta ? { num: D.wk_meta.num, label: D.wk_meta.label, month: mon } : { month: mon },
      wd: { elapsed: wd.elapsed, total: wd.total, pct: wd.pct },
      dsrAsOf: asOf, baseline: { v: baseline, src: baseSrc },
      ttl, branches, alsm,
      transition: span ? computeTransition(D, ctx, span, opts.alsm, alsm) : null,
      meeting: opts.meeting ? { label: opts.meeting.label } : null,
      rules: RULE,
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  회의록 자동 카드 렌더 (밝은 배경, 인라인 스타일만 — DOMPurify 통과)
  // ════════════════════════════════════════════════════════════════
  const C_SIG = { ok: ['#15803d', '#dcfce7'], warn: ['#a16207', '#fef9c3'], bad: ['#b91c1c', '#fee2e2'] };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const f1 = v => (v == null || !isFinite(v)) ? '—' : (+v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  const f0 = v => (v == null || !isFinite(v)) ? '—' : Math.round(+v).toLocaleString('ko-KR');
  const pct = v => (v == null || !isFinite(v)) ? '—' : Math.round(v * 100) + '%';
  const pp = v => (v == null || !isFinite(v)) ? '—' : Math.round(v * 100) === 0 ? '±0%p' : (v > 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%p';
  const sgn = v => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + f1(Math.abs(v));
  const SMALL = t => `<div style="font-size:10.5px;color:#9ca3af;font-weight:400;">${t}</div>`;
  // HL + c/s 두 줄 (c/s 계수 csf, unit 'keg'면 keg 표기)
  const hc = (hl, csf, unit, signed) => hl == null || !isFinite(hl) ? '—'
    : (signed ? sgn(hl) : f1(hl)) + SMALL((signed && hl > 0 ? '+' : signed && hl < 0 ? '−' : '') + f0(Math.abs(hl) / (csf || RULE.csStd)) + (unit === 'keg' ? ' keg' : ' c/s'));
  function pill(sig, text) {
    if (!sig) return '<span style="color:#9ca3af;">—</span>';
    const c = C_SIG[sig.k];
    return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;color:${c[0]};background:${c[1]};">${esc(text || sig.lbl)}</span>`;
  }
  const achSig = r => r == null ? null : r >= 1 ? SIG.ok : r >= RULE.closeWarn ? SIG.warn : SIG.bad;   // 목표 달성률 색
  const TH = 'style="padding:5px 8px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;vertical-align:bottom;"';
  const THL = 'style="padding:5px 8px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;vertical-align:bottom;"';
  const TD = 'style="padding:5px 8px;text-align:right;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap;vertical-align:top;"';
  const TDL = 'style="padding:5px 8px;text-align:left;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap;vertical-align:top;"';
  const TABLE = (head, rows) => `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;margin:4px 0 10px;"><tr>${head}</tr>${rows}</table></div>`;
  const H = t => `<div style="font-size:12px;font-weight:700;color:#205527;margin:12px 0 4px;">${t}</div>`;
  const NOTE = t => `<div style="font-size:11px;color:#9ca3af;margin-top:2px;">${t}</div>`;
  const trendText = tr => tr && tr.series && tr.series.length ? tr.series.map(s => f0(s.hl)).join(' → ') : null;

  // 상단 신호 줄: 진도 · 마감 전망 · FCST 추이
  function headLine(A, C) {
    const parts = [];
    if (A.progress != null) parts.push(`<span>진도 ${pill(A.sigProgress, pp(A.progressGap))} <span style="color:#6b7280;">평소 이맘때 ${pct(A.baseline)} · 지금 ${pct(A.progress)}</span></span>`);
    if (A.expClose != null && A.fcst != null) parts.push(`<span>마감 전망 ${pill(A.sigClose, pct(A.vsFcst))} <span style="color:#6b7280;">지금 속도면 ${f0(A.expClose)} HL · FCST ${A.short >= 0 ? '초과' : '부족'} ${f1(Math.abs(A.short))} HL (${f0(Math.abs(A.short) / A.csf)} c/s)</span></span>`);
    if (C && C.trend && C.trend.down2) parts.push(`<span>${pill(SIG.bad, 'FCST 2주 연속 하향')} <span style="color:#6b7280;">${trendText(C.trend)}</span></span>`);
    return `<div style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;margin-bottom:4px;">${parts.join('')}</div>`;
  }
  // 목표 대비 표: FCST·RoFo·AP × (목표, FCST 달성률, 마감 전망 달성률, 전망 − 목표)
  function targetTable(A, title) {
    const row = (name, goal, fAch, eAch) => `<tr><td ${TDL}><b>${name}</b></td><td ${TD}>${hc(goal, A.csf)}</td>`
      + `<td ${TD}>${fAch === 'self' ? '<span style="color:#9ca3af;">기준</span>' : pill(achSig(fAch), pct(fAch))}</td><td ${TD}>${pill(achSig(eAch), pct(eAch))}</td>`
      + `<td ${TD}>${goal != null && A.expClose != null ? hc(A.expClose - goal, A.csf, null, true) : '—'}</td></tr>`;
    return H(title || 'A. 목표 대비 (HL · c/s)') + TABLE(
      `<th ${THL}>기준</th><th ${TH}>목표</th><th ${TH}>FCST 달성률</th><th ${TH}>마감 전망 달성률</th><th ${TH}>전망 − 목표</th>`,
      row('FCST', A.fcst, 'self', A.vsFcst) + row('RoFo', A.rofo, A.fcstVsRofo, A.expVsRofo) + row('AP', A.ap, A.fcstVsAp, A.expVsAp))
      + NOTE(`FCST 달성률 = 이번 주 제출 FCST ÷ 목표 · 마감 전망 = MTD ${f1(A.mtd)} HL + 최근 2주 일평균 × 남은 ${A.remainWd}영업일 · c/s = 환산(330ml×24)`);
  }
  function paceTable(A) {
    return H('진도 · 남은 필요량') + TABLE(
      `<th ${TH}>MTD</th><th ${TH}>평소 이맘때</th><th ${TH}>지금 진도</th><th ${TH}>남은 영업일</th><th ${TH}>남은 필요</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>연간 착지</th>`,
      `<tr><td ${TD}>${hc(A.mtd, A.csf)}</td><td ${TD}>${pct(A.baseline)}</td><td ${TD}>${pill(A.sigProgress, pct(A.progress))}</td><td ${TD}>${A.remainWd}일</td>`
      + `<td ${TD}>${hc(A.need, A.csf)}</td><td ${TD}><b>${hc(A.needWeekly, A.csf)}</b></td><td ${TD}>${hc(A.recentWeekly, A.csf)}</td><td ${TD}>${f0(A.landing)}</td></tr>`)
      + NOTE('평소 이맘때 = 완료된 달들의 발주패턴 평균으로 본 이 시점 누적 비중 · 최근 주당 = 최근 2주(10영업일) 실적 · 연간 착지 = 마감월 실적 + 당월 + 이후 월 RoFo');
  }
  function skuTable(B, isAlsm) {
    if (!B || !B.length) return '';
    const rows = B.map(x => `<tr><td ${TDL}>${esc(x.label)}${x.unit === 'keg' ? SMALL('단위 keg') : ''}</td><td ${TD}>${hc(x.fcst, x.csf, x.unit)}</td><td ${TD}>${hc(x.mtd, x.csf, x.unit)}</td>`
      + `<td ${TD}>${hc(x.expClose, x.csf, x.unit)}</td><td ${TD}>${pill(x.sigClose, pct(x.vsFcst))}</td><td ${TD}>${hc(x.short, x.csf, x.unit, true)}</td>`
      + `<td ${TD}>${hc(x.needWeekly, x.csf, x.unit)}</td><td ${TD}>${hc(x.recentWeekly, x.csf, x.unit)}</td></tr>`).join('');
    return H('B. 핵심 SKU (HL · c/s)') + TABLE(
      `<th ${THL}>SKU</th><th ${TH}>월 FCST</th><th ${TH}>MTD</th><th ${TH}>마감 전망</th><th ${TH}>FCST 대비</th><th ${TH}>부족·초과</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th>`, rows)
      + NOTE(isAlsm ? 'ALSM SKU 최근 주당 = MTD 런레이트 (SKU별 일자 실적 없음) · c/s = SKU 실제 박스' : 'c/s = SKU 실제 박스(20L은 keg)');
  }
  const ST = { short: ['부족', SIG.bad], over: ['과다', SIG.warn], ok: ['적정', SIG.ok], idle: ['판매 없음', null], none: ['—', null] };
  function stockTable(B, title) {
    const rows = (B || []).filter(x => x.stock);
    if (!rows.length) return '';
    const th = rows[0].stock.th;
    const basisTxt = k => k.basis.src === 'ly' && k.basis.ly != null
      ? `전년 ${f0(k.basis.ly)} × ${(k.basis.growth >= 0 ? '+' : '−') + Math.abs(Math.round(k.basis.growth * 100))}%`
      : k.basis.src === 'new' && k.basis.tyAvg != null ? `신규: 최근 3개월 ${f0(k.basis.tyAvg)} × 계절 ${k.basis.season.toFixed(2)}` : (k.basis.src === 'new' ? '신규 SKU 포함' : '전년 × 증감률');
    return H(title || '도매장 월초 재고 (주요 SKU)') + TABLE(
      `<th ${THL}>SKU</th><th ${TH}>월초 재고</th><th ${TH}>예상 수요<br>(월)</th><th ${TH}>재고일수</th><th ${TH}>상태</th><th ${TH}>FCST ÷<br>예상 수요</th>`,
      rows.map(x => { const k = x.stock, u = x.unit === 'keg' ? ' keg' : ' c/s', st = ST[k.status] || ST.none;
        return `<tr><td ${TDL}>${esc(x.label)}</td><td ${TD}>${f0(k.qty)}${u}${SMALL(f1(k.hl) + ' HL')}</td>`
          + `<td ${TD}>${k.demand != null ? f0(k.demand) + u : '—'}${SMALL(basisTxt(k))}</td>`
          + `<td ${TD}>${k.days != null ? f1(k.days) + '일' : '—'}</td><td ${TD}>${st[1] ? pill(st[1], st[0]) : '<span style="color:#9ca3af;">' + st[0] + '</span>'}</td>`
          + `<td ${TD}>${k.fcstVsDemand != null ? ((k.fcstVsDemand < RULE.fcstLowVsDemand || (k.status === 'over' && k.fcstVsDemand > RULE.fcstHighVsDemand)) ? pill(SIG.warn, pct(k.fcstVsDemand)) : pct(k.fcstVsDemand)) : '—'}</td></tr>`; }).join(''))
      + NOTE(`도매장 재고 기준 · 예상 수요 = 전년 같은 달 출고 × (1 + 올해 증감률: 마감월 누계 vs 전년 같은 기간), 신규 SKU는 최근 3개월 평균 × 지점 계절지수 · 재고일수 = 월초 재고 ÷ (예상 수요 ÷ 달력일) · 부족 < ${th.short}일 · 과다 > ${th.over}일 · FCST ÷ 예상 수요: 낮으면 재고를 감안해 FCST를 줄인 것, 재고 과다인데 높으면 도매장 재고가 더 쌓일 위험 · Stock & Cover 탭은 엑셀과 같은 '이번 달 출고 기준'이라 값이 다름`);
  }
  function blockC(C, csf, title) {
    const items = [];
    if (C.change != null) items.push(`지난주 대비 <b style="color:${C.change >= 0 ? '#15803d' : '#b91c1c'};">${sgn(C.change)} HL (${C.change >= 0 ? '+' : '−'}${f0(Math.abs(C.change) / csf)} c/s)</b>${C.changePct != null ? ' · ' + (C.changePct >= 0 ? '+' : '') + (C.changePct * 100).toFixed(1) + '%' : ''} · ${f1(C.lastWeek)} → ${f1(C.thisWeek)} HL`);
    else items.push('지난주 대비 비교 없음 (이번 달 첫 제출)');
    if (C.topSku && C.topSku.length) items.push('많이 바뀐 SKU: ' + C.topSku.map(t => `${esc(t.sku)} <b style="color:${t.d >= 0 ? '#15803d' : '#b91c1c'};">${t.d >= 0 ? '+' : '−'}${f0(Math.abs(t.d) / t.csf)} c/s</b>`).join(' · '));
    if (C.trend && C.trend.series && C.trend.series.length) items.push('주차별 제출 FCST: ' + C.trend.series.map(s => `W${s.w} ${f0(s.hl)}`).join(' → ') + ' HL' + (C.trend.down2 ? ' — <b style="color:#b91c1c;">2주 연속 하향</b>' : ''));
    return H(title || 'C. FCST 변화') + '<ul style="margin:2px 0 8px 18px;padding:0;font-size:12px;line-height:1.75;">' + items.map(t => `<li>${t}</li>`).join('') + '</ul>';
  }
  function blockE(E) {
    if (!E || !E.length) return H('E. 미팅 질문') + '<div style="font-size:12px;color:#15803d;">규칙에 걸린 항목 없음</div>';
    return H('E. 미팅 질문') + '<ol style="margin:2px 0 6px 18px;padding:0;font-size:12.5px;line-height:1.8;">' + E.map(q => `<li>${esc(q)}</li>`).join('') + '</ol>';
  }
  function footer(R) {
    return `<div style="margin-top:10px;padding-top:6px;border-top:1px dashed #e5e7eb;font-size:10.5px;color:#9ca3af;">자동 생성 ${new Date(R.generatedAt).toLocaleString('ko-KR')} · DSR ~${esc(R.dsrAsOf || '-')} · 영업일 ${R.wd.elapsed}/${R.wd.total} · 평소 진도 기준 ${esc(R.baseline.src)}</div>`;
  }
  function regionTable(regions) {
    if (!regions || !regions.length) return '';
    return H('권역 실적 (FCST는 ALSM 합계로만)') + TABLE(`<th ${THL}>권역</th><th ${TH}>MTD</th><th ${TH}>YTD(마감월)</th><th ${TH}>전년 대비</th>`,
      regions.map(r => `<tr><td ${TDL}>${esc(r.key)}</td><td ${TD}>${hc(r.mtd, RULE.csStd)}</td><td ${TD}>${f0(r.ytd)}</td><td ${TD}>${r.ytdLy > 0 ? ((r.ytd / r.ytdLy - 1) >= 0 ? '+' : '') + ((r.ytd / r.ytdLy - 1) * 100).toFixed(1) + '%' : '—'}</td></tr>`).join(''));
  }
  function branchHtml(R, b) {
    return headLine(b.A, b.C) + targetTable(b.A) + paceTable(b.A) + skuTable(b.B, b.key === 'alsm') + stockTable(b.B) + regionTable(b.regions) + blockC(b.C, RULE.csStd) + blockE(b.E) + footer(R);
  }
  function ttlHtml(R) {
    const t = R.ttl, all = [...R.branches, R.alsm].filter(Boolean);
    const rows = all.map(b => `<tr><td ${TDL}><b>${esc(b.label)}</b></td><td ${TD}>${hc(b.A.fcst, RULE.csStd)}</td>`
      + `<td ${TD}>${pill(achSig(b.A.fcstVsRofo), pct(b.A.fcstVsRofo))}</td><td ${TD}>${pill(achSig(b.A.fcstVsAp), pct(b.A.fcstVsAp))}</td>`
      + `<td ${TD}>${pill(b.A.sigProgress, pp(b.A.progressGap))}</td><td ${TD}>${pill(b.A.sigClose, pct(b.A.vsFcst))}</td><td ${TD}>${hc(b.A.short, RULE.csStd, null, true)}</td>`
      + `<td ${TD}>${(() => { const s = (b.B || []).filter(x => x.stock); if (!s.length) return '—'; const ns = s.filter(x => x.stock.status === 'short').length, no = s.filter(x => x.stock.status === 'over').length; return (ns ? pill(SIG.bad, '부족 ' + ns) + ' ' : '') + (no ? pill(SIG.warn, '과다 ' + no) : '') || '<span style="color:#15803d;">적정</span>'; })()}</td>`
      + `<td ${TD}>${b.C.trend && b.C.trend.down2 ? pill(SIG.bad, '↓↓') : (trendText(b.C.trend) ? '<span style="color:#6b7280;font-size:11px;">' + trendText(b.C.trend) + '</span>' : '—')}</td><td ${TD}>${b.E.length}</td></tr>`).join('');
    return headLine(t.A, null) + targetTable(t.A) + paceTable(t.A)
      + H('지점별 (HL · 환산 c/s)') + TABLE(`<th ${THL}>지점</th><th ${TH}>월 FCST</th><th ${TH}>FCST÷RoFo</th><th ${TH}>FCST÷AP</th><th ${TH}>진도</th><th ${TH}>마감 전망</th><th ${TH}>부족·초과</th><th ${TH}>월초 재고<br>(주요 SKU)</th><th ${TH}>FCST 추이</th><th ${TH}>질문</th>`, rows)
      + NOTE('ALSM은 별도 채널 — On TTL에 합산하지 않음') + blockC(t.C, RULE.csStd) + footer(R);
  }

  // ── 월 전환 주 카드 ──
  function closeTable(T, cl) {
    const row = (name, goal, ach) => `<tr><td ${TDL}><b>${name}</b></td><td ${TD}>${hc(goal, cl.csf)}</td><td ${TD}>${pill(name === 'FCST' ? cl.sigClose : achSig(ach), pct(ach))}</td><td ${TD}>${goal != null && cl.expClose != null ? hc(cl.expClose - goal, cl.csf, null, true) : '—'}</td></tr>`;
    return H(`① ${T.prev.month}월 마감 전망 (HL · c/s)`)
      + `<div style="font-size:12px;color:#374151;margin:2px 0;">실적 ${f1(cl.mtd)} HL · 남은 ${cl.remainWd}영업일 · 지금 속도면 <b>${f0(cl.expClose)} HL (${f0(cl.expClose / cl.csf)} c/s)</b>${cl.fcstSrc ? ' · FCST ' + esc(cl.fcstSrc) : ''}</div>`
      + TABLE(`<th ${THL}>기준</th><th ${TH}>목표</th><th ${TH}>마감 전망 달성률</th><th ${TH}>전망 − 목표</th>`,
        row('FCST', cl.fcst, cl.vsFcst) + row('RoFo', cl.rofo, cl.expVsRofo) + row('AP', cl.ap, cl.expVsAp));
  }
  function startTable(T, st) {
    const nm = T.next.month;
    return H(`② ${nm}월 시작 (HL · c/s)`)
      + TABLE(`<th ${THL}>기준</th><th ${TH}>목표</th><th ${TH}>FCST 달성률</th>`,
        `<tr><td ${TDL}><b>FCST</b>${st.fcstSrc ? SMALL(esc(st.fcstSrc)) : ''}</td><td ${TD}>${st.fcst != null ? hc(st.fcst, st.csf) : '<span style="color:#b91c1c;">미제출</span>'}</td><td ${TD}><span style="color:#9ca3af;">기준</span></td></tr>`
        + `<tr><td ${TDL}><b>RoFo</b></td><td ${TD}>${hc(st.rofo, st.csf)}</td><td ${TD}>${pill(achSig(st.fcstVsRofo), pct(st.fcstVsRofo))}</td></tr>`
        + `<tr><td ${TDL}><b>AP</b></td><td ${TD}>${hc(st.ap, st.csf)}</td><td ${TD}>${pill(achSig(st.fcstVsAp), pct(st.fcstVsAp))}</td></tr>`
        + `<tr><td ${TDL}><b>전년 ${nm}월</b></td><td ${TD}>${hc(st.ly, st.csf)}</td><td ${TD}>${st.vsLy != null ? (st.vsLy >= 0 ? '+' : '') + (st.vsLy * 100).toFixed(1) + '%' : '—'}</td></tr>`)
      + `<div style="font-size:12px;color:#374151;margin:2px 0 4px;">${st.basis || '목표'} 달성에 <b>주당 ${f1(st.needWeekly)} HL (${f0(st.needWeekly / st.csf)} c/s)</b> 필요 · 최근 주당 ${f1(st.recentWeekly)} HL → 필요 속도 ${pill(st.sigSpeed, st.speedUp != null ? (st.speedUp >= 0 ? '+' : '−') + Math.abs(Math.round(st.speedUp * 100)) + '%' : '—')}</div>`
      + NOTE(`필요 속도 = 주당 필요 ÷ ${T.prev.month}월 최근 2주 주당 실적 − 1 (0% 이하 유효 / +20% 이하 주의) · ${nm}월 영업일 ${st.totalWd}일${st.basis === 'RoFo' ? ' · FCST 미제출이라 RoFo 기준' : ''}`);
  }
  function startSkuTable(T, B) {
    if (!B || !B.length) return '';
    return H(`${T.next.month}월 핵심 SKU (HL · c/s)`) + TABLE(`<th ${THL}>SKU</th><th ${TH}>월 FCST</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>필요 속도</th>`,
      B.map(x => `<tr><td ${TDL}>${esc(x.label)}</td><td ${TD}>${hc(x.fcst, x.csf, x.unit)}</td><td ${TD}>${hc(x.needWeekly, x.csf, x.unit)}</td><td ${TD}>${hc(x.recentWeekly, x.csf, x.unit)}</td>`
        + `<td ${TD}>${pill(x.sigSpeed, x.speedUp != null ? (x.speedUp >= 0 ? '+' : '−') + Math.abs(Math.round(x.speedUp * 100)) + '%' : '—')}</td></tr>`).join(''));
  }
  function transitionHead(T, t) {
    return `<div style="font-size:12px;color:#6b7280;margin-bottom:4px;">월 전환 주 — <b style="color:#205527;">${T.prev.month}월 마감</b> · <b style="color:#205527;">${T.next.month}월 시작</b></div>`
      + `<div style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;margin-bottom:4px;">`
      + `<span>${T.prev.month}월 마감 전망 ${pill(t.close.sigClose, pct(t.close.vsFcst))} <span style="color:#6b7280;">FCST ${t.close.short >= 0 ? '초과' : '부족'} ${f1(Math.abs(t.close.short))} HL (${f0(Math.abs(t.close.short) / t.close.csf)} c/s)</span></span>`
      + `<span>${T.next.month}월 필요 속도 ${pill(t.start.sigSpeed, t.start.speedUp != null ? (t.start.speedUp >= 0 ? '+' : '−') + Math.abs(Math.round(t.start.speedUp * 100)) + '%' : '—')} <span style="color:#6b7280;">${t.start.basis || ''} 기준 주당 ${f1(t.start.needWeekly)} HL 필요</span>${t.start.fcst == null ? ' ' + pill(SIG.warn, T.next.month + '월 FCST 미제출') : ''}</span>`
      + `</div>`;
  }
  function branchTransitionHtml(R, t, b) {
    const T = R.transition;
    return transitionHead(T, t) + closeTable(T, t.close) + startTable(T, t.start) + startSkuTable(T, t.B) + stockTable(t.B, `${T.next.month}월 월초 재고 (주요 SKU)`)
      + (b && b.C ? blockC(b.C, RULE.csStd, `C. FCST 변화 (${R.week.month}월 데이터)`) : '') + blockE(t.E) + footer(R);
  }
  function ttlTransitionHtml(R) {
    const T = R.transition, t = T.ttl, all = [...T.branches, T.alsm].filter(Boolean);
    const rows = all.map(x => `<tr><td ${TDL}><b>${esc(x.label)}</b></td><td ${TD}>${pill(x.close.sigClose, pct(x.close.vsFcst))}</td><td ${TD}>${hc(x.close.short, RULE.csStd, null, true)}</td>`
      + `<td ${TD}>${x.start.fcst != null ? hc(x.start.fcst, RULE.csStd) : '<span style="color:#b91c1c;">미제출</span>'}</td><td ${TD}>${pill(achSig(x.start.fcstVsRofo), pct(x.start.fcstVsRofo))}</td><td ${TD}>${pill(achSig(x.start.fcstVsAp), pct(x.start.fcstVsAp))}</td>`
      + `<td ${TD}>${pill(x.start.sigSpeed, x.start.speedUp != null ? (x.start.speedUp >= 0 ? '+' : '−') + Math.abs(Math.round(x.start.speedUp * 100)) + '%' : '—')}</td><td ${TD}>${x.E.length}</td></tr>`).join('');
    return transitionHead(T, t) + closeTable(T, t.close) + startTable(T, t.start)
      + H('지점별 (HL · 환산 c/s)') + TABLE(`<th ${THL}>지점</th><th ${TH}>${T.prev.month}월 마감 전망</th><th ${TH}>부족·초과</th><th ${TH}>${T.next.month}월 FCST</th><th ${TH}>FCST÷RoFo</th><th ${TH}>FCST÷AP</th><th ${TH}>필요 속도</th><th ${TH}>질문</th>`, rows)
      + NOTE('ALSM은 별도 채널 — On TTL에 합산하지 않음') + footer(R);
  }

  // 계산 결과 → 자동 카드 배열 (On TTL, 지점 5, ALSM)
  function cards(R) {
    const T = R.transition;
    const mk = (b, html, subtitle, t) => ({ kind: 'bw', auto: true, category: b.cat, subtitle, content: html,
      data: { A: b.A, B: b.B, C: b.C, E: b.E, signal: b.signal, regions: b.regions || null, transition: t || null },
      generatedAt: R.generatedAt, dsrAsOf: R.dsrAsOf });
    const wk = (R.meeting && R.meeting.label) || R.week.label || '';
    if (T) {
      const out = [mk(R.ttl, ttlTransitionHtml(R), `On TTL 위클리 — ${wk} (${T.prev.month}월 마감·${T.next.month}월 시작)`, { close: T.ttl.close, start: T.ttl.start })];
      T.branches.forEach((t, i) => out.push(mk(R.branches[i], branchTransitionHtml(R, t, R.branches[i]), `${t.label} 분석`, { close: t.close, start: t.start, B: t.B, E: t.E })));
      if (R.alsm && T.alsm) out.push(mk(R.alsm, branchTransitionHtml(R, T.alsm, R.alsm), 'ALSM 분석 (합계 기준)', { close: T.alsm.close, start: T.alsm.start, E: T.alsm.E }));
      return out;
    }
    const out = [mk(R.ttl, ttlHtml(R), `On TTL 위클리 — ${wk}`)];
    R.branches.forEach(b => out.push(mk(b, branchHtml(R, b), `${b.label} 분석`)));
    if (R.alsm) out.push(mk(R.alsm, branchHtml(R, R.alsm), 'ALSM 분석 (합계 기준)'));
    return out;
  }

  global.BranchWeekly = { compute, cards, BRANCHES, CORE, SKU, RULE, _internal: { monthView, startView, recentWeekly, fcstTrend, bookFcst } };
})(typeof window !== 'undefined' ? window : this);
