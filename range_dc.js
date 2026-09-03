// ═══════════════════════════════════════════════════════════════════
//  range_dc.js — On-Trade WS Range DC 탭 모듈
//  · window.RangeDC 로 노출. XLSX(SheetJS)·RANGE_MASTER(range_master.js) 전역 필요.
//  · 입력: DSR raw(Team/Code/Date/Volume in Case) → Team=On 전 행(ALSM "포함" — Range는 도매장
//    구매물량 기준, 사용자 확정 2026-09-03)을 코드×월 케이스로 합산.
//    단위 = 환산 케이스(Volume in Case) — Range guideline·FCST와 동일 단위.
//  · 저장: Supabase `on_range_dc`
//      id 'm:YYYY-MM' → { ym, codes:{code:[cs,hl]}, meta:{maxDay,nDays,rows} } (월별 실적, upsert)
//      id 'q:YYYYQn'  → { fcst:{code:cs}, dec:{code:{r,memo}}, updated_at }   (분기 마감 FCST 입력·차기 Range 결정)
//    부분월 보호: 이미 저장된 월보다 maxDay가 작은 파일은 그 월을 덮어쓰지 않음(freight와 동일 규칙).
//  · 파생코드(서브코드): RANGE_MASTER.subs 로 대표코드에 합산. member_of 행은 표시만 하고 평가는 부모에서.
//  · 판정 규칙(원본 엑셀 guide 컬럼 역산으로 확인): 마감 분기 FCST를 guideline의 "그 분기 컬럼"에
//    대입해 자격 레벨 산출 → 차기 분기 Range 제안. 연간 뷰는 YTD vs 연간 임계값.
// ═══════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const M = () => global.RANGE_MASTER;
  const TABLE = 'on_range_dc';
  const YEAR = (global.RANGE_MASTER && global.RANGE_MASTER.year) || 2026;
  const Q_MONTHS = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
  const BRANCH_COL = ['Seoul','Busan','Daejeon','Gwangju','Daegu','Jeju'];   // Summary 매트릭스 열 순서
  const BR_SHORT = { Seoul:'SU', Busan:'BS', Daejeon:'DJ', Gwangju:'GJ', Daegu:'DG', Jeju:'JJ' };
  const DAYS_IN_MON = m => new Date(Date.UTC(YEAR, m, 0)).getUTCDate();     // m: 1-12

  const fmt  = n => (n == null || isNaN(n)) ? '-' : Math.round(n).toLocaleString('ko-KR');
  const fpct = v => (v == null || isNaN(v)) ? '-' : Math.round(v * 100) + '%';
  const esc  = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // ── 자격 레벨 판정 ──
  function qualifyQ(vol, qi) {           // 분기 FCST/실적 → 레벨 (qi: 0-3)
    if (vol == null || isNaN(vol)) return null;
    for (const g of M().guideline) if (vol >= g.q[qi]) return g.r;
    return 0;
  }
  function qualifyY(vol) {
    if (vol == null || isNaN(vol)) return null;
    for (const g of M().guideline) if (vol >= g.yr) return g.r;
    return 0;
  }
  function glRow(r) { return M().guideline.find(g => g.r === r) || null; }

  // ═══════════════════════════════════════════════════════════════
  //  파싱: DSR raw 워크북 → { months: {'YYYY-MM': {ym, codes, meta}}, hasCode }
  // ═══════════════════════════════════════════════════════════════
  function parseWorkbook(wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const H = (all[0] || []).map(h => h != null ? String(h).trim() : '');
    const nrm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
    const ix = (...names) => {
      const N = names.map(nrm);
      for (let i = 0; i < H.length; i++) if (N.includes(nrm(H[i]))) return i;
      for (let i = 0; i < H.length; i++) { const h = nrm(H[i]); if (N.some(n => n.length >= 4 && h.includes(n))) return i; }
      return -1;
    };
    const iCode = ix('Code', 'Customer Code', '배송처코드', '거래처코드', 'CustomerCode');
    const iDate = ix('Date'), iTeam = ix('Team', 'Customer.Team'),
          iVol  = ix('Vol', 'Volume in Case'), iHl = ix('HL', 'Volume in Hectolitre');
    if (iCode < 0) return { months: {}, hasCode: false, warnings: ['Code 컬럼 없음 — Range 실적 집계 건너뜀'] };
    if (iDate < 0 || iVol < 0) return { months: {}, hasCode: false, warnings: ['Date/Volume in Case 컬럼 없음 — Range 실적 집계 건너뜀'] };

    function normDate(v) {                 // index.html _dsrNormDate와 동일 규칙(UTC 자정 반올림)
      if (v == null) return null;
      if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000));
      let t;
      if (v instanceof Date) t = v.getTime();
      else { const d = new Date(v); if (isNaN(d)) return null; t = d.getTime(); }
      if (isNaN(t)) return null;
      return new Date(Math.round(t / 86400000) * 86400000);
    }

    const months = {};
    for (let i = 1; i < all.length; i++) {
      const r = all[i]; if (!r) continue;
      if (iTeam >= 0) { const t = r[iTeam] != null ? String(r[iTeam]).trim().toUpperCase() : ''; if (t !== 'ON') continue; }
      // ALSM 행 포함 — On 지표와 달리 Range는 도매장 구매물량 전체 기준
      const code = r[iCode] != null ? String(r[iCode]).trim() : '';
      if (!code) continue;
      const d = normDate(r[iDate]); if (!d) continue;
      const y = d.getUTCFullYear();
      if (y !== 2025 && y !== 2026) continue;
      const ym = y + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
      const cs = Number(r[iVol]) || 0, hl = iHl >= 0 ? (Number(r[iHl]) || 0) : 0;
      let rec = months[ym];
      if (!rec) rec = months[ym] = { ym, codes: {}, meta: { maxDay: 0, rows: 0, _days: new Set() } };
      const c = rec.codes[code] || (rec.codes[code] = [0, 0]);
      c[0] += cs; c[1] += hl;
      rec.meta.rows++;
      const day = d.getUTCDate();
      if (day > rec.meta.maxDay) rec.meta.maxDay = day;
      rec.meta._days.add(day);
    }
    for (const ym in months) {
      const rec = months[ym];
      rec.meta.nDays = rec.meta._days.size; delete rec.meta._days;
      for (const code in rec.codes) {
        const c = rec.codes[code];
        c[0] = Math.round(c[0] * 10) / 10; c[1] = Math.round(c[1] * 100) / 100;
        if (!c[0] && !c[1]) delete rec.codes[code];
      }
    }
    return { months, hasCode: true, warnings: [] };
  }

  // ═══════════════════════════════════════════════════════════════
  //  저장/로드 (Supabase on_range_dc)
  // ═══════════════════════════════════════════════════════════════
  async function saveMonths(sb, months) {
    const yms = Object.keys(months).sort();
    if (!yms.length) return { saved: 0, skipped: [] };
    const ids = yms.map(ym => 'm:' + ym);
    const { data: existing, error: exErr } = await sb.from(TABLE).select('id,data').in('id', ids);
    if (exErr) {
      if (/relation|schema|does not exist|Could not find/i.test(exErr.message))
        throw new Error('on_range_dc 테이블 없음 — migrations/on_range_dc.sql 을 Supabase SQL Editor에서 1회 실행 후 재시도');
      throw exErr;
    }
    const exMap = {}; (existing || []).forEach(r => { exMap[r.id] = r.data; });
    const rows = [], skipped = [];
    for (const ym of yms) {
      const ex = exMap['m:' + ym];
      // 부분월 보호 — 저장돼 있는 달보다 덜 채워진(마지막 일자가 이른) 파일은 그 월을 건드리지 않음
      if (ex && ex.meta && ex.meta.maxDay > months[ym].meta.maxDay) { skipped.push(ym); continue; }
      rows.push({ id: 'm:' + ym, data: months[ym], updated_at: new Date().toISOString() });
    }
    if (rows.length) {
      const { error } = await sb.from(TABLE).upsert(rows);
      if (error) throw error;
    }
    _cache = null;
    return { saved: rows.length, skipped };
  }

  async function ingestWorkbook(sb, wb, onlyYm) {
    if (!M()) throw new Error('range_master.js 로드 안 됨');
    const res = parseWorkbook(wb);
    if (!res.hasCode) return { skipped: true, warnings: res.warnings };
    let months = res.months;
    if (onlyYm) months = months[onlyYm] ? { [onlyYm]: months[onlyYm] } : {};
    const yms = Object.keys(months).sort();
    if (!yms.length) return { skipped: true, warnings: res.warnings.concat(['저장할 월 없음']) };
    const sv = await saveMonths(sb, months);
    return { skipped: false, months: yms, saved: sv.saved, protectedSkip: sv.skipped, warnings: res.warnings };
  }

  let _cache = null;                       // { months: {ym: rec}, quarters: {'2026Q3': data} }
  function invalidate() { _cache = null; }
  async function loadAll(sb) {
    if (_cache) return _cache;
    const { data, error } = await sb.from(TABLE).select('id,data');
    if (error) throw error;
    const months = {}, quarters = {};
    let srmap = {};
    (data || []).forEach(r => {
      if (r.id.startsWith('m:')) months[r.id.slice(2)] = r.data;
      else if (r.id.startsWith('q:')) quarters[r.id.slice(2)] = r.data || {};
      else if (r.id === '_srmap') srmap = (r.data && r.data.byCode) || {};
    });
    _cache = { months, quarters, srmap };
    return _cache;
  }

  // ── 분기 입력(q:) 저장 — 디바운스 ──
  let _qDirty = {}, _qTimer = null, _sb = null;
  function markQDirty(qkey) {
    _qDirty[qkey] = true;
    setSaveChip('저장 대기…', 'var(--text-muted)');
    clearTimeout(_qTimer);
    _qTimer = setTimeout(flushQ, 900);
  }
  async function flushQ() {
    if (!_sb || !_cache) return;
    const keys = Object.keys(_qDirty); _qDirty = {};
    if (!keys.length) return;
    try {
      setSaveChip('저장 중…', 'var(--text-muted)');
      const rows = keys.map(k => ({ id: 'q:' + k, data: Object.assign({}, _cache.quarters[k], { updated_at: new Date().toISOString() }), updated_at: new Date().toISOString() }));
      const { error } = await _sb.from(TABLE).upsert(rows);
      if (error) throw error;
      setSaveChip('✓ 저장됨', 'var(--positive)');
    } catch (e) {
      console.error('Range 분기 입력 저장 실패:', e);
      keys.forEach(k => _qDirty[k] = true);          // 실패분 재시도 대상 유지
      setSaveChip('⚠ 저장 실패 — 입력 시 재시도', 'var(--negative)');
    }
  }
  function setSaveChip(txt, color) {
    const el = document.getElementById('range-save-chip');
    if (el) { el.textContent = txt; el.style.color = color; }
  }

  // ═══════════════════════════════════════════════════════════════
  //  집계 헬퍼
  // ═══════════════════════════════════════════════════════════════
  function groupCodesOf(code) { return [code].concat((M().subs && M().subs[code]) || []); }

  // 코드 집합의 월별 케이스 (mons: [1..12] 배열) → { act, byMon:{m:cs} }
  function sumActual(monthsData, codes, mons) {
    let act = 0; const byMon = {};
    for (const m of mons) {
      const ym = YEAR + '-' + String(m).padStart(2, '0');
      const rec = monthsData[ym]; if (!rec) continue;
      let v = 0;
      for (const c of codes) { const e = rec.codes[c]; if (e) v += e[0]; }
      byMon[m] = Math.round(v * 10) / 10;
      act += v;
    }
    return { act: Math.round(act * 10) / 10, byMon };
  }

  // 분기/연간 경과율 — 데이터가 있는 마지막 일자 기준
  function elapsedFrac(monthsData, mons) {
    let lastM = 0, lastD = 0;
    for (const m of mons) {
      const rec = monthsData[YEAR + '-' + String(m).padStart(2, '0')];
      if (rec && rec.meta && rec.meta.maxDay) { lastM = m; lastD = rec.meta.maxDay; }
    }
    if (!lastM) return null;
    let total = 0, done = 0;
    for (const m of mons) {
      const dm = DAYS_IN_MON(m); total += dm;
      if (m < lastM) done += dm; else if (m === lastM) done += Math.min(lastD, dm);
    }
    return total ? Math.min(done / total, 1) : null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  렌더
  // ═══════════════════════════════════════════════════════════════
  let _view = null;                        // 0-3 = 분기, 'Y' = 연간
  let _teamFilter = '전체';
  let _srFilter = '전체';                  // 담당(SR) 필터
  let _srEdit = false, _srPending = {};    // SR 이름 편집 모드 · 저장 전 변경분(code→name)
  const _expanded = new Set();             // 파생코드 내역이 펼쳐진 대표코드

  function defaultView(monthsData) {
    // 데이터가 있는 최신 2026 월의 분기, 없으면 오늘 날짜 분기
    const yms = Object.keys(monthsData).filter(k => k.startsWith(String(YEAR))).sort();
    const m = yms.length ? parseInt(yms[yms.length - 1].slice(5)) : (new Date().getMonth() + 1);
    return Math.floor((m - 1) / 3);
  }

  async function render(sb) {
    _sb = sb;
    const root = document.getElementById('range-root');
    if (!root) return;
    if (!M()) { root.innerHTML = '<div class="chart-card" style="padding:24px;color:var(--negative);font-size:13px;">range_master.js 로드 안 됨</div>'; return; }
    root.innerHTML = '<div class="chart-card" style="padding:24px;color:var(--text-muted);font-size:13px;">Range DC 데이터 로드 중…</div>';
    let cache;
    try { cache = await loadAll(sb); }
    catch (e) {
      const missing = /relation|schema|does not exist|Could not find/i.test(e.message || '');
      root.innerHTML = `<div class="chart-card" style="padding:24px;color:var(--negative);font-size:13px;">Range DC 데이터 로드 실패: ${esc(e.message)}${missing ? '<br><span style="color:var(--text-muted)">→ <code>migrations/on_range_dc.sql</code> 을 Supabase SQL Editor에서 1회 실행하세요.</span>' : ''}</div>`;
      return;
    }
    if (_view == null) _view = defaultView(cache.months);
    draw(root, cache);
  }

  function rerender() {
    if (!_cache) return;
    const root = document.getElementById('range-root');
    if (root) draw(root, _cache);
  }

  function draw(root, cache) {
    const isYear = _view === 'Y';
    const qi = isYear ? 3 : _view;
    // 연간 뷰 입력(연간 FCST·결정)은 분기 행과 분리된 'q:2026Y' 행에 저장 — Q4 입력과 충돌 방지
    const qkey = isYear ? (YEAR + 'Y') : (YEAR + 'Q' + (qi + 1));
    const qdata = cache.quarters[qkey] || (cache.quarters[qkey] = { fcst: {}, dec: {} });
    qdata.fcst = qdata.fcst || {}; qdata.dec = qdata.dec || {};
    const mons = isYear ? [1,2,3,4,5,6,7,8,9,10,11,12] : Q_MONTHS[qi];
    const bench = elapsedFrac(cache.months, mons);
    const nextQ = isYear ? null : (qi + 1 < 4 ? (qi + 2) + 'Q' : '차년 1Q');

    // ── 엔티티 평가 ──
    const evals = [];                                     // 평가 대상(대표코드)
    const evalByCode = {};
    for (const e of M().entities) {
      const [no, team, sr, code, name, qtd2q, fcst2q, asis, guide, tobe, remark] = e;
      const member = M().member_of[code] || null;
      const row = { no, team, sr, code, name, qtd2q, fcst2q, asis, guide, tobe, remark, member,
                    subs: (M().subs && M().subs[code]) || [] };
      if (!member) {
        const a = sumActual(cache.months, groupCodesOf(code), mons);
        row.act = a.act; row.byMon = a.byMon;
        row.fcst = qdata.fcst[code] != null ? qdata.fcst[code] : null;
        row.qual = isYear ? qualifyY(row.fcst) : qualifyQ(row.fcst, qi);   // 마감 FCST 자격 레벨(마감 분기 컬럼)
        const dec = qdata.dec[code] || {};
        row.decR = (dec.r != null) ? dec.r : null;        // null = 자동(제안 따름)
        row.next = row.decR != null ? row.decR : row.qual;
        row.memo = dec.memo || '';
        evalByCode[code] = row;
      }
      evals.push(row);
    }
    // member 행에 부모 참조 연결
    evals.forEach(r => { if (r.member) r.parentRow = evalByCode[r.member] || null; });

    // ── 4Q(차기) 적용안 — 보고 있는 뷰와 무관하게 base_quarter(3Q) 마감 입력으로 산출 ──
    const bq = M().base_quarter || (YEAR + 'Q3');
    const bqi = parseInt(bq.slice(-1), 10) - 1;
    const bqd = cache.quarters[bq] || {};
    const bqFcst = bqd.fcst || {}, bqDec = bqd.dec || {};
    const next4 = {};
    evals.forEach(r => {
      if (r.member) return;
      const d = bqDec[r.code] || {};
      next4[r.code] = d.r != null ? d.r : qualifyQ(bqFcst[r.code] != null ? bqFcst[r.code] : null, bqi);
    });
    evals.forEach(r => { if (r.member) next4[r.code] = next4[r.member] != null ? next4[r.member] : null; });

    // ── 뷰 분기의 '적용 Range' 체인: 1Q=미상 · 2Q=AS-IS · 3Q=TO-BE · 4Q=3Q 마감 결정(next4) · 연간=TO-BE ──
    //    토글로 4Q에 들어가면 기준·달성률이 4Q 적용 Range로 잡히고, 마감 FCST(4Q 컬럼)로 차년 1Q를 결정해 q:YYYYQ4에 저장.
    evals.forEach(r => {
      r.applied = isYear ? r.tobe
        : qi === 0 ? null
        : qi === 1 ? r.asis
        : qi === 2 ? r.tobe
        : next4[r.code];                                   // 4Q — 3Q 마감 미결정이면 null(기준 '-')
      if (!r.member) {
        const g = glRow(r.applied);
        r.thr = g ? (isYear ? g.yr : g.q[qi]) : null;
        r.ach = (r.thr && r.act != null) ? r.act / r.thr : null;
      }
    });

    // ── KPI ──
    const active = evals.filter(r => r.tobe > 0);
    const activeLQ = evals.filter(r => r.asis > 0);
    const nextKnown = evals.map(r => next4[r.code]).filter(v => v != null);
    const nextActive = nextKnown.filter(v => v > 0).length;
    const excluded3q = evals.filter(r => r.asis > 0 && r.tobe === 0).length;
    const downgraded = evals.filter(r => !r.member && r.tobe > 0 && r.asis > 0 && r.tobe < r.asis).length;
    const fcstFilled = evals.filter(r => !r.member && r.fcst != null).length;
    const fcstTotal  = evals.filter(r => !r.member).length;

    // ── 매트릭스 (레벨 × 지점): 분기별 적용 Range — 1Q(현재 데이터 없음)~4Q ──
    const LEVELS = M().guideline.map(g => g.r);           // 12..3
    function matrixOf(getter) {
      const mx = {}; LEVELS.forEach(l => { mx[l] = {}; BRANCH_COL.forEach(b => mx[l][b] = 0); });
      const tot = {}; BRANCH_COL.forEach(b => tot[b] = 0);
      evals.forEach(r => {
        const v = getter(r);
        if (v == null || v <= 0) return;
        if (mx[v] && mx[v][r.team] != null) { mx[v][r.team]++; tot[r.team]++; }
      });
      return { mx, tot };
    }
    const hasNext = nextKnown.length > 0;
    // 분기 스트립: [1Q, 2Q(AS-IS), 3Q(TO-BE), 4Q(마감 결정)] — null = 데이터 없음(자리 표시)
    const mQ = [null, matrixOf(r => r.asis), matrixOf(r => r.tobe), hasNext ? matrixOf(r => next4[r.code]) : null];

    // ── 헤더/토글 ──
    const viewBtns = ['1Q','2Q','3Q','4Q'].map((l, i) =>
      `<button class="subtab-btn${!isYear && _view === i ? ' active' : ''}" onclick="RangeDC._setView(${i})">${l}</button>`).join('')
      + `<button class="subtab-btn${isYear ? ' active' : ''}" onclick="RangeDC._setView('Y')">연간</button>`;
    const teams = ['전체'].concat([...new Set(M().entities.map(e => e[1]))]);
    const teamBtns = teams.map(t =>
      `<button class="subtab-btn${_teamFilter === t ? ' active' : ''}" onclick="RangeDC._setTeam('${t}')">${t}</button>`).join('');
    // 담당(SR) — 편집 저장분(_srmap) > 마스터 원본. 필터 목록은 현재 지점 필터 기준으로 구성.
    const srDisp = (code, orig) => (_srPending[code] != null ? _srPending[code] : (cache.srmap && cache.srmap[code]) || orig);
    const srSet = [...new Set(evals.filter(r => _teamFilter === '전체' || r.team === _teamFilter).map(r => srDisp(r.code, r.sr)).filter(Boolean))];
    if (_srFilter !== '전체' && !srSet.includes(_srFilter)) _srFilter = '전체';
    const srBtns = ['전체'].concat(srSet).map(s =>
      `<button class="subtab-btn${_srFilter === s ? ' active' : ''}" style="padding:3px 10px;font-size:11px;" onclick="RangeDC._setSr('${esc(s)}')">${esc(s)}</button>`).join('');
    const srEditBtns = `<button class="subtab-btn" style="padding:3px 10px;font-size:11px;${_srEdit ? 'background:var(--neutral);border-color:var(--neutral);color:#fff;' : ''}" onclick="RangeDC._toggleSrEdit()">${_srEdit ? '✕ 편집 취소' : '✏️ SR 편집'}</button>`
      + (_srEdit ? `<button class="subtab-btn" style="padding:3px 10px;font-size:11px;background:var(--primary);color:#fff;" onclick="RangeDC._saveSr()">💾 SR 저장</button>` : '');
    const loadedYms = Object.keys(cache.months).sort();
    const scopeYms = mons.map(m => YEAR + '-' + String(m).padStart(2, '0')).filter(ym => cache.months[ym]);
    const metaTxt = loadedYms.length
      ? `실적 적재: ${loadedYms[0]} ~ ${loadedYms[loadedYms.length-1]} (${loadedYms.length}개월)`
        + ` · 이번 구간 반영: ${scopeYms.length ? scopeYms.map(m => m.slice(5)).join('·') + '월' : '없음'}`
        + (bench != null ? ` · 구간 경과 <b>${Math.round(bench*100)}%</b>` : '')
      : '실적 데이터 없음 — Data Update의 운송비/Range DSR 백필 또는 통합 DSR 업로드로 적재하세요';

    // ── 표 ──
    const filt = evals.filter(r => (_teamFilter === '전체' || r.team === _teamFilter)
                                && (_srFilter === '전체' || srDisp(r.code, r.sr) === _srFilter));
    const srCell = r => _srEdit
      ? `<td><input type="text" value="${esc(srDisp(r.code, r.sr))}" style="width:58px;padding:2px 4px;border:1px solid var(--neutral);border-radius:5px;font-size:11px;text-align:center;" onchange="RangeDC._onSrEdit('${r.code}',this.value)"></td>`
      : `<td>${esc(srDisp(r.code, r.sr))}</td>`;
    const achCell = r => {
      if (r.thr == null) return '<td style="color:var(--text-muted)">-</td>';
      const cls = r.ach == null ? '' : bench == null ? '' : r.ach >= bench ? 'var(--positive)' : r.ach >= bench - 0.10 ? 'var(--neutral)' : 'var(--negative)';
      return `<td style="font-weight:700;${cls ? 'color:' + cls + ';' : ''}">${fpct(r.ach)}</td>`;
    };
    const rangeChip = v => v == null ? '<span style="color:var(--text-muted)">-</span>'
      : v === 0 ? '<span style="color:var(--negative);font-weight:700;">제외</span>'
      : `<span style="font-weight:700;">R${v}</span> <span style="color:var(--text-muted);font-size:11px;">${v}%</span>`;
    const diffChip = (a, b) => (a == null || b == null) ? ''
      : a === b ? '<span style="color:var(--text-muted);font-size:11px;">유지</span>'
      : a > b ? `<span style="color:var(--positive);font-size:11px;">▲${a - b}</span>`
              : `<span style="color:var(--negative);font-size:11px;">▼${b - a}</span>`;

    const decOptions = r => {
      const opts = [`<option value=""${r.decR == null ? ' selected' : ''}>자동${r.qual != null ? ' (R' + r.qual + ')' : ''}</option>`];
      for (const l of LEVELS) opts.push(`<option value="${l}"${r.decR === l ? ' selected' : ''}>R${l}</option>`);
      opts.push(`<option value="0"${r.decR === 0 ? ' selected' : ''}>제외</option>`);
      return opts.join('');
    };

    // 분기 뷰에서는 구간 3개월을 각각 컬럼으로 표시 (연간 뷰는 QTD 툴팁으로 갈음)
    const monCols = isYear ? [] : mons;
    const nCols = 13 + monCols.length;
    const monTds = bm => monCols.map(m => `<td style="color:var(--text-muted);">${(bm && bm[m] != null) ? fmt(bm[m]) : '-'}</td>`).join('');
    let lastTeam = null;
    const trs = filt.map(r => {
      const teamHdr = r.team !== lastTeam
        ? `<tr><td colspan="${nCols}" style="background:rgba(32,85,39,.06);font-weight:700;padding:6px 10px;">${esc(r.team)}</td></tr>` : '';
      lastTeam = r.team;
      const isOpen = _expanded.has(r.code);
      const subBadge = r.subs.length
        ? ` <span onclick="event.stopPropagation();RangeDC._toggleSub('${r.code}')" title="클릭: 파생코드별 실적 내역 ${isOpen ? '접기' : '펼치기'}&#10;${esc(r.subs.map(c => c + ' ' + (M().sub_names[c] || '')).join('\n'))}" style="background:rgba(32,85,39,${isOpen ? '.25' : '.12'});border-radius:8px;padding:0 6px;font-size:10px;cursor:pointer;user-select:none;">${isOpen ? '▾' : '▸'}+${r.subs.length}</span>` : '';
      if (r.member) {
        const p = r.parentRow;
        return teamHdr + `<tr style="color:var(--text-muted);background:rgba(0,0,0,.015);">
          <td>${r.no}</td>${srCell(r)}<td>${r.code}</td>
          <td style="text-align:left;">${esc(r.name)}</td>
          <td>${rangeChip(r.applied)}</td>
          <td colspan="${7 + monCols.length}" style="text-align:left;font-size:11px;">↳ <b>${r.member}</b> ${esc(p ? p.name : '')} 에 합산 평가${p && p.next != null ? ` · 차기 ${p.next === 0 ? '제외' : 'R' + p.next} 연동` : ''}</td>
          <td style="text-align:left;font-size:11px;">${esc(r.remark)}</td></tr>`;
      }
      // 펼침 시: 대표코드(본체) + 파생코드별 이번 구간 실적 분해 행
      let subDetail = '';
      if (isOpen && r.subs.length) {
        const parts = groupCodesOf(r.code).map(c => {
          const a = sumActual(cache.months, [c], mons);
          return { c, name: c === r.code ? '(본체)' : (M().sub_names[c] || ''), act: a.act, byMon: a.byMon };
        });
        subDetail = parts.map(p => `<tr style="background:rgba(32,85,39,.035);color:var(--text-muted);font-size:11px;">
          <td></td><td></td><td>${p.c}</td>
          <td style="text-align:left;padding-left:18px;">↳ ${esc(p.name)}</td>
          <td></td><td></td>
          ${monTds(p.byMon)}
          <td title="${esc(Object.entries(p.byMon || {}).map(([m, v]) => m + '월 ' + fmt(v)).join(' · '))}" style="font-weight:600;">${fmt(p.act)}</td>
          <td>${r.act > 0 ? Math.round(p.act / r.act * 100) + '%' : '-'}</td>
          <td colspan="5"></td></tr>`).join('');
      }
      const fcstVal = r.fcst != null ? r.fcst : '';
      return teamHdr + `<tr>
        <td>${r.no}</td>${srCell(r)}<td>${r.code}</td>
        <td style="text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="${esc(r.name)}">${esc(r.name)}${subBadge}</td>
        <td>${rangeChip(r.applied)}</td>
        <td style="color:var(--text-muted)">${fmt(r.thr)}</td>
        ${monTds(r.byMon)}
        <td title="${esc(Object.entries(r.byMon || {}).map(([m, v]) => m + '월 ' + fmt(v)).join(' · '))}" style="font-weight:600;">${fmt(r.act)}</td>
        ${achCell(r)}
        <td><input type="number" inputmode="decimal" class="range-fcst-in" value="${fcstVal}" placeholder="-"
              style="width:76px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;text-align:right;"
              onchange="RangeDC._onFcst('${qkey}','${r.code}',this.value)"></td>
        <td>${r.qual == null ? '<span style="color:var(--text-muted)">-</span>' : rangeChip(r.qual)}</td>
        <td style="white-space:nowrap;">
          <select style="padding:3px 4px;border:1px solid var(--border);border-radius:6px;font-size:12px;"
              onchange="RangeDC._onDec('${qkey}','${r.code}',this.value)">${decOptions(r)}</select>
          ${diffChip(r.next, r.applied != null ? r.applied : r.tobe)}
        </td>
        <td><input type="text" class="range-memo-in" value="${esc(r.memo)}" placeholder="메모"
              style="width:110px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;font-size:11px;"
              onchange="RangeDC._onMemo('${qkey}','${r.code}',this.value)"></td>
        <td style="text-align:left;font-size:11px;color:var(--text-muted);max-width:220px;">${esc(r.remark)}</td>
      </tr>` + subDetail;
    }).join('');

    const thrLabel = isYear ? '연간 기준' : (qi + 1) + 'Q 기준';
    const actLabel = isYear ? 'YTD 실적' : (qi + 1) + 'Q 실적';
    const fcstLabel = isYear ? '연간 FCST' : (qi + 1) + 'Q 마감 FCST';
    const nextLabel = nextQ ? nextQ + ' 결정' : '차기 결정';

    // ── 매트릭스 HTML — prev(전분기)가 있으면 레벨별 등차(Δ)열 + vs.LQ 행 표시 ──
    function matrixHtml(title, M1, prev, hi) {
      const dfmt = d => d === 0 ? '<span style="color:var(--text-muted)">·</span>'
        : d > 0 ? `<span style="color:var(--positive)">+${d}</span>` : `<span style="color:var(--negative)">${d}</span>`;
      const lvlSum = (mm, l) => BRANCH_COL.reduce((a, b) => a + mm.mx[l][b], 0);
      const rows = LEVELS.map(l => {
        const cells = BRANCH_COL.map(b => `<td${M1.mx[l][b] ? '' : ' style="color:var(--text-muted)"'}>${M1.mx[l][b] || '·'}</td>`).join('');
        const sum = lvlSum(M1, l);
        const dCell = prev ? `<td style="font-size:10px;">${dfmt(sum - lvlSum(prev, l))}</td>` : '';
        return `<tr><td style="font-weight:700;">R${l}</td>${cells}<td style="font-weight:700;">${sum}</td>${dCell}</tr>`;
      }).join('');
      const tCells = BRANCH_COL.map(b => `<td style="font-weight:700;">${M1.tot[b]}</td>`).join('');
      const grand = BRANCH_COL.reduce((a, b) => a + M1.tot[b], 0);
      const grandPrev = prev ? BRANCH_COL.reduce((a, b) => a + prev.tot[b], 0) : 0;
      const totalRow = `<tr style="border-top:2px solid var(--border);"><td style="font-weight:700;">Total</td>${tCells}<td style="font-weight:700;">${grand}</td>${prev ? `<td style="font-size:10px;">${dfmt(grand - grandPrev)}</td>` : ''}</tr>`;
      const lqRow = prev ? `<tr style="font-size:10px;"><td style="color:var(--text-muted);">vs.LQ</td>${BRANCH_COL.map(b => `<td>${dfmt(M1.tot[b] - prev.tot[b])}</td>`).join('')}<td>${dfmt(grand - grandPrev)}</td><td></td></tr>` : '';
      return `<div class="table-wrap" style="flex:1;min-width:${prev ? 300 : 280}px;">
        <div style="font-weight:700;font-size:12px;padding:8px 10px 2px;${hi ? 'color:var(--primary);' : ''}">${title} <span style="color:var(--text-muted);font-weight:400;">TTL ${grand}${prev ? ` <span style="font-size:10px;">(${grand - grandPrev >= 0 ? '+' : ''}${grand - grandPrev})</span>` : ''}</span></div>
        <table style="width:100%;font-size:11px;text-align:center;">
          <thead><tr><th></th>${BRANCH_COL.map(b => `<th>${BR_SHORT[b]}</th>`).join('')}<th>TTL</th>${prev ? '<th style="font-size:10px;">Δ</th>' : ''}</tr></thead>
          <tbody>${rows}${totalRow}${lqRow}</tbody>
        </table></div>`;
    }
    // 분기 스트립 블록 — 데이터 없는 분기는 자리 표시(내년 1Q 대비)
    const qTitles = [`1Q. ${String(YEAR).slice(2)}Y`, `2Q. ${String(YEAR).slice(2)}Y (AS-IS)`, `3Q. ${String(YEAR).slice(2)}Y (TO-BE)`, `4Q. ${String(YEAR).slice(2)}Y (${bqi + 1}Q 마감 결정)`];
    const qPlaceholder = ['데이터 없음 — 차년 시즌부터 표시', '데이터 없음', '데이터 없음', `${bqi + 1}Q 마감 FCST·결정 입력 시 표시`];
    const stripBlocks = mQ.map((mm, i) => mm
      ? matrixHtml(qTitles[i], mm, i > 0 ? mQ[i - 1] : null, i === 2)
      : `<div class="table-wrap" style="flex:1;min-width:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 12px;gap:6px;">
           <div style="font-weight:700;font-size:12px;color:var(--text-muted);">${qTitles[i]}</div>
           <div style="font-size:11px;color:var(--text-muted);">${qPlaceholder[i]}</div>
         </div>`).join('');

    // ── 가이드라인 카드 ──
    const glTrs = M().guideline.map(g =>
      `<tr><td style="font-weight:700;">R${g.r}</td><td>${g.dc}%</td><td>${fmt(g.mon)}</td><td>${fmt(g.yr)}</td>${g.q.map((v, i) => `<td${!isYear && i === qi ? ' style="background:rgba(32,85,39,.10);font-weight:700;"' : ''}>${fmt(v)}</td>`).join('')}</tr>`).join('');
    const moqTrs = M().moq.rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');

    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <div style="display:flex;gap:6px;">${viewBtns}</div>
        <div style="display:flex;gap:6px;margin-left:8px;">${teamBtns}</div>
        <span id="range-save-chip" style="margin-left:auto;font-size:12px;"></span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        <span style="font-size:11px;color:var(--text-muted);">SR</span>${srBtns}
        <span style="margin-left:8px;display:inline-flex;gap:6px;">${srEditBtns}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">${metaTxt}
        · 단위: 환산 케이스(cs) · 기준/실적은 파생코드 합산 · 자격판정: ${isYear ? '연간 임계값' : '마감 FCST → guideline ' + (qi+1) + 'Q 컬럼'} (마스터 ${esc(M().version)})${
        isYear ? '' :
        qi === 0 ? ' · <b style="color:var(--neutral);">1Q 적용 Range 데이터 없음 — 차년 Proposal 반영 시 표시</b>' :
        qi === 3 ? ' · <b>4Q 적용 Range = 3Q 마감 결정</b>(3Q 탭에서 입력) · 이 탭의 마감 FCST는 <b>차년 1Q</b> 결정' : ''}</div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;">
        <div class="chart-card" style="padding:12px;"><div style="font-size:11px;color:var(--text-muted);">Range WS (3Q 적용)</div>
          <div style="font-size:22px;font-weight:800;">${active.length}<span style="font-size:12px;color:var(--text-muted);font-weight:400;"> / 2Q ${activeLQ.length} (${active.length - activeLQ.length >= 0 ? '+' : ''}${active.length - activeLQ.length})</span></div></div>
        <div class="chart-card" style="padding:12px;"><div style="font-size:11px;color:var(--text-muted);">3Q 신규 제외</div>
          <div style="font-size:22px;font-weight:800;color:var(--negative);">${excluded3q}</div></div>
        <div class="chart-card" style="padding:12px;"><div style="font-size:11px;color:var(--text-muted);">3Q 다운그레이드</div>
          <div style="font-size:22px;font-weight:800;color:var(--neutral);">${downgraded}</div></div>
        <div class="chart-card" style="padding:12px;"><div style="font-size:11px;color:var(--text-muted);">${fcstLabel} 입력</div>
          <div style="font-size:22px;font-weight:800;">${fcstFilled}<span style="font-size:12px;color:var(--text-muted);font-weight:400;"> / ${fcstTotal}</span></div></div>
        <div class="chart-card" style="padding:12px;"><div style="font-size:11px;color:var(--text-muted);">${bqi + 2 <= 4 ? (bqi + 2) + 'Q' : '차년 1Q'} 적용(결정) Range WS</div>
          <div style="font-size:22px;font-weight:800;">${hasNext ? nextActive : '-'}<span style="font-size:12px;color:var(--text-muted);font-weight:400;">${hasNext ? ' / 판정 ' + nextKnown.length : ' (FCST 입력 필요)'}</span></div></div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        ${stripBlocks}
      </div>

      <details style="margin-bottom:14px;">
        <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--primary);">📐 Range Guideline (레벨·DC%·볼륨 기준 / MOQ)</summary>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;">
          <div class="table-wrap" style="flex:2;min-width:340px;"><table style="width:100%;font-size:11px;text-align:center;">
            <thead><tr><th>Range</th><th>DC</th><th>월간(cs)</th><th>연간(cs)</th><th>1Q</th><th>2Q</th><th>3Q</th><th>4Q</th></tr></thead>
            <tbody>${glTrs}</tbody></table></div>
          <div class="table-wrap" style="flex:1;min-width:200px;"><table style="width:100%;font-size:11px;text-align:center;">
            <thead><tr><th colspan="3">Bottle MOQ (DC +${M().moq.dc}%)</th></tr><tr><th>Brand</th><th>SKU</th><th>MOQ</th></tr></thead>
            <tbody>${moqTrs}</tbody></table></div>
        </div>
      </details>

      <div class="table-wrap" style="overflow-x:auto;">
        <table style="width:100%;font-size:12px;text-align:center;min-width:${isYear ? 1080 : 1280}px;">
          <thead><tr>
            <th>No</th><th>SR</th><th>코드</th><th style="text-align:left;">도매장</th>
            <th>Range(${isYear ? '현재' : (qi + 1) + 'Q 적용'})</th><th>${thrLabel}(cs)</th>${monCols.map(m => `<th style="color:var(--text-muted);">${m}월</th>`).join('')}<th>${actLabel}(cs)</th><th>달성률</th>
            <th>${fcstLabel}</th><th>FCST 자격</th><th>${nextLabel}</th><th>메모</th><th style="text-align:left;">Remark(3Q)</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
        달성률 = ${actLabel} ÷ 현재 Range의 ${thrLabel} · 색상은 구간 경과율(${bench != null ? Math.round(bench*100) + '%' : '-'}) 대비 페이스 ·
        <b>${fcstLabel}</b>를 입력하면 guideline ${isYear ? '연간' : (qi+1) + 'Q'} 컬럼으로 자격 Range가 산출되고, ${nextLabel}(기본 '자동')이 ${nextQ || '차기'} 적용안이 됩니다. 입력은 자동 저장됩니다.
      </div>`;
  }

  // ── 이벤트 핸들러 (전역 노출) ──
  function _setView(v) { _view = v; rerender(); }
  function _setTeam(t) { _teamFilter = t; rerender(); }
  function _setSr(s) { _srFilter = s; rerender(); }
  function _toggleSub(code) { if (_expanded.has(code)) _expanded.delete(code); else _expanded.add(code); rerender(); }
  // ── SR 이름 편집: 입력은 _srPending에 스테이징, 💾 저장 시 '_srmap' 행으로 일괄 upsert ──
  function _toggleSrEdit() { _srEdit = !_srEdit; if (!_srEdit) _srPending = {}; rerender(); }
  function _onSrEdit(code, val) { _srPending[code] = String(val || '').trim(); }
  async function _saveSr() {
    if (!_sb || !_cache) return;
    const orig = {}; M().entities.forEach(e => { orig[e[3]] = e[2]; });
    const map = Object.assign({}, _cache.srmap);
    for (const code in _srPending) {
      const v = _srPending[code];
      if (!v || v === orig[code]) delete map[code]; else map[code] = v;   // 원본과 같거나 비우면 오버라이드 해제
    }
    try {
      setSaveChip('SR 저장 중…', 'var(--text-muted)');
      const { error } = await _sb.from(TABLE).upsert({ id: '_srmap', data: { byCode: map }, updated_at: new Date().toISOString() });
      if (error) throw error;
      _cache.srmap = map; _srPending = {}; _srEdit = false;
      rerender();
      setSaveChip('✓ SR 저장됨', 'var(--positive)');
    } catch (e) {
      console.error('SR 저장 실패:', e);
      setSaveChip('⚠ SR 저장 실패: ' + e.message, 'var(--negative)');
    }
  }
  function _qd(qkey) {
    const q = _cache.quarters[qkey] || (_cache.quarters[qkey] = {});
    q.fcst = q.fcst || {}; q.dec = q.dec || {};
    return q;
  }
  function _onFcst(qkey, code, val) {
    const q = _qd(qkey);
    const v = val === '' ? null : Number(val);
    if (v == null || isNaN(v)) delete q.fcst[code]; else q.fcst[code] = v;
    markQDirty(qkey); rerender();
  }
  function _onDec(qkey, code, val) {
    const q = _qd(qkey);
    const d = q.dec[code] || (q.dec[code] = {});
    if (val === '') delete d.r; else d.r = Number(val);
    if (!Object.keys(d).length) delete q.dec[code];
    markQDirty(qkey); rerender();
  }
  function _onMemo(qkey, code, val) {
    const q = _qd(qkey);
    const d = q.dec[code] || (q.dec[code] = {});
    if (val) d.memo = val; else delete d.memo;
    if (!Object.keys(d).length) delete q.dec[code];
    markQDirty(qkey);           // 메모는 리렌더 불필요(포커스 유지)
  }

  global.RangeDC = { parseWorkbook, ingestWorkbook, saveMonths, render, invalidate,
                     _setView, _setTeam, _setSr, _toggleSub, _toggleSrEdit, _onSrEdit, _saveSr,
                     _onFcst, _onDec, _onMemo };
})(window);
