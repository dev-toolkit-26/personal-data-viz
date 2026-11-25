// ════════════════════════════════════════════════════════════════════
//  branch_weekly.js — 지점별 주간 분석 계산부 (Weekly Review 지점별분석 스펙 1단계: A·B·C·E)
//
//  · 화면 없이 숫자만 계산한다. Minutes 위클리 자동 카드(2단계)가 이 결과를 렌더·저장한다.
//  · 입력은 대시보드 데이터(DASHBOARD_DATA)와 ALSM 모델(window._ALSM)뿐 — 새 데이터 소스 없음.
//  · 이 파일에는 규칙만 둔다. 기준값·물량은 런타임에 Supabase 데이터에서 온다 (Public 저장소 규칙).
//
//  블록
//   A 필요수량   : 월 잔여(FCST − MTD) ÷ 남은 영업일 → 주당 필요, 최근 주당 실적 대비 필요 배수, 연간 착지
//   B 핵심 SKU   : 지점별 핵심 SKU에 A와 같은 계산 (20L은 keg 수 병기)
//   C FCST 요약  : 전주 대비 변경·변경 큰 SKU, 2주 연속 하향(주차별 제출 FCST), 월말 몰림(발주패턴)
//   E 미팅 질문  : A~C 규칙에 걸린 것만 지점당 최대 3개 (질문 형태)
//  1단계 제외: NKA·미니바·DC 코드 구분(현재 집계에 없음), FCST 정확도(이력 부족), D 블록(1월)
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

  // ── 핵심 SKU (지점별분석_스펙 3장). match = SKU 코드 판정 함수 ──
  const SKU = {
    he20:  { label: 'HE 20L',      match: s => s === 'HE ORI 20000 Air Keg', keg: true },
    pa20:  { label: 'PA 20L',      match: s => /^PA \S+ 20000 Keg$/i.test(s), keg: true },
    he330b:{ label: 'HE 330병',    match: s => s === 'HE ORI 330 Bottle' },
    he00b: { label: 'HE 0.0 330병', match: s => s === 'HE 0.0 330 Bottle' },
    he330c:{ label: 'HE 330캔',    match: s => s === 'HE ORI 330 Can' },
    su500b:{ label: 'SNOW 500병',  match: s => s === 'SU ORI 500 Bottle' },
    he500c:{ label: 'HE 500캔',    match: s => s === 'HE ORI 500 Can' },
    pa500c:{ label: 'PA 500캔',    match: s => /^PA (WHE|HEL) 500 Can$/i.test(s) },
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

  // ── 규칙 상수 (설계_구조 4장 · 스펙 2장) ──
  const RULE = {
    progressWarn: -0.05, progressBad: -0.10,   // (MTD÷FCST) − 영업일 경과율
    multWarn: 1.0, multBad: 1.2,               // 주당 필요 ÷ 최근 주당 실적
    crowdBad: 1.2,                             // 남은 필요 ÷ 발주패턴상 남은 기대
    recentCalDays: 14,                         // 최근 실적 = DSR 기준일까지 최근 14일(2주) 달력 구간, 그 구간 영업일 수로 나눔
    weekDays: 5,                               // 주 영업일
    kegHl: 0.2,                                // 20L keg = 0.2 HL
    downTol: 0.5,                              // 2주 연속 하향 판정 허용오차(HL)
    maxQuestions: 3,
    skuQuestionMinShare: 0.10,
    closeOk: 0.97, closeWarn: 0.90,            // 월 전환: 예상 마감 ÷ 월 FCST — 97%↑ 유효 / 90%↑ 주의 / 미만 깨짐
    gapWarn: -0.05,                            // 월 전환: 다음 달 FCST가 RoFo보다 5% 넘게 낮으면 질문                 // SKU 질문은 지점 필요량의 10% 이상 차지하는 SKU만 (소량 SKU 배수 과장 방지)
  };

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const sumArr = (a, from, to) => { let s = 0; if (Array.isArray(a)) for (let i = from; i <= to; i++) s += +a[i] || 0; return s; };
  const SIG = { ok: { k: 'ok', lbl: '유효', rank: 0 }, warn: { k: 'warn', lbl: '주의', rank: 1 }, bad: { k: 'bad', lbl: '깨짐', rank: 2 } };

  function sigProgress(mtd, fcst, wdPct) {
    if (!(fcst > 0) || mtd == null || !(wdPct > 0)) return null;
    const gap = mtd / fcst - wdPct;
    return Object.assign({ gap }, gap >= RULE.progressWarn ? SIG.ok : gap >= RULE.progressBad ? SIG.warn : SIG.bad);
  }
  function sigMultiple(m) {
    if (m == null) return null;
    return m <= RULE.multWarn ? SIG.ok : m <= RULE.multBad ? SIG.warn : SIG.bad;
  }
  function worst(...s) { return s.filter(Boolean).sort((a, b) => b.rank - a.rank)[0] || null; }

  // 'MM/DD' 라벨 → Date. 기준일보다 뒤 달이면 전년도(12월→1월 경계)
  function labelDate(lbl, ref) {
    const p = String(lbl).split('/'); const m = parseInt(p[0], 10), d = parseInt(p[1], 10);
    if (!(m >= 1) || !(d >= 1)) return null;
    const y = ref ? (m > ref.getMonth() + 1 + 1 ? ref.getFullYear() - 1 : ref.getFullYear()) : new Date().getFullYear();
    return new Date(y, m - 1, d);
  }
  function weekdays(a, b) { let c = 0; const d = new Date(a); while (d <= b) { const w = d.getDay(); if (w >= 1 && w <= 5) c++; d.setDate(d.getDate() + 1); } return c; }

  // 최근 주당 실적(HL): DSR 기준일까지 최근 14일 구간의 일자별 실적 합 ÷ 구간 영업일 × 주 영업일.
  //  라벨에 주말 날짜도 섞여 있어(주말 출고) 라벨 개수가 아니라 달력 구간으로 자른다. 반품(음수)도 그대로 반영.
  function recentWeekly(op, groups, skuFilter, year) {
    if (!op || !op.daily_hl || !Array.isArray(op.daily_labels) || !op.daily_labels.length) return null;
    const L = op.daily_labels, n = L.length;
    const ref = new Date(year || new Date().getFullYear(), 11, 31);
    const asOf = labelDate(L[n - 1], ref); if (!asOf) return null;
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
    return any ? { v: s / biz * RULE.weekDays, days: biz, from: (from.getMonth() + 1) + '/' + from.getDate(), asOf: L[n - 1] } : null;
  }

  // A·B 공통: 월 FCST·MTD → 잔여·주당 필요·배수
  function needOf(fcst, mtd, wd, recent) {
    const remainWd = Math.max((wd.total || 0) - (wd.elapsed || 0), 0);
    const remain = (fcst != null && mtd != null) ? fcst - mtd : null;   // 음수 = FCST 초과
    const need = remain != null ? Math.max(remain, 0) : null;
    const needDaily = (need != null && remainWd > 0) ? need / remainWd : null;
    const needWeekly = needDaily != null ? needDaily * RULE.weekDays : null;
    // 최근 실적이 없으면 MTD 런레이트로 대체
    let rw = recent ? recent.v : null, rwSrc = recent ? 'recent' : null;
    if (rw == null && mtd != null && wd.elapsed > 0) { rw = mtd / wd.elapsed * RULE.weekDays; rwSrc = 'runrate'; }
    const multiple = (needWeekly != null && rw > 0) ? needWeekly / rw : (needWeekly === 0 ? 0 : null);
    return { fcst, mtd, remain, need, remainWd, needDaily, needWeekly, recentWeekly: rw, recentSrc: rwSrc, multiple, sigMultiple: sigMultiple(multiple) };
  }

  // 주차별 제출 FCST(통합 양식 저장본) → 지점 HL 시리즈 → 2주 연속 하향
  function downStreak(D, bookKey, year, mon, hfOf) {
    const book = D.on_fcst_book; if (!book || !book.months) return null;
    const M = book.months[`${year}-${String(mon).padStart(2, '0')}`];
    if (!M || !M.rows || !M.rows[bookKey]) return null;
    const sub = (M.submitted && M.submitted[bookKey]) || [];
    const series = [];
    for (let k = 0; k < 5; k++) {
      if (!sub[k]) continue;
      let s = 0; Object.entries(M.rows[bookKey]).forEach(([sku, x]) => { s += (+((x.w || [])[k]) || 0) * hfOf(sku); });
      series.push({ w: k + 1, hl: s });
    }
    const n = series.length;
    const flag = n >= 3 && series[n - 1].hl < series[n - 2].hl - RULE.downTol && series[n - 2].hl < series[n - 3].hl - RULE.downTol;
    return { series, flag };
  }

  // 월말 몰림: 남은 필요 ÷ (FCST × 발주패턴상 남은 비중)
  function crowdOf(fcst, need, cumFrac) {
    if (!(fcst > 0) || need == null || cumFrac == null) return null;
    const expRemain = fcst * Math.max(1 - cumFrac, 0);
    const ratio = expRemain > 0 ? need / expRemain : (need > 0 ? Infinity : 0);
    return { ratio, expRemain, remainShare: need / fcst, flag: ratio > RULE.crowdBad };
  }

  // 지점 SKU 맵: sku → {fcst, mtd, last, d}(HL) — 같은 핵심 키에 여러 SKU면 합산
  function skuRows(D, skuKey) {
    const out = {};
    ((D.sku_detail || {})[skuKey] || []).forEach(b => (b.skus || []).forEach(s => {
      const d = s.data || {}, f = d.hl_factor != null ? d.hl_factor : 0.0792;
      out[s.sku] = { sku: s.sku, brand: b.brand, hf: f,
        fcst: (num(d.this_week_fcst) || 0) * f, mtd: (num(d.mtd) || 0) * f,
        last: num(d.last_week_fcst) != null ? d.last_week_fcst * f : null,
        d: num(d.differ_vs_last) != null ? d.differ_vs_last * f : 0 };
    }));
    return out;
  }

  function questions(br, A, B, C, isDec) {
    const q = [];
    const push = (pri, text) => q.push({ pri, text });
    const f1 = v => (+v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    if (C.crowd && C.crowd.flag) push(isDec ? 0 : 4, `${br} 월말 몰림 — 남은 필요가 패턴 기대의 ${f1(C.crowd.ratio)}배. 노멀 마감 가능한가?`);
    if (A.multiple != null && A.multiple > RULE.multBad) push(1, `${br} 주당 필요가 최근 실적의 ${f1(A.multiple)}배 — 남은 기간 어디서 메우나?`);
    const worstSku = (B || []).filter(x => x.multiple != null && x.multiple > RULE.multBad && (x.share == null || x.share >= RULE.skuQuestionMinShare)).sort((a, b) => b.multiple - a.multiple)[0];
    if (worstSku) push(2, `${worstSku.label} 필요량 대비 실적 부족(${f1(worstSku.multiple)}배) — 원인과 대응은?`);
    if (C.down && C.down.flag) push(3, `${br} FCST 2주 연속 하향 — 일시적인가, 구조적인가?`);
    const sp = A.sigProgress, sm = A.sigMultiple;
    if (sp && sm && Math.abs(sp.rank - sm.rank) >= 2)
      push(5, sp.rank < sm.rank ? `${br} MTD 진척은 괜찮은데 남은 기간 필요량이 큼 — FCST 확인 필요` : `${br} MTD는 뒤처졌지만 남은 기간 필요량은 무난 — 월말 집중 계획 확인`);
    return q.sort((a, b) => a.pri - b.pri).slice(0, RULE.maxQuestions).map(x => x.text);
  }

  // ── 지점 1개 ──
  function computeBranch(D, b, ctx) {
    const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
    const op = D.order_pattern;
    const fcst = num(hl.this_week_fcst), mtd = num(hl.mtd_actual);
    const A = needOf(fcst, mtd, ctx.wd, recentWeekly(op, b.groups, null, ctx.year));
    A.sigProgress = sigProgress(mtd, fcst, ctx.wd.pct);
    A.progress = (fcst > 0 && mtd != null) ? mtd / fcst : null;
    // 연간 착지 = 마감월 실적 + max(당월 FCST, MTD) + 이후 월 RoFo
    const ytdAct = sumArr((D.dsr_by_region_monthly || {})[b.hl], 0, ctx.ci - 1);
    const rofo = Array.isArray(hl.rofo_monthly) ? hl.rofo_monthly : null;
    const fwd = rofo ? sumArr(rofo, ctx.ci + 1, 11) : null;
    A.landing = (fcst != null || mtd != null) && fwd != null ? ytdAct + Math.max(fcst || 0, mtd || 0) + fwd : null;
    A.rofoFY = rofo ? sumArr(rofo, 0, 11) : null;
    A.gapFY = (A.landing != null && A.rofoFY > 0) ? A.landing - A.rofoFY : null;   // 표시는 AP 확정 후
    A.rofoMonth = rofo ? num(rofo[ctx.ci]) : null;

    // B 핵심 SKU
    const rows = skuRows(D, b.sku);
    const B = (CORE[b.key] || []).map(id => {
      const def = SKU[id];
      const hit = Object.values(rows).filter(r => def.match(r.sku));
      if (!hit.length) return null;
      const f = hit.reduce((s, r) => s + r.fcst, 0), m = hit.reduce((s, r) => s + r.mtd, 0);
      const x = needOf(f, m, ctx.wd, recentWeekly(op, b.groups, def.match, ctx.year));
      x.id = id; x.label = def.label; x.skus = hit.map(r => r.sku);
      x.share = (A.need > 0 && x.need != null) ? x.need / A.need : null;
      if (def.keg) { x.kegFcst = f / RULE.kegHl; x.kegNeedWeekly = x.needWeekly != null ? x.needWeekly / RULE.kegHl : null; }
      return x;
    }).filter(Boolean);

    // C FCST 요약
    const topSku = Object.values(rows).filter(r => Math.abs(r.d) >= 0.05).sort((a, c) => Math.abs(c.d) - Math.abs(a.d)).slice(0, 3)
      .map(r => ({ sku: r.sku, d: r.d, fcst: r.fcst }));
    const C = {
      thisWeek: fcst, lastWeek: num(hl.last_week_fcst), change: num(hl.differ_vs_last),
      changePct: (num(hl.last_week_fcst) > 0 && num(hl.differ_vs_last) != null) ? hl.differ_vs_last / hl.last_week_fcst : null,
      topSku,
      down: downStreak(D, b.book, ctx.year, ctx.mon, sku => (rows[sku] && rows[sku].hf) || ctx.hfOf(sku)),
      crowd: crowdOf(fcst, A.need, ctx.cumFrac),
      accuracy: null,   // 1단계 보류 — 회의록이 쌓이면 지난 회의록의 마지막 제출 FCST와 비교
    };
    const E = questions(b.label, A, B, C, ctx.mon === 12);
    return { key: b.key, label: b.label, cat: b.cat, A, B, C, E, signal: worst(A.sigProgress, A.sigMultiple) };
  }

  // ── ALSM (Off 스냅샷 모델 _ALSM, 권역 FCST 없음 → 합계 기준) ──
  function computeAlsm(Am, ctx) {
    if (!Am || Am.error) return null;
    const ci = ctx.ci;
    let wkFcst = null;
    const arr = Am.wf && Am.wf[ci];
    if (Array.isArray(arr)) for (let w = 4; w >= 0; w--) if ((+arr[w] || 0) > 0) { wkFcst = { cw: w, tw: +arr[w], lw: w > 0 ? (+arr[w - 1] || 0) : null }; break; }
    const fcst = Am.fcst[ci] > 0 ? Am.fcst[ci] : (wkFcst ? wkFcst.tw : null);
    const mtd = num(Am.act[ci]);
    // 최근 주당 실적: 주간 발주(1~7일 단위) 중 끝난 주 최근 2개 평균 → 없으면 런레이트
    let recent = null;
    const wa = Am.wacct && Am.wacct[ci];
    if (Array.isArray(wa)) {
      const doneWeeks = Math.floor((ctx.asOfDay || 0) / 7);
      const vals = wa.slice(0, doneWeeks).filter(v => v > 0).slice(-2);
      if (vals.length) recent = { v: vals.reduce((s, v) => s + v, 0) / vals.length, days: vals.length * 7 };
    }
    const A = needOf(fcst, mtd, ctx.wd, recent);
    A.sigProgress = sigProgress(mtd, fcst, ctx.wd.pct);
    A.progress = (fcst > 0 && mtd != null) ? mtd / fcst : null;
    const fwd = sumArr(Am.rofo, ci + 1, 11);
    A.landing = (fcst != null || mtd != null) ? sumArr(Am.act, 0, ci - 1) + Math.max(fcst || 0, mtd || 0) + fwd : null;
    A.rofoFY = sumArr(Am.rofo, 0, 11);
    A.gapFY = (A.landing != null && A.rofoFY > 0) ? A.landing - A.rofoFY : null;
    A.rofoMonth = num(Am.rofo[ci]);
    const B = CORE.alsm.map(id => {
      const def = SKU[id];
      const hit = (Am.skus || []).filter(s => def.match(s.sku));
      if (!hit.length) return null;
      const f = hit.reduce((s, r) => s + (+r.fcst[ci] || 0), 0), m = hit.reduce((s, r) => s + (+r.act[ci] || 0), 0);
      const x = needOf(f, m, ctx.wd, null);   // SKU별 최근 실적 없음 → 런레이트
      x.id = id; x.label = def.label; x.skus = hit.map(r => r.sku);
      x.share = (A.need > 0 && x.need != null) ? x.need / A.need : null;
      return x;
    }).filter(Boolean);
    const C = {
      thisWeek: wkFcst ? wkFcst.tw : fcst, lastWeek: wkFcst ? wkFcst.lw : null,
      change: (wkFcst && wkFcst.lw != null) ? wkFcst.tw - wkFcst.lw : null,
      changePct: (wkFcst && wkFcst.lw > 0) ? (wkFcst.tw - wkFcst.lw) / wkFcst.lw : null,
      topSku: [],
      down: Array.isArray(arr) ? (() => {
        const series = arr.map((v, k) => ({ w: k + 1, hl: +v || 0 })).filter(x => x.hl > 0), n = series.length;
        return { series, flag: n >= 3 && series[n - 1].hl < series[n - 2].hl - RULE.downTol && series[n - 2].hl < series[n - 3].hl - RULE.downTol };
      })() : null,
      crowd: crowdOf(fcst, A.need, ctx.cumFrac),
      accuracy: null,
    };
    const regions = (Am.regions || []).map(r => ({ key: r.key, mtd: num(r.act[ci]),
      ytd: sumArr(r.act, 0, ci - 1), ytdLy: sumArr(r.ly, 0, ci - 1) }));
    const E = questions('ALSM', A, B, C, ctx.mon === 12);
    return { key: 'alsm', label: 'ALSM', cat: 'alsm', A, B, C, E, regions, signal: worst(A.sigProgress, A.sigMultiple), basis: '합계(권역 FCST 없음)' };
  }

  // ════════════════════════════════════════════════════════════════
  //  월 전환 주 (회의 주의 월~일이 두 달에 걸칠 때, 예: 11/30 주)
  //   ① 전월 마감: 남은 영업일 필요량, 최근 실적 속도로 본 예상 마감 vs FCST·RoFo, 마감 후엔 FCST 정확도
  //   ② 다음 달 시작: 다음 달 FCST(없으면 RoFo) vs RoFo·LY, 주당 필요 vs 최근 2주 실적, 핵심 SKU
  //  데이터 월(wk_meta.month)이 아직 전월이든(다음 달 FCST 미업로드) 이미 다음 달이든 같은 결과가 나오게
  //  월 FCST는 그 달이 데이터 월이면 지점 합계, 아니면 통합 양식 저장본의 마지막 제출 주차에서 읽는다.
  // ════════════════════════════════════════════════════════════════
  const lastDayOf = (y, m) => new Date(y, m, 0);
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
  // 지점의 m월 FCST(HL): 데이터 월이면 지점 합계(+SKU), 아니면 저장본 마지막 제출
  function monthFcst(D, b, ctx, y, m) {
    if (ctx.mon === m && y === ctx.year) {
      const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
      const rows = skuRows(D, b.sku), bySku = {};
      Object.values(rows).forEach(r => { bySku[r.sku] = r.fcst; });
      return num(hl.this_week_fcst) != null ? { hl: hl.this_week_fcst, bySku, src: '이번 주 제출' } : null;
    }
    const bf = b.book ? bookFcst(D, b.book, y, m, sku => ctx.hfOf(sku)) : null;
    return bf ? { hl: bf.hl, bySku: bf.bySku, src: `W${bf.col} 제출` } : null;
  }
  function closeOf(fcst, rofo, actual, remainWd, recentWeekly) {
    const rd = recentWeekly != null ? recentWeekly / RULE.weekDays : null;
    const exp = actual != null ? actual + (rd != null ? rd * remainWd : 0) : null;
    const need = (fcst != null && actual != null) ? Math.max(fcst - actual, 0) : null;
    const vsF = (exp != null && fcst > 0) ? exp / fcst : null;
    const sig = vsF == null ? null : vsF >= RULE.closeOk ? SIG.ok : vsF >= RULE.closeWarn ? SIG.warn : SIG.bad;
    return { fcst, rofo, actual, remainWd, recentWeekly, need, needDaily: (need != null && remainWd > 0) ? need / remainWd : null,
      expClose: exp, vsFcst: vsF, vsRofo: (exp != null && rofo > 0) ? exp / rofo : null,
      accuracy: (remainWd === 0 && fcst > 0 && actual != null) ? actual / fcst : null, sig };
  }
  function startOf(fcst, rofo, ly, totalWd, recent) {
    const target = fcst != null ? fcst : rofo;
    const needWeekly = (target != null && totalWd > 0) ? target / totalWd * RULE.weekDays : null;
    const m = (needWeekly != null && recent > 0) ? needWeekly / recent : null;
    return { fcst, rofo, ly, target, basis: fcst != null ? 'FCST' : (rofo != null ? 'RoFo' : null), totalWd, needWeekly,
      recentWeekly: recent, multiple: m, sigMultiple: sigMultiple(m),
      gapRofo: (fcst != null && rofo > 0) ? fcst / rofo - 1 : null, vsLy: (target != null && ly > 0) ? target / ly - 1 : null };
  }
  function transitionQuestions(br, cl, st, pm, nm) {
    const q = [], f1q = v => (+v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    if (st.multiple != null && (nm === 12 ? st.multiple > RULE.multWarn : st.multiple > RULE.multBad))
      q.push({ pri: nm === 12 ? 0 : 2, text: nm === 12
        ? `${br} 12월 주당 필요가 최근 실적의 ${f1q(st.multiple)}배 — 연말 노멀 마감 계획은?`
        : `${br} ${nm}월 주당 필요가 최근 실적의 ${f1q(st.multiple)}배 — 첫 주부터 어떻게 확보하나?` });
    if (st.fcst == null) q.push({ pri: 1, text: `${br} ${nm}월 FCST 미제출 — 제출 일정은? (지금은 RoFo 기준으로 계산)` });
    else if (st.gapRofo != null && st.gapRofo < RULE.gapWarn) q.push({ pri: 3, text: `${br} ${nm}월 FCST가 RoFo 대비 ${(st.gapRofo * 100).toFixed(0)}% — 갭 메울 계획은?` });
    if (cl.sig && cl.sig.k === 'bad' && cl.remainWd > 0) q.push({ pri: 1, text: `${br} ${pm}월 남은 ${cl.remainWd}일 필요 ${f1q(cl.need)} HL(예상 마감 FCST의 ${(cl.vsFcst * 100).toFixed(0)}%) — 마감 가능한가?` });
    return q.sort((a, b) => a.pri - b.pri).slice(0, RULE.maxQuestions).map(x => x.text);
  }
  function computeTransition(D, opts, ctx, span, alsmModel, alsmRes) {
    const op = D.order_pattern;
    const pm = span.prev.month, nm = span.next.month, py = span.prev.year, ny = span.next.year;
    const L = (op && op.daily_labels) || [];
    const asOfDate = L.length ? labelDate(L[L.length - 1], new Date(ctx.year, 11, 31)) : null;
    const pmEnd = lastDayOf(py, pm);
    let remainWd = 0;
    if (asOfDate && asOfDate < pmEnd) { const from = new Date(asOfDate); from.setDate(from.getDate() + 1); remainWd = weekdays(from, pmEnd); }
    const nmWd = weekdays(new Date(ny, nm - 1, 1), lastDayOf(ny, nm));
    const inFY = y => y === ctx.year;   // RoFo·실적 배열은 데이터 연도(12개월)만
    const ly25 = D.monthly_regional_2025 || {};
    const one = (b) => {
      const hl = ((D.wk10_summary || {}).hl || {})[b.hl] || {};
      const rofo = Array.isArray(hl.rofo_monthly) ? hl.rofo_monthly : null;
      const rw = recentWeekly(op, b.groups, null, ctx.year);
      const recent = rw ? rw.v : null;
      const pf = monthFcst(D, b, ctx, py, pm);
      const actual = inFY(py) ? num(((D.dsr_by_region_monthly || {})[b.hl] || [])[pm - 1]) : null;
      const cl = closeOf(pf ? pf.hl : null, rofo && inFY(py) ? num(rofo[pm - 1]) : null, actual, remainWd, recent);
      cl.fcstSrc = pf ? pf.src : null;
      const nf = monthFcst(D, b, ctx, ny, nm);
      const st = startOf(nf ? nf.hl : null, rofo && inFY(ny) ? num(rofo[nm - 1]) : null,
        inFY(ny) ? num((ly25[b.hl] || [])[nm - 1]) : null, nmWd, recent);
      st.fcstSrc = nf ? nf.src : null;
      // 다음 달 핵심 SKU (FCST가 있을 때만)
      const B = nf ? (CORE[b.key] || []).map(id => {
        const def = SKU[id];
        const skus = Object.keys(nf.bySku).filter(s => def.match(s));
        if (!skus.length) return null;
        const f = skus.reduce((s, k) => s + (nf.bySku[k] || 0), 0);
        const r = recentWeekly(op, b.groups, def.match, ctx.year);
        const x = startOf(f, null, null, nmWd, r ? r.v : null);
        x.id = id; x.label = def.label; x.skus = skus;
        x.share = (st.target > 0) ? f / st.target : null;
        if (def.keg) { x.kegFcst = f / RULE.kegHl; x.kegNeedWeekly = x.needWeekly != null ? x.needWeekly / RULE.kegHl : null; }
        return x;
      }).filter(Boolean) : [];
      return { key: b.key, label: b.label, cat: b.cat, close: cl, start: st, B, E: transitionQuestions(b.label, cl, st, pm, nm),
               signal: worst(cl.sig, st.sigMultiple) };
    };
    const branches = BRANCHES.map(one);
    const ttl = one({ key: 'ttl', label: 'On TTL', hl: 'TTL', sku: 'On Trade Total', book: null, groups: (op && op.groups) || [], cat: 'on_trade' });
    // TTL 월 FCST가 데이터 월이 아니면 저장본에 TTL이 없으니 지점 합으로
    if (ttl.close.fcst == null) { const s = branches.reduce((a, x) => a + (x.close.fcst || 0), 0); if (s > 0) Object.assign(ttl.close, closeOf(s, ttl.close.rofo, ttl.close.actual, remainWd, ttl.close.recentWeekly)); }
    if (ttl.start.fcst == null && branches.every(x => x.start.fcst != null)) { const s = branches.reduce((a, x) => a + x.start.fcst, 0); Object.assign(ttl.start, startOf(s, ttl.start.rofo, ttl.start.ly, nmWd, ttl.start.recentWeekly)); }
    ttl.B = []; ttl.E = [];
    let alsm = null;
    if (alsmModel && !alsmModel.error && alsmRes) {
      const lastWf = (m) => { const a = alsmModel.wf && alsmModel.wf[m - 1]; if (!Array.isArray(a)) return null; for (let w = 4; w >= 0; w--) if (+a[w] > 0) return +a[w]; return null; };
      const pF = inFY(py) ? (alsmModel.fcst[pm - 1] > 0 ? alsmModel.fcst[pm - 1] : lastWf(pm)) : null;
      const nF = inFY(ny) ? (alsmModel.fcst[nm - 1] > 0 ? alsmModel.fcst[nm - 1] : lastWf(nm)) : null;
      const recent = alsmRes.A.recentWeekly;
      const cl = closeOf(pF, inFY(py) ? num(alsmModel.rofo[pm - 1]) : null, inFY(py) ? num(alsmModel.act[pm - 1]) : null, remainWd, recent);
      const st = startOf(nF, inFY(ny) ? num(alsmModel.rofo[nm - 1]) : null, inFY(ny) ? num(alsmModel.ly[nm - 1]) : null, nmWd, recent);
      alsm = { key: 'alsm', label: 'ALSM', cat: 'alsm', close: cl, start: st, B: [], E: transitionQuestions('ALSM', cl, st, pm, nm), signal: worst(cl.sig, st.sigMultiple) };
    }
    return { prev: { year: py, month: pm, remainWd }, next: { year: ny, month: nm, totalWd: nmWd }, ttl, branches, alsm };
  }

  // ── 전체 ──
  //  opts: { alsm: window._ALSM, hfOf: sku → HL 계수, meeting: { label, span:{prev:{year,month}, next:{year,month}} } }
  function compute(D, opts) {
    opts = opts || {};
    const wd = D.wd_progress || {};
    const mon = (D.wk_meta && D.wk_meta.month) || (new Date().getMonth() + 1);
    const year = (D.on_fcst_book && D.on_fcst_book.year) || new Date().getFullYear();
    const op = D.order_pattern;
    let cumFrac = wd.pct || null, patSrc = 'wd';
    if (typeof global._wrPatternClose === 'function') {
      try { const p = global._wrPatternClose(op, mon, wd.total || 0, wd.elapsed || 0); if (p) { cumFrac = p.cumFrac; patSrc = p.refLabel; } } catch (e) { /* 패턴 없으면 경과율 */ }
    }
    const asOf = op && Array.isArray(op.daily_labels) ? op.daily_labels[op.daily_labels.length - 1] : null;
    const asOfDay = asOf ? parseInt(String(asOf).split('/')[1], 10) || 0 : 0;
    const ctx = { wd, mon, ci: mon - 1, year, cumFrac, asOfDay, hfOf: opts.hfOf || (() => 0.0792) };

    const branches = BRANCHES.map(b => computeBranch(D, b, ctx));
    const ttl = computeBranch(D, { key: 'ttl', label: 'On TTL', hl: 'TTL', sku: 'On Trade Total', book: null, groups: (op && op.groups) || [], cat: 'on_trade' }, ctx);
    ttl.B = []; ttl.E = [];                      // TTL은 요약용: 핵심 SKU·질문은 지점 단위
    ttl.C.down = null;
    const alsm = computeAlsm(opts.alsm, ctx);
    const span = opts.meeting && opts.meeting.span;
    const transition = span ? computeTransition(D, opts, ctx, span, opts.alsm, alsm) : null;
    return {
      generatedAt: new Date().toISOString(),
      week: D.wk_meta ? { num: D.wk_meta.num, label: D.wk_meta.label, month: mon } : { month: mon },
      wd: { elapsed: wd.elapsed, total: wd.total, pct: wd.pct },
      dsrAsOf: asOf, pattern: { cumFrac, src: patSrc },
      ttl, branches, alsm, transition,
      meeting: opts.meeting ? { label: opts.meeting.label } : null,
      rules: RULE,
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  회의록 자동 카드 렌더 (Minutes 카드 본문 HTML — 밝은 배경, 인라인 스타일만)
  //  카드 = { kind:'bw', auto:true, category, subtitle, content(HTML), data(계산 결과 원본), generatedAt }
  // ════════════════════════════════════════════════════════════════
  const C_SIG = { ok: ['#15803d', '#dcfce7'], warn: ['#a16207', '#fef9c3'], bad: ['#b91c1c', '#fee2e2'] };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const f1 = v => (v == null || !isFinite(v)) ? '—' : (+v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  const f0 = v => (v == null || !isFinite(v)) ? '—' : Math.round(+v).toLocaleString('ko-KR');
  const pct = v => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(0) + '%';
  const sgn = v => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + f1(v);
  const mult = v => (v == null || !isFinite(v)) ? '—' : (v > 9.9 ? '10배↑' : f1(v) + '배');
  function pill(sig, text) {
    if (!sig) return '<span style="color:#9ca3af;">—</span>';
    const c = C_SIG[sig.k];
    return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;color:${c[0]};background:${c[1]};">${esc(text || sig.lbl)}</span>`;
  }
  const TH = 'style="padding:5px 8px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;"';
  const THL = 'style="padding:5px 8px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;white-space:nowrap;"';
  const TD = 'style="padding:5px 8px;text-align:right;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap;"';
  const TDL = 'style="padding:5px 8px;text-align:left;font-size:12px;border-bottom:1px solid #f3f4f6;white-space:nowrap;"';
  const TBL = 'style="width:100%;border-collapse:collapse;margin:4px 0 10px;"';
  const H = t => `<div style="font-size:12px;font-weight:700;color:#205527;margin:12px 0 4px;">${t}</div>`;
  const NOTE = t => `<div style="font-size:11px;color:#9ca3af;margin-top:2px;">${t}</div>`;

  function headLine(b) {
    const A = b.A;
    return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12.5px;margin-bottom:4px;">`
      + `<span>진척 ${pill(A.sigProgress)} <span style="color:#6b7280;">MTD ${pct(A.progress)} · 경과 ${pct(b._wdPct)}</span></span>`
      + `<span>필요 배수 ${pill(A.sigMultiple, A.multiple != null ? mult(A.multiple) + ' ' + (A.sigMultiple ? A.sigMultiple.lbl : '') : null)}</span>`
      + (b.C.crowd ? `<span>월말 몰림 ${b.C.crowd.flag ? pill(SIG.bad, mult(b.C.crowd.ratio)) : '<span style="color:#6b7280;">' + mult(b.C.crowd.ratio) + '</span>'}</span>` : '')
      + (b.C.down && b.C.down.flag ? `<span>${pill(SIG.bad, 'FCST 2주 연속 하향')}</span>` : '')
      + `</div>`;
  }
  function blockA(b) {
    const A = b.A;
    return H('A. 필요수량 (FCST 기준, HL)')
      + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${TH}>월 FCST</th><th ${TH}>MTD</th><th ${TH}>잔여</th><th ${TH}>남은 영업일</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>필요 배수</th><th ${TH}>연간 착지</th></tr>`
      + `<tr><td ${TD}>${f1(A.fcst)}</td><td ${TD}>${f1(A.mtd)}</td><td ${TD}>${A.remain != null && A.remain < 0 ? '초과 ' + f1(-A.remain) : f1(A.remain)}</td><td ${TD}>${A.remainWd}일</td>`
      + `<td ${TD}><b>${f1(A.needWeekly)}</b></td><td ${TD}>${f1(A.recentWeekly)}</td><td ${TD}>${pill(A.sigMultiple, mult(A.multiple))}</td><td ${TD}>${f0(A.landing)}</td></tr></table></div>`
      + NOTE(`최근 주당 = ${A.recentSrc === 'runrate' ? 'MTD 런레이트' : '최근 2주(10영업일) 실적'} · 연간 착지 = 마감월 실적 + 당월 max(FCST, MTD) + 이후 월 RoFo (RoFo 대비 갭은 AP 확정 후 표시)`);
  }
  function blockB(b) {
    if (!b.B || !b.B.length) return '';
    const rows = b.B.map(x => `<tr><td ${TDL}>${esc(x.label)}${x.kegFcst != null ? ' <span style="color:#9ca3af;font-size:11px;">(keg)</span>' : ''}</td>`
      + `<td ${TD}>${f1(x.fcst)}${x.kegFcst != null ? '<div style="font-size:10px;color:#9ca3af;">' + f0(x.kegFcst) + ' keg</div>' : ''}</td><td ${TD}>${f1(x.mtd)}</td><td ${TD}>${x.remain != null && x.remain < 0 ? '초과' : f1(x.remain)}</td>`
      + `<td ${TD}><b>${f1(x.needWeekly)}</b>${x.kegNeedWeekly != null ? '<div style="font-size:10px;color:#9ca3af;">' + f0(x.kegNeedWeekly) + ' keg</div>' : ''}</td><td ${TD}>${f1(x.recentWeekly)}</td>`
      + `<td ${TD}>${pill(x.sigMultiple, mult(x.multiple))}</td><td ${TD}>${pct(x.share)}</td></tr>`).join('');
    return H('B. 핵심 SKU 필요수량 (HL)')
      + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${THL}>SKU</th><th ${TH}>월 FCST</th><th ${TH}>MTD</th><th ${TH}>잔여</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>필요 배수</th><th ${TH}>필요 비중</th></tr>${rows}</table></div>`
      + (b.key === 'alsm' ? NOTE('ALSM SKU 최근 주당 = MTD 런레이트 (SKU별 일자 실적 없음)') : NOTE('필요 비중 = 지점 전체 잔여 필요량 중 이 SKU 몫'));
  }
  function blockC(b) {
    const C = b.C, items = [];
    if (C.change != null) items.push(`전주 대비 <b style="color:${C.change >= 0 ? '#15803d' : '#b91c1c'};">${sgn(C.change)} HL</b>${C.changePct != null ? ' (' + (C.changePct >= 0 ? '+' : '') + (C.changePct * 100).toFixed(1) + '%)' : ''} · 지난주 ${f1(C.lastWeek)} → 이번 주 ${f1(C.thisWeek)}`);
    else items.push('전주 대비 비교 없음 (이번 달 첫 제출)');
    if (C.topSku && C.topSku.length) items.push('변경 큰 SKU: ' + C.topSku.map(t => `${esc(t.sku)} <b style="color:${t.d >= 0 ? '#15803d' : '#b91c1c'};">${sgn(t.d)}</b>`).join(' · '));
    if (C.down && C.down.series && C.down.series.length) items.push('주차별 제출: ' + C.down.series.map(s => `W${s.w} ${f1(s.hl)}`).join(' → ') + (C.down.flag ? ' — <b style="color:#b91c1c;">2주 연속 하향</b>' : ''));
    if (C.crowd) items.push(`월말 몰림: 남은 필요 ${f1(b.A.need)} ÷ 발주패턴상 남은 기대 ${f1(C.crowd.expRemain)} = <b style="color:${C.crowd.flag ? '#b91c1c' : '#374151'};">${mult(C.crowd.ratio)}</b> (월 FCST의 ${pct(C.crowd.remainShare)}가 남음)`);
    return H('C. FCST 요약') + '<ul style="margin:2px 0 8px 18px;padding:0;font-size:12px;line-height:1.75;">' + items.map(t => `<li>${t}</li>`).join('') + '</ul>'
      + NOTE('상세 표·추이는 Weekly › FCST Status 탭');
  }
  function blockE(b) {
    if (!b.E || !b.E.length) return H('E. 미팅 질문') + '<div style="font-size:12px;color:#15803d;">규칙에 걸린 항목 없음</div>';
    return H('E. 미팅 질문') + '<ol style="margin:2px 0 6px 18px;padding:0;font-size:12.5px;line-height:1.8;">' + b.E.map(q => `<li>${esc(q)}</li>`).join('') + '</ol>';
  }
  function footer(R) {
    const d = new Date(R.generatedAt);
    return `<div style="margin-top:10px;padding-top:6px;border-top:1px dashed #e5e7eb;font-size:10.5px;color:#9ca3af;">자동 생성 ${d.toLocaleString('ko-KR')} · DSR ~${esc(R.dsrAsOf || '-')} · 영업일 ${R.wd.elapsed}/${R.wd.total} · ${esc(R.week.label || '')}</div>`;
  }
  function branchHtml(R, b) {
    b._wdPct = R.wd.pct;
    const reg = (b.regions && b.regions.length)
      ? H('권역 실적 (FCST는 ALSM 합계로만 관리)') + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${THL}>권역</th><th ${TH}>MTD</th><th ${TH}>YTD(마감월)</th><th ${TH}>YoY</th></tr>`
        + b.regions.map(r => `<tr><td ${TDL}>${esc(r.key)}</td><td ${TD}>${f1(r.mtd)}</td><td ${TD}>${f0(r.ytd)}</td><td ${TD}>${r.ytdLy > 0 ? sgn((r.ytd / r.ytdLy - 1) * 100) + '%' : '—'}</td></tr>`).join('') + '</table></div>'
      : '';
    return headLine(b) + blockA(b) + blockB(b) + reg + blockC(b) + blockE(b) + footer(R);
  }
  function ttlHtml(R) {
    const t = R.ttl; t._wdPct = R.wd.pct;
    const all = [...R.branches, R.alsm].filter(Boolean);
    const rows = all.map(b => `<tr><td ${TDL}><b>${esc(b.label)}</b></td><td ${TD}>${f1(b.A.fcst)}</td><td ${TD}>${f1(b.A.mtd)}</td>`
      + `<td ${TD}>${pill(b.A.sigProgress, pct(b.A.progress))}</td><td ${TD}>${pill(b.A.sigMultiple, mult(b.A.multiple))}</td>`
      + `<td ${TD}>${b.C.crowd ? (b.C.crowd.flag ? pill(SIG.bad, mult(b.C.crowd.ratio)) : mult(b.C.crowd.ratio)) : '—'}</td>`
      + `<td ${TD}>${b.C.down && b.C.down.flag ? pill(SIG.bad, '예') : '—'}</td><td ${TD}>${sgn(b.C.change)}</td><td ${TD}>${b.E.length}</td></tr>`).join('');
    return headLine(t) + blockA(t)
      + H('지점별 신호 (HL)') + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${THL}>지점</th><th ${TH}>월 FCST</th><th ${TH}>MTD</th><th ${TH}>진척</th><th ${TH}>필요 배수</th><th ${TH}>월말 몰림</th><th ${TH}>2주 연속 하향</th><th ${TH}>전주 대비</th><th ${TH}>질문</th></tr>${rows}</table></div>`
      + NOTE('ALSM은 별도 채널 — On TTL에 합산하지 않음') + blockC(t) + footer(R);
  }
  // ── 월 전환 주 카드 ──
  function closeBlock(T, cl) {
    const pm = T.prev.month;
    return H(`① ${pm}월 마감 (HL)`)
      + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${TH}>월 FCST</th><th ${TH}>실적</th><th ${TH}>남은 영업일</th><th ${TH}>남은 필요</th><th ${TH}>일당 필요</th><th ${TH}>예상 마감</th><th ${TH}>FCST 대비</th><th ${TH}>RoFo 대비</th>${cl.accuracy != null ? `<th ${TH}>FCST 정확도</th>` : ''}</tr>`
      + `<tr><td ${TD}>${f1(cl.fcst)}${cl.fcstSrc ? '<div style="font-size:10px;color:#9ca3af;">' + esc(cl.fcstSrc) + '</div>' : ''}</td><td ${TD}>${f1(cl.actual)}</td><td ${TD}>${cl.remainWd}일</td>`
      + `<td ${TD}>${f1(cl.need)}</td><td ${TD}>${f1(cl.needDaily)}</td><td ${TD}><b>${f1(cl.expClose)}</b></td>`
      + `<td ${TD}>${pill(cl.sig, pct(cl.vsFcst))}</td><td ${TD}>${pct(cl.vsRofo)}</td>${cl.accuracy != null ? `<td ${TD}>${pct(cl.accuracy)}</td>` : ''}</tr></table></div>`
      + NOTE(`예상 마감 = 실적 + 최근 2주 일평균 × 남은 영업일 · 신호: FCST의 ${pct(RULE.closeOk)}↑ 유효 / ${pct(RULE.closeWarn)}↑ 주의`);
  }
  function startBlock(T, st) {
    const nm = T.next.month;
    return H(`② ${nm}월 시작 (HL)`)
      + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${TH}>월 FCST</th><th ${TH}>RoFo</th><th ${TH}>FCST÷RoFo</th><th ${TH}>전년 ${nm}월</th><th ${TH}>전년 대비</th><th ${TH}>영업일</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>필요 배수</th></tr>`
      + `<tr><td ${TD}>${st.fcst != null ? f1(st.fcst) + (st.fcstSrc ? '<div style="font-size:10px;color:#9ca3af;">' + esc(st.fcstSrc) + '</div>' : '') : '<span style="color:#b91c1c;">미제출</span>'}</td>`
      + `<td ${TD}>${f1(st.rofo)}</td><td ${TD}>${st.gapRofo != null ? pill(st.gapRofo < RULE.gapWarn ? SIG.bad : st.gapRofo < 0 ? SIG.warn : SIG.ok, pct(1 + st.gapRofo)) : '—'}</td>`
      + `<td ${TD}>${f1(st.ly)}</td><td ${TD}>${st.vsLy != null ? sgn(st.vsLy * 100) + '%' : '—'}</td><td ${TD}>${st.totalWd}일</td>`
      + `<td ${TD}><b>${f1(st.needWeekly)}</b></td><td ${TD}>${f1(st.recentWeekly)}</td><td ${TD}>${pill(st.sigMultiple, mult(st.multiple))}</td></tr></table></div>`
      + NOTE(`주당 필요 = ${st.basis === 'RoFo' ? '<b>RoFo</b>(FCST 미제출)' : '월 FCST'} ÷ ${nm}월 영업일 × 5 · 최근 주당 = ${T.prev.month}월 최근 2주 실적`);
  }
  function startSkuBlock(T, t) {
    if (!t.B || !t.B.length) return '';
    const rows = t.B.map(x => `<tr><td ${TDL}>${esc(x.label)}</td><td ${TD}>${f1(x.fcst)}${x.kegFcst != null ? '<div style="font-size:10px;color:#9ca3af;">' + f0(x.kegFcst) + ' keg</div>' : ''}</td>`
      + `<td ${TD}><b>${f1(x.needWeekly)}</b>${x.kegNeedWeekly != null ? '<div style="font-size:10px;color:#9ca3af;">' + f0(x.kegNeedWeekly) + ' keg</div>' : ''}</td><td ${TD}>${f1(x.recentWeekly)}</td><td ${TD}>${pill(x.sigMultiple, mult(x.multiple))}</td><td ${TD}>${pct(x.share)}</td></tr>`).join('');
    return H(`${T.next.month}월 핵심 SKU (HL)`) + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${THL}>SKU</th><th ${TH}>월 FCST</th><th ${TH}>주당 필요</th><th ${TH}>최근 주당</th><th ${TH}>필요 배수</th><th ${TH}>FCST 비중</th></tr>${rows}</table></div>`;
  }
  function transitionHead(T, t) {
    return `<div style="font-size:12px;color:#6b7280;margin-bottom:4px;">월 전환 주 — <b style="color:#205527;">${T.prev.month}월 마감</b> · <b style="color:#205527;">${T.next.month}월 시작</b></div>`
      + `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12.5px;margin-bottom:4px;">`
      + `<span>${T.prev.month}월 예상 마감 ${pill(t.close.sig, pct(t.close.vsFcst))}</span>`
      + `<span>${T.next.month}월 필요 배수 ${pill(t.start.sigMultiple, mult(t.start.multiple))}</span>`
      + (t.start.fcst == null ? `<span>${pill(SIG.warn, T.next.month + '월 FCST 미제출')}</span>` : '')
      + `</div>`;
  }
  function branchTransitionHtml(R, t, b) {
    const T = R.transition;
    return transitionHead(T, t) + closeBlock(T, t.close) + startBlock(T, t.start) + startSkuBlock(T, t)
      + (b && b.C ? blockC(b).replace('C. FCST 요약', `C. FCST 요약 (데이터 월 ${R.week.month}월)`) : '') + blockE(t) + footer(R);
  }
  function ttlTransitionHtml(R) {
    const T = R.transition, t = T.ttl;
    const all = [...T.branches, T.alsm].filter(Boolean);
    const rows = all.map(x => `<tr><td ${TDL}><b>${esc(x.label)}</b></td><td ${TD}>${f1(x.close.expClose)}</td><td ${TD}>${pill(x.close.sig, pct(x.close.vsFcst))}</td>`
      + `<td ${TD}>${x.start.fcst != null ? f1(x.start.fcst) : '<span style="color:#b91c1c;">미제출</span>'}</td><td ${TD}>${x.start.gapRofo != null ? pct(1 + x.start.gapRofo) : '—'}</td>`
      + `<td ${TD}>${pill(x.start.sigMultiple, mult(x.start.multiple))}</td><td ${TD}>${x.E.length}</td></tr>`).join('');
    return transitionHead(T, t) + closeBlock(T, t.close) + startBlock(T, t.start)
      + H('지점별 (HL)') + `<div style="overflow-x:auto;"><table ${TBL}><tr><th ${THL}>지점</th><th ${TH}>${T.prev.month}월 예상 마감</th><th ${TH}>FCST 대비</th><th ${TH}>${T.next.month}월 FCST</th><th ${TH}>FCST÷RoFo</th><th ${TH}>${T.next.month}월 필요 배수</th><th ${TH}>질문</th></tr>${rows}</table></div>`
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

  global.BranchWeekly = { compute, cards, BRANCHES, CORE, SKU, RULE, _internal: { needOf, recentWeekly, downStreak, crowdOf, sigProgress, sigMultiple } };
})(typeof window !== 'undefined' ? window : this);
