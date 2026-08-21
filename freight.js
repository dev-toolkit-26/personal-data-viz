// ═══════════════════════════════════════════════════════════════════
//  freight.js — On-Trade 운송비(KCTC 배송비) 분석 모듈
//  · window.Freight 로 노출. XLSX(SheetJS)·Chart.js·FREIGHT_MASTER(freight_master.js) 전역 필요.
//  · 입력: DSR raw(Team/Group/Code/Date/Qty/HL) → Team=On만(ALSM·제외코드 제외) →
//          "배송처(통합그룹)×배송일" 단위 배송건으로 합산(박스=Qty=UnitsSold, 물리 박스).
//  · 과금 규칙(transport_logic.js — 물류마감내역서 19개월 대조 검증): 출고/반품/회송은 별도 스트림.
//    반품 수량을 출고에 상계하지 않고 각 스트림이 자체 합산 박스로 구간을 판정해 각각 과금한다.
//    (DSR은 유형 컬럼이 없어 양수 Qty=출고, 음수 Qty=반품으로 분리. 회송은 DSR로 식별 불가.)
//    교환출고는 출고행이므로 자동 합산되고 별도 가산하지 않는다.
//  · 교환(맞교환) 판정: 같은 날 반품이 있다고 교환이 아니다. 동일 [통합그룹×일×품목]에 +출고와 -반품이
//    함께 있을 때 min(출고, 반품)만 교환분으로 본다. 품목이 다르면 단순 반품 → 출고 물류비와 무관.
//  · 저장: Supabase `on_freight_months` (id='YYYY-MM', data jsonb) — 월 단위 upsert.
//  · 요율: 권역(코드→권역, 통합그룹은 통합마스터 권역 우선) × 합산박스 구간. 제주권 단일요율.
//  · 지점: DSR Group(Seoul/Busan/Daegu/Jeju/Daejeon/Gwangju) — 요율은 권역, 집계는 지점 둘 다 가능.
//  · 담당(SR): DSR raw의 `Customer.SR`(KRSR###)이 유일한 기준. 업로드된 DSR 중 '가장 최신 날짜' 파일의
//    코드→SR을 저장(_srmap)하고 과거 월 배송건에도 그 매핑을 적용 → 이동·퇴사 시 과거 담당도 현재 담당으로 표시.
//  · 시트 구성: D LY 비교 / B 구간 걸침(실행 대상) / A 도매장별 배송비 / C 배송 빈도 / E 통합정산 절감.
//  · 통합정산 절감: 같은 날 같은 하차지로 2개 이상 코드가 나간 건은 코드별 박스를 parts[]로 보존 →
//    (코드별 개별 청구액 합) − (합산 박스 1건 청구액) = 통합정산으로 절감되는 금액.
//  · 모든 기준은 DSR(On). KCTC 물류 베이스라인은 On/Off 분리가 안 돼 쓰지 않음 →
//    D(LY 비교)는 전년 DSR 백필분(on_freight_months 'YYYY-MM')과 동일 소스로 비교.
// ═══════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const M = () => global.FREIGHT_MASTER;
  const TABLE = 'on_freight_months';
  const SR_ID = '_srmap';                      // 코드→SR(담당) 매핑 저장용 특수 row
  const SR_NONE = '미지정';
  const MON_NM = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const BRANCHES = ['Seoul','Busan','Daegu','Jeju','Daejeon','Gwangju'];
  const BRANCH_OF_GROUP = { 'Seoul':'Seoul','Seoul_East':'Seoul','Seoul_South':'Seoul','Seoul_West':'Seoul',
                            'Busan':'Busan','Daegu':'Daegu','Jeju':'Jeju','Daejeon':'Daejeon','Gwangju':'Gwangju' };
  // 걸침 구간: [하한, 상한, 진입 목표 박스]
  const EDGE = [[4,5,6],[9,10,11],[19,20,21],[55,60,61]];

  const fmt = n => (n == null || isNaN(n)) ? '-' : Math.round(n).toLocaleString('ko-KR');
  const fmt1 = n => (n == null || isNaN(n)) ? '-' : (Math.round(n * 10) / 10).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct = (n, d) => (d ? (n / d * 100) : 0);
  const fpct = v => (v == null || isNaN(v)) ? '-' : (Math.round(v * 10) / 10).toFixed(1) + '%';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // ── 날짜 정규화(index.html _dsrNormDate와 동일 규칙: 가장 가까운 UTC 자정) ──
  function normDate(v) {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000));
    let t;
    if (v instanceof Date) t = v.getTime();
    else { const d = new Date(v); if (isNaN(d)) return null; t = d.getTime(); }
    if (isNaN(t)) return null;
    return new Date(Math.round(t / 86400000) * 86400000);
  }
  function isoWeek(y, m0, d) {
    const dt = new Date(Date.UTC(y, m0, d));
    const dayNum = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    return dt.getUTCFullYear() + '-W' + String(Math.ceil((((dt - yearStart) / 86400000) + 1) / 7)).padStart(2, '0');
  }

  // ── 요율 ──
  function tierOf(box) { const T = M().tier_max; for (let i = 0; i < T.length; i++) if (box <= T[i]) return i; return T.length; }
  function rateOf(region, box) { const r = M().rates[region]; return r ? r[tierOf(box)] : null; }

  // ── 코드 → 배송처 키/이름/권역 ──
  //   통합마스터에 있으면 그룹 키('G:'+그룹명)·그룹 권역, 아니면 코드 자체·코드 권역. 미매핑은 null.
  function resolveCode(code) {
    const m = M(); const c = String(code).trim();
    const cs = m.consol[c];
    if (cs) return { key: 'G:' + cs[0], name: cs[0] + ' (통합)', region: m.regions[cs[1]], mapped: true, consol: true };
    const cd = m.codes[c];
    if (cd) return { key: c, name: cd[0], region: m.regions[cd[1]], mapped: true, consol: false };
    return null;
  }
  function keyRegion(key) {
    const m = M();
    if (key.startsWith('G:')) { const g = key.slice(2); for (const c in m.consol) if (m.consol[c][0] === g) return m.regions[m.consol[c][1]]; return null; }
    const cd = m.codes[key]; return cd ? m.regions[cd[1]] : null;
  }
  function keyName(key) {
    const m = M();
    if (key.startsWith('G:')) return key.slice(2) + ' (통합)';
    const cd = m.codes[key]; return cd ? cd[0] : key;
  }

  // ── SR(담당) ── DSR Customer.SR 기준. _srMap = { 배송처코드: 'KRSR###' }, _srAsOf = 기준일(YYYY-MM-DD)
  let _srMap = null, _srAsOf = '', _srStamp = 0;
  function srName(sr) {
    if (!sr || sr === SR_NONE) return SR_NONE;
    const n = M().sr_names && M().sr_names[sr];
    return n ? n[0] : sr;                        // 이름 매핑 없으면 코드 그대로 (Freight/sr_names.csv로 보강)
  }
  let _groupCodes = null;
  function groupCodes(g) {
    if (!_groupCodes) { _groupCodes = {}; const c = M().consol; for (const code in c) (_groupCodes[c[code][0]] || (_groupCodes[c[code][0]] = [])).push(code); }
    return _groupCodes[g] || [];
  }
  // 배송건 키 → SR. 통합그룹은 소속 코드들의 SR 중 최다(동수면 첫 코드) — 통합 배송은 한 대로 나가므로 대표 1명.
  function srOfKey(key) {
    const map = _srMap || {};
    if (key.startsWith('G:')) {
      const cnt = {}; let first = null;
      groupCodes(key.slice(2)).forEach(c => { const sr = map[c]; if (sr) { cnt[sr] = (cnt[sr] || 0) + 1; if (!first) first = sr; } });
      let best = first, bn = 0;
      for (const sr in cnt) if (cnt[sr] > bn) { bn = cnt[sr]; best = sr; }
      return best || SR_NONE;
    }
    return map[key] || SR_NONE;
  }

  // ═══════════════════════════════════════════════════════════════
  //  파싱: 워크북 → { months: { 'YYYY-MM': monthRec }, warnings:[], hasCode:boolean }
  //   monthRec = { ym, y, m, deliv:[[key, day, box, hl, branch, ncodes]...], names:{key:name},
  //                unmapped:{code:[name, box, hl, n]}, meta:{rows, onRows, maxDay, hlPerBox} }
  // ═══════════════════════════════════════════════════════════════
  function parseWorkbook(wb, opts) {
    opts = opts || {};
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
    const iDate = ix('Date'), iTeam = ix('Team', 'Customer.Team'), iGrp = ix('Group', 'Customer Group'),
          iSeg = ix('Segment', 'Customer.Segment'), iQty = ix('Qty', 'UnitsSold', '박스수량', 'Box'),
          iHl = ix('HL', 'Volume in Hectolitre'), iName = ix('Customer', 'Customer Name', '배송처명', '거래처명'),
          iSr = ix('Customer.SR', 'SR', '담당', '담당자'),      // 담당(SR) — 있는 파일만 매핑 갱신
          iItem = ix('ItemCode', 'Item Code', '품목코드'), iSku2 = ix('NEW SKU', 'New SKU');  // 교환(맞교환) 매칭용
    if (iCode < 0) return { months: {}, warnings: ['배송처코드(Code/Customer Code) 컬럼 없음 — 운송비 산출 건너뜀'], hasCode: false };
    if (iDate < 0 || iQty < 0) throw new Error('운송비: Date / Qty(UnitsSold) 컬럼 확인');
    const excl = new Set(M().exclude);
    const months = {};
    let rows = 0, onRows = 0, sumQ = 0, sumH = 0;
    // (ym, key, day) → 합산
    const acc = {};
    // 코드별 SR 후보: { code: { 'KRSR###': qty } } → 최다 물량 SR 채택, 기준일은 파일 내 최신 날짜
    const srCand = {}; let srAsOf = '';
    for (let i = 1; i < all.length; i++) {
      const r = all[i]; if (!r) continue; rows++;
      if (iTeam >= 0) { const t = r[iTeam] != null ? String(r[iTeam]).trim().toUpperCase() : ''; if (t !== 'ON') continue; }
      const grp = iGrp >= 0 && r[iGrp] != null ? String(r[iGrp]).trim() : '';
      const seg = iSeg >= 0 && r[iSeg] != null ? String(r[iSeg]).trim() : '';
      if (/^ALSM/i.test(grp) || seg.toUpperCase() === 'ALSM') continue;
      const code = r[iCode] != null ? String(r[iCode]).trim() : '';
      if (!code || excl.has(code)) continue;
      const d = normDate(r[iDate]); if (!d) continue;
      const y = d.getUTCFullYear(), m0 = d.getUTCMonth(), day = d.getUTCDate();
      if (opts.year && y !== opts.year) continue;
      const q = Number(r[iQty]) || 0, hl = iHl >= 0 ? (Number(r[iHl]) || 0) : 0;
      onRows++; sumQ += q; sumH += hl;
      const ym = y + '-' + String(m0 + 1).padStart(2, '0');
      const res = resolveCode(code);
      const key = res ? res.key : 'U:' + code;
      const branch = BRANCH_OF_GROUP[grp] || (grp.startsWith('Seoul') ? 'Seoul' : grp || '?');
      const mk = ym + '|' + key + '|' + day;
      let a = acc[mk];
      if (!a) { a = acc[mk] = { ym, y, m: m0 + 1, key, day, box: 0, hl: 0, rbox: 0, rhl: 0, codes: new Set(), cb: {}, rcb: {}, sk: {}, br: {}, res, name: iName >= 0 && r[iName] != null ? String(r[iName]).trim() : code }; }
      // 출고(양수)·반품(음수)은 상계하지 않고 각각 누적 — 실제 청구와 동일(transport_logic.js 규칙 1·3)
      if (q >= 0) { a.box += q; a.hl += hl; a.cb[code] = (a.cb[code] || 0) + q; a.br[branch] = (a.br[branch] || 0) + q; }
      else        { a.rbox += -q; a.rhl += -hl; a.rcb[code] = (a.rcb[code] || 0) + -q; a.br[branch] = (a.br[branch] || 0) + -q; }
      a.codes.add(code);
      // 품목별 +/- 누적 — 같은 품목을 반품하고 같은 날 다시 출고한 분량만 '교환'으로 인정
      const item = iItem >= 0 && r[iItem] != null ? String(r[iItem]).trim() : (iSku2 >= 0 && r[iSku2] != null ? String(r[iSku2]).trim() : '');
      if (item) { const t = a.sk[item] || (a.sk[item] = [0, 0]); if (q >= 0) t[0] += q; else t[1] += -q; }
      if (iSr >= 0) {
        const sr = r[iSr] != null ? String(r[iSr]).trim() : '';
        if (sr && !/^others$/i.test(sr)) {
          (srCand[code] || (srCand[code] = {}))[sr] = (srCand[code][sr] || 0) + Math.abs(q) + 0.001;
          const ds = y + '-' + String(m0 + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
          if (ds > srAsOf) srAsOf = ds;
        }
      }
    }
    // 코드→SR 확정 (최다 물량)
    const srMap = {};
    for (const code in srCand) { let best = null, bq = -1; for (const sr in srCand[code]) if (srCand[code][sr] > bq) { bq = srCand[code][sr]; best = sr; } if (best) srMap[code] = best; }
    for (const mk in acc) {
      const a = acc[mk];
      if (a.box <= 0 && a.rbox <= 0) continue;
      let rec = months[a.ym];
      if (!rec) rec = months[a.ym] = { ym: a.ym, y: a.y, m: a.m, deliv: [], ret: [], ex: {}, names: {}, unmapped: {}, meta: { rows: 0, onRows: 0, maxDay: 0, minDay: 99, nDays: 0, _days: new Set() } };
      let branch = '?', bmax = -1; for (const b in a.br) if (a.br[b] > bmax) { bmax = a.br[b]; branch = b; }
      if (a.day > rec.meta.maxDay) rec.meta.maxDay = a.day;
      if (a.day < rec.meta.minDay) rec.meta.minDay = a.day;
      rec.meta._days.add(a.day);
      if (!a.res) {                                                 // 미매핑 코드 버킷
        const code = a.key.slice(2);
        const u = rec.unmapped[code] || (rec.unmapped[code] = [a.name, 0, 0, 0, branch]);
        u[1] += a.box; u[2] += a.hl; u[3] += 1;
        continue;
      }
      // 교환(맞교환) 박스 = Σ min(품목별 출고, 품목별 반품) — 품목이 다르면 0(단순 반품)
      let exBox = 0;
      for (const it in a.sk) exBox += Math.min(a.sk[it][0], a.sk[it][1]);
      exBox = Math.round(exBox);
      if (exBox > 0) rec.ex[a.key + '|' + a.day] = exBox;
      if (a.box > 0) {                                              // 출고 스트림
        const row = [a.key, a.day, Math.round(a.box), Math.round(a.hl * 100) / 100, branch, Object.keys(a.cb).length];
        // 같은 날 2개 이상 코드가 함께 나간 통합 배송건만 코드별 박스 보존(용량 절감) — 분리 청구 대비 절감액 계산용
        const parts = Object.values(a.cb).map(v => Math.round(v)).filter(v => v > 0).sort((x, y) => y - x);
        if (parts.length >= 2) row.push(parts);
        rec.deliv.push(row);
      }
      if (a.rbox > 0) {                                             // 반품 스트림(자체 합산 박스로 구간 판정)
        const rrow = [a.key, a.day, Math.round(a.rbox), Math.round(a.rhl * 100) / 100, branch, Object.keys(a.rcb).length];
        const rparts = Object.values(a.rcb).map(v => Math.round(v)).filter(v => v > 0).sort((x, y) => y - x);
        if (rparts.length >= 2) rrow.push(rparts);
        rec.ret.push(rrow);
      }
      // 이름은 freight_master(keyName)에서 복원 가능 → 저장 용량 절감을 위해 names는 비워둠(하위호환용 필드)
    }
    const warnings = [];
    if (!onRows) warnings.push('Team=On 행이 없습니다 (Team 컬럼/값 확인)');
    const hpb = sumQ ? sumH / sumQ : 0;
    // 물리 박스 1개 ≈ 0.08~0.20 HL (330ml×24=0.079, 500ml×24=0.12, 케그 0.2~0.3). 크게 벗어나면 단위 의심.
    if (onRows && (hpb < 0.04 || hpb > 0.35)) warnings.push(`박스 단위 의심 — HL/박스 = ${hpb.toFixed(3)} (물리 박스면 0.08~0.20 근처). Qty가 낱개/HL 단위가 아닌지 확인 필요`);
    for (const ym in months) { const mt = months[ym].meta; mt.rows = rows; mt.onRows = onRows; mt.hlPerBox = Math.round(hpb * 1000) / 1000; mt.nDays = mt._days.size; delete mt._days; if (mt.minDay === 99) mt.minDay = 0; }
    return { months, warnings, hasCode: true, hlPerBox: hpb, onRows, srMap, srAsOf, hasSr: iSr >= 0 && Object.keys(srMap).length > 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  //  저장/로드 (Supabase on_freight_months)
  // ═══════════════════════════════════════════════════════════════
  let _cache = null;   // { 'YYYY-MM': monthRec }
  // 저장(월 통째 교체). protect=true(기본): 이미 저장된 월보다 '덜 채워진' 파일이면 그 월은 건너뜀.
  //   기준 = 배송일수(nDays; 구버전 레코드는 maxDay) → 전월 말일 며칠만 섞인 최신 파일(예: 7/27~31+8월)이
  //   저장돼 있던 7월 전체를 5일치로 덮는 사고 방지. 같은 일수면 최신 업로드로 교체(당월 갱신).
  async function saveMonths(sb, months, opts) {
    opts = opts || {}; const protect = opts.protect !== false;
    const yms = Object.keys(months);
    if (!yms.length) return { saved: 0, skipped: [] };
    const skipped = [];
    if (protect) {
      const { data: ex, error: exErr } = await sb.from(TABLE).select('id, data->meta').in('id', yms);
      if (exErr) _throwSaveErr(exErr);
      const fill = mt => mt ? (mt.nDays != null ? mt.nDays : (mt.maxDay || 0)) : 0;
      (ex || []).forEach(r => {
        const oldN = fill(r.meta), newN = fill(months[r.id].meta);
        if (newN < oldN) skipped.push(`${r.id}(저장 ${oldN}일 > 파일 ${newN}일)`);
      });
    }
    const rows = yms.filter(ym => !skipped.some(s => s.startsWith(ym))).map(ym => { const d = Object.assign({}, months[ym]); delete d._e; return { id: ym, data: d, updated_at: new Date().toISOString() }; });
    if (rows.length) {
      const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'id' });
      if (error) _throwSaveErr(error);
      if (_cache) rows.forEach(r => { _cache[r.id] = months[r.id]; });
    }
    return { saved: rows.length, skipped };
  }
  function _throwSaveErr(error) {
    if (/relation .* does not exist|schema cache|PGRST205|42P01/i.test(error.message || ''))
      throw new Error('on_freight_months 테이블 없음 — migrations/on_freight_months.sql 을 Supabase SQL Editor에서 1회 실행 후 재시도');
    throw new Error('운송비 저장 실패: ' + error.message);
  }
  async function loadAll(sb, force) {
    if (_cache && !force) return _cache;
    const { data, error } = await sb.from(TABLE).select('id, data');
    if (error) throw error;
    const out = {};
    (data || []).forEach(r => {
      if (r.id === SR_ID) { const d = r.data || {}; _srMap = d.map || {}; _srAsOf = d.asOf || ''; _srStamp++; return; }
      if (r.data && r.data.deliv) out[r.id] = r.data;
    });
    _cache = out; return out;
  }
  // 코드→SR 매핑 저장. '가장 최신 DSR'만 기준이 되도록 asOf가 과거인 파일은 무시하고,
  // 최신 파일에 없는 코드는 기존 담당을 유지(merge) → 과거 월도 현재 담당으로 소급 표시됨.
  async function saveSrMap(sb, srMap, asOf) {
    if (!srMap || !Object.keys(srMap).length) return { saved: false, reason: 'SR 없음' };
    const { data, error } = await sb.from(TABLE).select('data').eq('id', SR_ID).maybeSingle();
    if (error) _throwSaveErr(error);
    const cur = (data && data.data) || {};
    if (cur.asOf && asOf && cur.asOf > asOf) return { saved: false, reason: `과거 파일(${asOf}) < 저장본(${cur.asOf}) → 담당 매핑 유지` };
    const merged = Object.assign({}, cur.map || {}, srMap);
    const newAsOf = (asOf && (!cur.asOf || asOf >= cur.asOf)) ? asOf : (cur.asOf || '');
    const { error: upErr } = await sb.from(TABLE).upsert({ id: SR_ID, data: { asOf: newAsOf, map: merged }, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (upErr) _throwSaveErr(upErr);
    _srMap = merged; _srAsOf = newAsOf; _srStamp++;
    if (_cache) for (const ym in _cache) delete _cache[ym]._e;      // SR 붙은 캐시 무효화
    return { saved: true, n: Object.keys(srMap).length, total: Object.keys(merged).length, asOf: newAsOf };
  }

  // ═══════════════════════════════════════════════════════════════
  //  계산: 선택 월들의 배송건 → 배송료·구간·걸침·빈도
  //   opts: { region:'ALL'|권역, branch:'ALL'|지점 }
  // ═══════════════════════════════════════════════════════════════
  function enrich(rec) {
    // 배송건에 권역·요율·배송료·구간·담당(SR) 부여(캐시 — SR 매핑 갱신 시 _srStamp로 무효화)
    if (rec._e && rec._eStamp === _srStamp) return rec._e;
    const out = rec.deliv.map(d => {
      const [key, day, box, hl, branch, nc, parts] = d;
      const region = keyRegion(key) || '미매핑';
      const tier = tierOf(box);
      const rate = rateOf(region, box) || 0;
      const sr = srOfKey(key);
      const exBox = (rec.ex && rec.ex[key + '|' + day]) || 0;       // SKU 매칭된 교환분(없으면 0)
      const fee = rate * box;
      // 통합정산 절감 = 코드별 개별 청구 합 − 합산 1건 청구
      let csave = 0, cparts = 0;
      if (Array.isArray(parts) && parts.length >= 2) {
        let sep = 0; for (const pb of parts) { const r2 = rateOf(region, pb); if (r2 == null) { sep = 0; break; } sep += r2 * pb; }
        if (sep > fee) { csave = sep - fee; cparts = parts.length; }
      }
      return { key, name: rec.names[key] || keyName(key), y: rec.y, m: rec.m, day, box, hl, branch, nc, region, tier, rate, fee, wk: isoWeek(rec.y, rec.m - 1, day), sr, srName: srName(sr), csave, cparts, exBox };
    });
    rec._e = out; rec._eStamp = _srStamp; return out;
  }
  // 반품 배송건 인리치 — 출고와 동일 요율표·구간이지만 별도 청구(상계 없음)
  function enrichRet(rec) {
    if (rec._r && rec._rStamp === _srStamp) return rec._r;
    const out = (rec.ret || []).map(d => {
      const [key, day, box, hl, branch, nc] = d;
      const region = keyRegion(key) || '미매핑';
      const rate = rateOf(region, box) || 0;
      const sr = srOfKey(key);
      return { key, name: keyName(key), y: rec.y, m: rec.m, day, box, hl, branch, nc, region, tier: tierOf(box), rate, fee: rate * box, sr, srName: srName(sr), stream: '반품' };
    });
    rec._r = out; rec._rStamp = _srStamp; return out;
  }
  function filterDeliv(recs, opts) {
    const rg = opts.region && opts.region !== 'ALL' ? opts.region : null;
    const br = opts.branch && opts.branch !== 'ALL' ? opts.branch : null;
    const cap = opts.dayCap || null;   // { 'YYYY-MM': N } → 해당 월은 N일까지만 (진행 중인 달과 LY 동일 기간 비교)
    const sr = opts.sr && opts.sr !== 'ALL' ? opts.sr : null;
    const out = [];
    recs.forEach(rec => { const c = cap && cap[rec.ym]; enrich(rec).forEach(d => { if ((!rg || d.region === rg) && (!br || d.branch === br) && (!sr || d.sr === sr) && (!c || d.day <= c)) out.push(d); }); });
    return out;
  }
  function filterRet(recs, opts) {
    const rg = opts.region && opts.region !== 'ALL' ? opts.region : null;
    const br = opts.branch && opts.branch !== 'ALL' ? opts.branch : null;
    const sr = opts.sr && opts.sr !== 'ALL' ? opts.sr : null;
    const cap = opts.dayCap || null;
    const out = [];
    recs.forEach(rec => { const c = cap && cap[rec.ym]; enrichRet(rec).forEach(d => { if ((!rg || d.region === rg) && (!br || d.branch === br) && (!sr || d.sr === sr) && (!c || d.day <= c)) out.push(d); }); });
    return out;
  }
  function edgeOf(d) {
    if (d.region === '제주권' || d.region === '미매핑') return null;
    for (const [lo, hi, target] of EDGE) {
      if (d.box >= lo && d.box <= hi) {
        const nextRate = rateOf(d.region, target);
        if (nextRate == null || nextRate >= d.rate) return null;
        return { need: target - d.box, target, curRate: d.rate, nextRate, savePerBox: d.rate - nextRate, save: (d.rate - nextRate) * d.box, band: lo + '~' + hi };
      }
    }
    return null;
  }
  function compute(recs, opts) {
    const D = filterDeliv(recs, opts || {});
    const RET = filterRet(recs, opts || {});
    // A. 도매장별
    const byKey = {};
    D.forEach(d => {
      const a = byKey[d.key] || (byKey[d.key] = { key: d.key, name: d.name, region: d.region, sr: d.sr, srName: d.srName, branch: {}, n: 0, box: 0, hl: 0, fee: 0, tiers: [0,0,0,0,0], small: 0, edge: 0, edgeSave: 0, csave: 0, cn: 0 });
      a.n++; a.box += d.box; a.hl += d.hl; a.fee += d.fee; a.tiers[d.tier]++; if (d.box <= 5) a.small++;
      if (d.csave) { a.csave += d.csave; a.cn++; }
      a.branch[d.branch] = (a.branch[d.branch] || 0) + d.box;
      const e = edgeOf(d); if (e) { a.edge++; a.edgeSave += e.save; }
    });
    const codes = Object.values(byKey).map(a => { let b = '?', bm = -1; for (const k in a.branch) if (a.branch[k] > bm) { bm = a.branch[k]; b = k; } a.branchTop = b; a.perBox = a.box ? a.fee / a.box : 0; return a; })
                    .sort((x, y) => y.fee - x.fee);
    // B. 걸침
    const edges = [];
    D.forEach(d => { const e = edgeOf(d); if (e) edges.push(Object.assign({}, d, e)); });
    edges.sort((x, y) => y.save - x.save);
    const edgeByRegion = {}; edges.forEach(e => { const r = edgeByRegion[e.region] || (edgeByRegion[e.region] = { n: 0, save: 0 }); r.n++; r.save += e.save; });
    const edgeByBand = {}; edges.forEach(e => { const r = edgeByBand[e.band] || (edgeByBand[e.band] = { n: 0, save: 0 }); r.n++; r.save += e.save; });
    // C. 빈도: 도매장×ISO주 배송일수
    const wkDays = {};
    D.forEach(d => { const k = d.key + '|' + d.wk; (wkDays[k] || (wkDays[k] = { key: d.key, name: d.name, region: d.region, branch: d.branch, sr: d.sr, srName: d.srName, wk: d.wk, days: new Set(), box: 0 })).days.add(d.day); wkDays[k].box += d.box; });
    const highFreq = {};
    Object.values(wkDays).forEach(w => { if (w.days.size >= 4) { const h = highFreq[w.key] || (highFreq[w.key] = { key: w.key, name: w.name, region: w.region, branch: w.branch, sr: w.sr, srName: w.srName, weeks: 0, maxDays: 0, box: 0 }); h.weeks++; h.maxDays = Math.max(h.maxDays, w.days.size); h.box += w.box; } });
    const highFreqList = Object.values(highFreq).sort((a, b) => b.weeks - a.weeks || b.maxDays - a.maxDays);
    // 지점별·권역별 요약
    const sumBy = (fld) => {
      const o = {};
      D.forEach(d => { const k = d[fld]; const a = o[k] || (o[k] = { n: 0, box: 0, hl: 0, fee: 0, small: 0, edge: 0, edgeSave: 0, hf: new Set(), keys: new Set() }); a.n++; a.box += d.box; a.hl += d.hl; a.fee += d.fee; if (d.box <= 5) a.small++; const e = edgeOf(d); if (e) { a.edge++; a.edgeSave += e.save; } a.keys.add(d.key); });
      highFreqList.forEach(h => { const k = h[fld]; if (o[k]) o[k].hf.add(h.key); });
      RET.forEach(r => { const k = r[fld]; const a = o[k] || (o[k] = { n: 0, box: 0, hl: 0, fee: 0, small: 0, edge: 0, edgeSave: 0, csave: 0, cn: 0, hf: new Set(), keys: new Set() }); a.retFee = (a.retFee || 0) + r.fee; a.retN = (a.retN || 0) + 1; });
      for (const k in o) { o[k].hfCnt = o[k].hf.size; o[k].nKeys = o[k].keys.size; o[k].retFee = o[k].retFee || 0; o[k].retN = o[k].retN || 0; o[k].gross = o[k].fee + o[k].retFee; delete o[k].hf; delete o[k].keys; }
      return o;
    };
    const total = { n: D.length, box: 0, hl: 0, fee: 0, small: 0, edge: edges.length, edgeSave: 0, hfCnt: highFreqList.length, tiers: [0,0,0,0,0], nKeys: codes.length, csave: 0, cn: 0 };
    D.forEach(d => { total.box += d.box; total.hl += d.hl; total.fee += d.fee; if (d.box <= 5) total.small++; total.tiers[d.tier]++; if (d.csave) { total.csave += d.csave; total.cn++; } });
    edges.forEach(e => total.edgeSave += e.save);
    // ── 반품 스트림 + 교환 추정(같은 하차지·같은 날 출고와 반품이 함께 발생 = 맞교환) ──
    //   출고 구간에는 반품을 상계하지 않으므로(실제 청구와 동일), 교환이 섞인 건만 표시해 발주 판단 시 오해를 막는다.
    const shipKey = new Set(D.map(d => d.key + '|' + d.y + '-' + d.m + '-' + d.day));
    const retBoxByKey = {};
    RET.forEach(r => { const k = r.key + '|' + r.y + '-' + r.m + '-' + r.day; retBoxByKey[k] = (retBoxByKey[k] || 0) + r.box; });
    //  d.exBox = 품목 매칭된 교환분(진짜 교환) / d.retSame = 같은 날 반품 총량(교환 아닌 분 포함, 참고용)
    D.forEach(d => { d.retSame = retBoxByKey[d.key + '|' + d.y + '-' + d.m + '-' + d.day] || 0; });
    total.retFee = 0; total.retN = RET.length; total.retBox = 0; total.retSmall = 0; total.retSmallFee = 0; total.exN = 0; total.exRetFee = 0;
    const retByKey = {};
    RET.forEach(r => {
      total.retFee += r.fee; total.retBox += r.box;
      if (r.box <= 5) { total.retSmall++; total.retSmallFee += r.fee; }
      r.withShip = shipKey.has(r.key + '|' + r.y + '-' + r.m + '-' + r.day);
      if (r.withShip) { total.exN++; total.exRetFee += r.fee; }
      const a = retByKey[r.key] || (retByKey[r.key] = { key: r.key, name: r.name, sr: r.sr, srName: r.srName, branch: r.branch, region: r.region, n: 0, box: 0, fee: 0, small: 0, ex: 0 });
      a.n++; a.box += r.box; a.fee += r.fee; if (r.box <= 5) a.small++; if (r.withShip) a.ex++;
    });
    total.gross = total.fee + total.retFee;                                     // 총 물류비(출고+반품)
    const retList = Object.values(retByKey).sort((a, b) => b.fee - a.fee);
    return { D, RET, retList, codes, edges, edgeByRegion, edgeByBand, highFreqList, byBranch: sumBy('branch'), byRegion: sumBy('region'), bySr: sumBy('sr'), total };
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════════════════════════
  const S = { period: null, branch: 'ALL', sr: 'ALL', search: '', showAllA: false, showAllB: false, showAllRep: false, showAllCs: false, showAllRet: false, edgeAct: true, edgeBand: 'ALL', edgeSort: 'save', charts: {} };

  function periodMonths(period, months) {
    // period: 'YYYY-MM' | 'YTD-YYYY'
    const keys = Object.keys(months).sort();
    if (!period) return [];
    if (period.startsWith('YTD-')) { const y = period.slice(4); return keys.filter(k => k.startsWith(y + '-')); }
    return keys.filter(k => k === period);
  }

  function chart(id, cfg) {
    const el = document.getElementById(id); if (!el || typeof Chart === 'undefined') return;
    if (S.charts[id]) { try { S.charts[id].destroy(); } catch (e) {} }
    S.charts[id] = new Chart(el.getContext('2d'), cfg);
  }

  async function render(sb) {
    if (sb) S.sb = sb;
    sb = S.sb;
    const root = document.getElementById('freight-root'); if (!root) return;
    let months;
    try { months = await loadAll(sb); }
    catch (e) {
      const missing = /does not exist|schema cache|PGRST205|42P01/i.test(e.message || '');
      root.innerHTML = `<div class="chart-card" style="padding:24px;color:var(--negative);font-size:13px;">운송비 데이터 로드 실패: ${esc(e.message)}${missing ? '<br><span style="color:var(--text-muted)">→ <code>migrations/on_freight_months.sql</code> 을 Supabase SQL Editor에서 1회 실행하세요.</span>' : ''}</div>`;
      return;
    }
    const keys = Object.keys(months).sort();
    if (!keys.length) {
      root.innerHTML = `<div class="chart-card" style="padding:24px;font-size:13px;color:var(--text-muted);">운송비 데이터가 아직 없습니다. <b>Data Update → 🚚 운송비(Freight) DSR 백필</b>에서 배송처코드가 있는 DSR raw(여러 월 가능)를 업로드하거나, 통합 DSR 업로드 시 최신월이 자동 반영됩니다.</div>`;
      return;
    }
    if (!S.period || (!S.period.startsWith('YTD-') && !months[S.period])) S.period = keys[keys.length - 1];
    const selKeys = periodMonths(S.period, months);
    const recs = selKeys.map(k => months[k]);
    const Rb = compute(recs, { branch: S.branch });                 // SR 드롭다운 목록용(SR 미적용)
    const srList = Object.keys(Rb.bySr).sort((a, b) => Rb.bySr[b].fee - Rb.bySr[a].fee);
    if (S.sr !== 'ALL' && !srList.includes(S.sr)) S.sr = 'ALL';      // 지점·기간 바꿔서 없어진 SR이면 해제
    const R = S.sr === 'ALL' ? Rb : compute(recs, { branch: S.branch, sr: S.sr });
    const years = [...new Set(keys.map(k => k.slice(0, 4)))];
    const periodLabel = S.period.startsWith('YTD-') ? S.period.slice(4) + ' YTD (' + selKeys.map(k => MON_NM[+k.slice(5) - 1]).join('·') + ')' : (S.period.slice(0, 4) + ' ' + MON_NM[+S.period.slice(5) - 1]);
    const lastRec = recs[recs.length - 1];
    const asOf = lastRec ? `${lastRec.ym.slice(0,4)}.${lastRec.ym.slice(5)}.${String(lastRec.meta.maxDay).padStart(2,'0')}` : '';

    // ── 필터바 ──
    let html = `
    <div class="filter-bar op-sticky" style="margin-bottom:12px;gap:14px;flex-wrap:wrap;">
      <span><label>Period</label>
        <select id="fr-period" onchange="Freight.setPeriod(this.value)">
          ${years.map(y => `<option value="YTD-${y}" ${S.period === 'YTD-' + y ? 'selected' : ''}>${y} YTD</option>`).join('')}
          ${keys.slice().reverse().map(k => `<option value="${k}" ${S.period === k ? 'selected' : ''}>${k.slice(0,4)} ${MON_NM[+k.slice(5)-1]}</option>`).join('')}
        </select></span>
      <span class="month-toggle-wrap"><label>Branch</label>
        <button class="month-btn ${S.branch === 'ALL' ? '' : 'off'}" onclick="Freight.setBranch('ALL')">전체</button>
        ${BRANCHES.map(b => `<button class="month-btn ${S.branch === b ? '' : 'off'}" onclick="Freight.setBranch('${b}')">${b}</button>`).join('')}
      </span>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">DSR(On) 기준 · 데이터 ~${asOf} · 박스=Qty · 담당 SR ~${_srAsOf || '미설정'}</span>
      ${S.branch === 'ALL' ? '' : `
      <span class="month-toggle-wrap" style="flex-basis:100%;padding-top:8px;border-top:1px dashed var(--border);">
        <label>담당 SR · ${S.branch}</label>
        <button class="month-btn ${S.sr === 'ALL' ? '' : 'off'}" onclick="Freight.setSr('ALL')">전체 ${srList.filter(x => x !== SR_NONE).length}명</button>
        ${srList.map(sr => `<button class="month-btn ${S.sr === sr ? '' : 'off'}" onclick="Freight.setSr('${esc(sr)}')" title="${esc(sr)}">${esc(srName(sr))}</button>`).join('')}
      </span>`}
    </div>`;

    // ── 요약 카드 ──
    const T = R.total;
    html += `<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      ${card('출고 배송료 (발주 기준)', '₩' + fmt(T.fee), `${fmt(T.n)}건 · ${fmt(T.box)}박스${T.retFee ? ` · 반품 ₩${fmt(T.retFee)} 별도(참고)` : ''}`, '')}
      ${card('박스당 단가', '₩' + fmt(T.box ? T.fee / T.box : 0), `HL당 ₩${fmt(T.hl ? T.fee / T.hl : 0)} · ${fmt1(T.hl)} HL`, '')}
      ${card('소량건(≤5박스) 비중', fpct(pct(T.small, T.n)), `${fmt(T.small)}건 / ${fmt(T.n)}건`, T.n && pct(T.small, T.n) > 30 ? 'negative' : 'positive')}
      ${card('구간 걸침 오더', fmt(T.edge) + '건', `전량 상향 시 절감 ₩${fmt(T.edgeSave)}`, T.edge ? 'neutral' : 'positive')}
      ${card('주4회+ 배송 도매장', fmt(T.hfCnt) + '곳', `도매장 ${fmt(T.nKeys)}곳 중`, T.hfCnt ? 'neutral' : 'positive')}
      ${card('Over 60 비중', fpct(pct(T.tiers[4], T.n)), `21~60: ${fmt(T.tiers[3])} · 11~20: ${fmt(T.tiers[2])} · ≤10: ${fmt(T.tiers[0] + T.tiers[1])}`, '')}
      ${card('동일 하차장 통합 절감', '₩' + fmt(T.csave), `${fmt(T.cn)}건 통합 배송 · 분리 청구 대비${T.fee ? ` (${fpct(pct(T.csave, T.fee + T.csave))})` : ''}`, T.csave ? 'positive' : '')}
    </div>`;

    // ── D. LY 비교 (DSR(On) 동일 소스: 전년 동월 저장분 vs 선택 기간, 같은 권역·지점 필터) ──
    const monsSel = selKeys.map(k => +k.slice(5));
    const yearSel = +S.period.replace('YTD-', '').slice(0, 4);
    const lyKeys = monsSel.map(m => (yearSel - 1) + '-' + String(m).padStart(2, '0')).filter(k => months[k]);
    // 진행 중인 달(저장된 가장 최신 월이 선택 기간에 포함되고 월말까지 안 찬 경우) → LY 동월은 같은 일자(1~maxDay)까지만 비교
    const latestYm = keys[keys.length - 1];
    const dayCap = {};
    let capNote = '';
    if (selKeys.includes(latestYm)) {
      const mt = months[latestYm].meta || {}; const dim = new Date(Date.UTC(+latestYm.slice(0, 4), +latestYm.slice(5), 0)).getUTCDate();
      if (mt.maxDay && mt.maxDay < dim) { const lyK = (yearSel - 1) + latestYm.slice(4); if (months[lyK]) { dayCap[lyK] = mt.maxDay; capNote = ` · ${MON_NM[+latestYm.slice(5) - 1]}은 진행 중(~${mt.maxDay}일) → LY도 1~${mt.maxDay}일만 비교`; } }
    }
    const RL = lyKeys.length ? compute(lyKeys.map(k => months[k]), { branch: S.branch, dayCap }) : null;
    const TL = RL ? RL.total : null;
    const cellDiff = (a, b, lowerBetter, pp) => {
      const diff = (a == null || b == null) ? null : (pp ? (b - a) : (a ? (b - a) / a * 100 : null));
      const good = diff == null ? '' : ((diff < 0) === lowerBetter || diff === 0) ? 'td-pos' : 'td-neg';
      return `<td class="${good}">${diff == null ? '-' : (diff > 0 ? '+' : '') + diff.toFixed(1) + (pp ? '%p' : '%')}</td>`;
    };
    const dash = '<span style="color:var(--text-muted)">-</span>';
    const rowD = (label, a, b, fmtF, lowerBetter, pp) =>
      `<tr><td>${label}</td><td>${a == null ? dash : fmtF(a)}</td><td>${b == null ? dash : fmtF(b)}</td>${cellDiff(a, b, lowerBetter, pp)}</tr>`;
    const won = v => v == null ? '-' : '₩' + fmt(v);
    const dsrLyTxt = lyKeys.length ? lyKeys.map(k => MON_NM[+k.slice(5) - 1]).join('·') : `없음 — ${yearSel - 1} DSR 백필 필요`;
    const missingLy = monsSel.filter(m => !lyKeys.includes((yearSel - 1) + '-' + String(m).padStart(2, '0')));
    // 지점별 YoY 미니표 — 지점 필터와 무관하게 항상 전 지점 비교(선택 지점만 강조)
    const RbAll = S.branch === 'ALL' ? R  : compute(recs, { sr: S.sr });
    const RlAll = S.branch === 'ALL' ? RL : (lyKeys.length ? compute(lyKeys.map(k => months[k]), { sr: S.sr, dayCap }) : null);
    const dimRows = BRANCHES.filter(k => RbAll.byBranch[k] || (RlAll && RlAll.byBranch[k])).map(k => {
      const c = RbAll.byBranch[k] || { n: 0, box: 0, fee: 0, small: 0, edge: 0, hfCnt: 0 }, l = RlAll ? (RlAll.byBranch[k] || null) : null;
      const yo = (a, b) => (l && a) ? ((b - a) / a * 100) : null;
      const yoF = v => v == null ? dash : `<span class="${v > 0 ? 'td-neg' : 'td-pos'}">${(v > 0 ? '+' : '') + v.toFixed(1)}%</span>`;
      const sm0 = l && l.n ? pct(l.small, l.n) : null, sm1 = c.n ? pct(c.small, c.n) : null;
      const smD = (sm0 != null && sm1 != null) ? sm1 - sm0 : null;
      return `<tr${k === S.branch ? ' style="background:#eaf5ea;"' : ''}><td><b>${esc(k)}</b></td><td>${won(c.fee)}</td><td>${yoF(yo(l && l.fee, c.fee))}</td><td>${fmt(c.n)}</td><td>${yoF(yo(l && l.n, c.n))}</td><td>${won(c.box ? c.fee / c.box : null)}</td><td>${fpct(sm1)}</td><td>${smD == null ? dash : `<span class="${smD > 0 ? 'td-neg' : 'td-pos'}">${(smD > 0 ? '+' : '') + smD.toFixed(1)}%p</span>`}</td><td>${c.hfCnt}${l ? ` <span style="color:var(--text-muted)">(${l.hfCnt})</span>` : ''}</td></tr>`;
    }).join('');
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">D. LY 비교 및 개선 현황 — ${esc(periodLabel)}${S.branch !== 'ALL' ? ' · ' + S.branch : ''}${S.sr !== 'ALL' ? ' · ' + esc(srName(S.sr)) : ''} <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">DSR(On) 동일 소스 · 전년 동월(${yearSel - 1}) vs ${yearSel} · 같은 지점 필터${esc(capNote)}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
        <div>
          <div class="table-wrap" style="margin:0 0 8px;"><table><thead><tr><th style="text-align:left">지표</th><th>${yearSel - 1} LY</th><th>${yearSel} CY</th><th>YoY</th></tr></thead><tbody>
            ${rowD('출고 배송료 (발주 기준)', TL ? TL.fee : null, T.fee, won, true)}
            ${rowD('배송건', TL ? TL.n : null, T.n, fmt, true)}
            ${rowD('박스', TL ? TL.box : null, T.box, fmt, false)}
            ${rowD('HL', TL ? TL.hl : null, T.hl, fmt1, false)}
            ${rowD('박스당 단가', TL && TL.box ? TL.fee / TL.box : null, T.box ? T.fee / T.box : null, won, true)}
            ${rowD('HL당 배송료', TL && TL.hl ? TL.fee / TL.hl : null, T.hl ? T.fee / T.hl : null, won, true)}
            ${rowD('소량건 비중(≤5박스)', TL && TL.n ? pct(TL.small, TL.n) : null, T.n ? pct(T.small, T.n) : null, fpct, true, true)}
            ${rowD('걸침 오더 비율', TL && TL.n ? pct(TL.edge, TL.n) : null, T.n ? pct(T.edge, T.n) : null, fpct, true, true)}
            ${rowD('걸침 오더 수', TL ? TL.edge : null, T.edge, fmt, true)}
            ${rowD('걸침 방치 절감여지(₩)', TL ? TL.edgeSave : null, T.edgeSave, won, true)}
            ${rowD('주4회+ 배송 도매장', TL ? TL.hfCnt : null, T.hfCnt, fmt, true)}
            ${rowD('동일 하차장 통합 절감', TL ? TL.csave : null, T.csave, won, false)}
            ${rowD('반품 물류비 (참고·통제 불가)', TL ? TL.retFee : null, T.retFee, won, true)}
          </tbody></table></div>
          <div style="font-size:11px;color:var(--text-muted);line-height:1.6;">
            · 모든 값은 DSR(On Team만, ALSM·제외코드 제외)에 KCTC 요율표를 적용한 <b>추정 배송료</b>. LY 보유월: ${dsrLyTxt}${missingLy.length && lyKeys.length ? ` · <b style="color:#b45309">${missingLy.map(m => MON_NM[m - 1]).join('·')} LY 없음</b>` : ''}<br>
            · 개선 지표(작을수록 좋음): 소량건 비중 · 걸침 방치율 · 주4회+ 도매장 수 (주 3회는 정상).
          </div>
          <div id="fr-comment" style="margin-top:10px;font-size:12px;line-height:1.7;background:#f0f7f0;border-left:3px solid var(--primary);padding:8px 12px;border-radius:4px;">${autoComment(yearSel, R, RL, 'ALL')}</div>
        </div>
        <div>
          <div class="table-wrap" style="margin:0 0 10px;"><table><thead><tr><th style="text-align:left">지점</th><th>배송료</th><th>YoY</th><th>배송건</th><th>YoY</th><th>박스당</th><th>소량 비중</th><th>YoY</th><th>주4회+ (LY)</th></tr></thead><tbody>
            ${dimRows || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">데이터 없음</td></tr>'}
          </tbody></table></div>
          <div class="chart-title" style="font-size:12px;">월별 예상 배송료 (${yearSel - 1} vs ${yearSel}${S.branch !== 'ALL' ? ' · ' + S.branch : ''})</div>
          <div class="chart-wrap" style="height:200px;"><canvas id="fr-chart-ly"></canvas></div>
          <div class="chart-title" style="font-size:12px;margin-top:12px;">월별 소량건 비중</div>
          <div class="chart-wrap" style="height:160px;"><canvas id="fr-chart-small"></canvas></div>
        </div>
      </div>
    </div>`;

    // ── B. 걸침 알림 (핵심) — "무조건 절감"이 아니라 실행 가능한 건만 우선 ──
    //   실행 대상 = 소량(4~5박스) 제외 + 추가 1~2박스면 상위 구간 진입. 반복(2회+) 도매장이 진짜 개선 대상(MOQ 가이드).
    const ACT_NEED = 2;
    const isAct = e => e.band !== '4~5' && e.need <= ACT_NEED;
    const actAll = Rb.edges.filter(isAct);                     // SR 칩 표기용(지점만 반영)
    const bands = ['ALL', ...EDGE.map(e => e[0] + '~' + e[1])];
    // 도매장별 반복 집계(실행 대상 기준)
    const aggKey = (list) => {
      const o = {};
      list.forEach(e => {
        const a = o[e.key] || (o[e.key] = { key: e.key, name: e.name, sr: e.sr, srName: e.srName, branch: e.branch, region: e.region, n: 0, save: 0, need: 0, box: 0, months: new Set(), bands: {} });
        a.n++; a.save += e.save; a.need += e.need; a.box += e.box; a.months.add(e.y + '-' + e.m); a.bands[e.band] = (a.bands[e.band] || 0) + 1;
      });
      return o;
    };
    const actEdges = R.edges.filter(isAct);
    const repeatList = Object.values(aggKey(actEdges)).filter(a => a.n >= 2).sort((x, y) => y.save - x.save);
    const repeatSave = repeatList.reduce((t, a) => t + a.save, 0);
    const repeatN = repeatList.reduce((t, a) => t + a.n, 0);
    const actSave = actEdges.reduce((t, e) => t + e.save, 0);
    // SR별(실행 대상 기준) — 담당자별 협의 배분
    const srAct = {};
    actAll.forEach(e => { const a = srAct[e.sr] || (srAct[e.sr] = { n: 0, save: 0, keys: new Set() }); a.n++; a.save += e.save; a.keys.add(e.key); });
    const srActList = Object.keys(srAct).sort((a, b) => srAct[b].save - srAct[a].save);
    // 상세 테이블 데이터
    let edgesF = S.edgeAct ? actEdges : R.edges;
    if (S.edgeBand !== 'ALL') edgesF = edgesF.filter(e => e.band === S.edgeBand);
    // 정렬: 절감액순(기본) / 날짜순(최근 → 과거) — 같은 값이면 절감액·일자 보조 정렬
    const dnum = e => e.y * 10000 + e.m * 100 + e.day;
    edgesF = edgesF.slice().sort(S.edgeSort === 'date'
      ? (a, b) => dnum(b) - dnum(a) || b.save - a.save
      : (a, b) => b.save - a.save || dnum(b) - dnum(a));
    const bShow = S.showAllB ? edgesF : edgesF.slice(0, 40);
    const repShow = S.showAllRep ? repeatList : repeatList.slice(0, 15);
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">B. 구간 걸침 오더 — 실행 가능 건 중심 ${esc(periodLabel)}${S.branch !== 'ALL' ? ' · ' + S.branch : ''}${S.sr !== 'ALL' ? ' · ' + esc(srName(S.sr)) : ''} <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">배송처(통합그룹)×배송일 합산박스 기준 · 절감액 = (현재요율 − 차상위요율) × 현재 박스</span></div>
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px;">
        ${card('실행 대상 (추가 1~2박스)', '₩' + fmt(actSave), `${fmt(actEdges.length)}건 · 소량(4~5박스) 제외`, 'positive')}
        ${card('반복 걸침 도매장 (2회+)', '₩' + fmt(repeatSave), `${fmt(repeatList.length)}곳 · ${fmt(repeatN)}건 — MOQ 가이드 1순위`, 'neutral')}
        ${card('전체 걸침 (참고)', '₩' + fmt(T.edgeSave), `${fmt(T.edge)}건 · 전량 상향 가정치(실행 전제 아님)`, '')}
      </div>
      <div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:10px;">
        ※ 목표는 <b>무조건 절감이 아니라 실행 가능한 건</b>. 반복적으로 구간 경계에 걸리는 도매장에 MOQ(최소 주문 박스) 가이드를 주는 것이 실효. 1회성·시즌 물량과 4~5박스 소량(신규 거래처·시즈널)은 선별 적용. 제주권은 단일요율이라 대상 제외.
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);">담당 SR</span>
        <button class="month-btn ${S.sr === 'ALL' ? '' : 'off'}" onclick="Freight.setSr('ALL')">전체 (${fmt(actAll.length)}건)</button>
        ${srActList.map(sr => `<button class="month-btn ${S.sr === sr ? '' : 'off'}" onclick="Freight.setSr('${esc(sr)}')" title="실행 대상 ${srAct[sr].n}건 · 도매장 ${srAct[sr].keys.size}곳">${esc(srName(sr))} ${srAct[sr].n}건/₩${fmt(srAct[sr].save)}</button>`).join('')}
      </div>
      <div class="table-wrap" style="margin:0 0 12px;">
        <table><thead><tr><th style="text-align:left">반복 걸침 도매장 (실행 1순위)</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>걸침 횟수</th><th>월 수</th><th>평균 부족 박스</th><th>절감액 합계</th><th>주 구간</th></tr></thead><tbody>
        ${repShow.map(a => { const mb = Object.keys(a.bands).sort((x, y) => a.bands[y] - a.bands[x])[0];
          return `<tr><td title="${esc(a.key)}">${esc(a.name)}</td><td title="${esc(a.sr)}">${esc(a.srName)}</td><td>${a.branch}</td><td>${a.region}</td><td class="td-neu"><b>${a.n}회</b></td><td>${a.months.size}</td><td>+${(a.need / a.n).toFixed(1)}</td><td class="td-pos">₩${fmt(a.save)}</td><td>${mb}박스</td></tr>`; }).join('')
          || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">반복(2회 이상) 걸침 도매장 없음 — 개별 건은 아래 표 참고</td></tr>'}
        </tbody></table></div>
      ${repeatList.length > 15 ? `<div style="text-align:right;margin:-6px 0 10px;"><button class="month-btn off" onclick="Freight.toggleAllRep()">${S.showAllRep ? '상위 15곳만' : `전체 ${repeatList.length}곳 보기`}</button></div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);">개별 오더</span>
        <button class="month-btn ${S.edgeAct ? '' : 'off'}" onclick="Freight.setEdgeAct(true)">실행 대상만 (+1~2박스)</button>
        <button class="month-btn ${S.edgeAct ? 'off' : ''}" onclick="Freight.setEdgeAct(false)">전체 걸침</button>
        <span style="width:8px;"></span>
        ${bands.map(b => `<button class="month-btn ${S.edgeBand === b ? '' : 'off'}" onclick="Freight.setEdgeBand('${b}')">${b === 'ALL' ? '구간 전체' : b + '박스'}${b !== 'ALL' && R.edgeByBand[b] ? ` (${R.edgeByBand[b].n})` : ''}</button>`).join('')}
        <span style="margin-left:auto;display:inline-flex;gap:6px;align-items:center;">
          <span style="font-size:11px;font-weight:700;color:var(--text-muted);">정렬</span>
          <button class="month-btn ${S.edgeSort === 'save' ? '' : 'off'}" onclick="Freight.setEdgeSort('save')">절감액순</button>
          <button class="month-btn ${S.edgeSort === 'date' ? '' : 'off'}" onclick="Freight.setEdgeSort('date')">날짜순(최근)</button>
        </span>
      </div>
      <div class="table-wrap" style="max-height:460px;">
      <table><thead><tr><th style="text-align:left">도매장</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>일자</th><th>현재 박스</th><th title="동일 품목을 같은 날 반품하고 다시 출고한 분량(맞교환). 품목이 다른 단순 반품은 출고 물류비와 무관하므로 표시하지 않음">교환 포함</th><th>추가 필요</th><th>현재 요율</th><th>→ 변경 요율</th><th>박스당 절감</th><th>예상 절감액</th></tr></thead><tbody>
      ${bShow.map(e => `<tr><td title="${esc(e.key)}">${esc(e.name)}</td><td title="${esc(e.sr)}">${esc(e.srName)}</td><td>${e.branch}</td><td>${e.region}</td><td>${e.y}-${String(e.m).padStart(2,'0')}-${String(e.day).padStart(2,'0')}</td><td><b>${e.box}</b></td><td>${e.exBox ? `<span class="td-neu" title="동일 품목 맞교환 ${e.exBox}박스 포함 — 순수 발주는 ${fmt(Math.max(0, e.box - e.exBox))}박스${e.retSame > e.exBox ? ` (그 외 단순 반품 ${e.retSame - e.exBox}박스는 출고와 무관)` : ''}">교환 ${e.exBox}</span>` : '-'}</td><td class="td-neu">+${e.need} → ${e.target}</td><td>₩${fmt(e.curRate)}</td><td>₩${fmt(e.nextRate)}</td><td>₩${fmt(e.savePerBox)}</td><td class="td-pos">₩${fmt(e.save)}</td></tr>`).join('') || '<tr><td colspan="12" style="text-align:center;color:var(--text-muted)">해당 조건의 걸침 오더 없음</td></tr>'}
      </tbody></table></div>
      ${edgesF.length > 40 ? `<div style="text-align:right;margin-top:6px;"><button class="month-btn off" onclick="Freight.toggleAllB()">${S.showAllB ? '상위 40건만' : `전체 ${edgesF.length}건 보기`}</button></div>` : ''}
    </div>`;

    // ── A. 코드별 예상 배송비 ──
    const q = S.search.trim().toLowerCase();
    const codesF = q ? R.codes.filter(c => c.name.toLowerCase().includes(q) || c.key.toLowerCase().includes(q)) : R.codes;
    const aShow = S.showAllA || q ? codesF : codesF.slice(0, 30);
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title" style="display:flex;align-items:center;gap:12px;">A. 도매장별 예상 배송비 — ${esc(periodLabel)}
        <input id="fr-search" placeholder="도매장/코드 검색" value="${esc(S.search)}" oninput="Freight.setSearch(this.value)" style="margin-left:auto;font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;width:200px;">
      </div>
      <div class="table-wrap" style="max-height:520px;">
      <table><thead><tr><th style="text-align:left">통합도매장</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>배송건수</th><th>총박스</th><th>HL</th><th>예상 배송료</th><th>박스당 단가</th><th>소량건</th><th>걸침건</th><th title="01~05 / 06~10 / 11~20 / 21~60 / Over60">구간 분포 (≤5/≤10/≤20/≤60/60+)</th></tr></thead><tbody>
      ${aShow.map(c => `<tr><td title="${esc(c.key)}">${esc(c.name)}</td><td title="${esc(c.sr)}">${esc(c.srName)}</td><td>${c.branchTop}</td><td>${c.region}</td><td>${fmt(c.n)}</td><td>${fmt(c.box)}</td><td>${fmt1(c.hl)}</td><td><b>₩${fmt(c.fee)}</b></td><td>₩${fmt(c.perBox)}</td><td class="${c.small ? 'td-neu' : ''}">${c.small}</td><td class="${c.edge ? 'td-neu' : ''}">${c.edge}${c.edge ? ` <span style="font-weight:400;color:var(--text-muted)">(₩${fmt(c.edgeSave)})</span>` : ''}</td><td>${tierBar(c.tiers)}</td></tr>`).join('') || '<tr><td colspan="12" style="text-align:center;color:var(--text-muted)">데이터 없음</td></tr>'}
      </tbody></table></div>
      ${!q && codesF.length > 30 ? `<div style="text-align:right;margin-top:6px;"><button class="month-btn off" onclick="Freight.toggleAllA()">${S.showAllA ? '상위 30곳만' : `전체 ${codesF.length}곳 보기`}</button></div>` : ''}
    </div>`;

    // ── C. 배송 빈도 ──
    const cBySr = S.branch !== 'ALL';           // 지점 선택 시 그 지점 안의 SR별로 분해
    const cKeys = cBySr ? Object.keys(R.bySr).sort((a, b) => R.bySr[b].fee - R.bySr[a].fee)
                        : BRANCHES.filter(b => R.byBranch[b]).concat(Object.keys(R.byBranch).filter(b => !BRANCHES.includes(b)));
    const cAgg = cBySr ? R.bySr : R.byBranch;
    const cLabel = k => cBySr ? srName(k) : k;
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">C. 지점별 배송 빈도 — ${esc(periodLabel)} <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">도매장×ISO주 배송일수 · 주 4회 이상만 협의 대상(주 3회는 정상)</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div class="table-wrap" style="margin:0;"><table><thead><tr><th style="text-align:left">${cBySr ? '담당 SR' : '지점'}</th><th>도매장 수</th><th>배송건</th><th>박스</th><th>출고 배송료</th><th>박스당</th><th>소량건 비중</th><th>걸침건</th><th>주4회+ 도매장</th></tr></thead><tbody>
          ${cKeys.map(b => { const a = cAgg[b]; return `<tr><td><b>${esc(cLabel(b))}</b></td><td>${a.nKeys}</td><td>${fmt(a.n)}</td><td>${fmt(a.box)}</td><td>₩${fmt(a.fee)}</td><td>₩${fmt(a.box ? a.fee / a.box : 0)}</td><td class="${pct(a.small, a.n) > 30 ? 'td-neg' : ''}">${fpct(pct(a.small, a.n))}</td><td>${a.edge}</td><td class="${a.hfCnt ? 'td-neu' : ''}">${a.hfCnt}</td></tr>`; }).join('')}
          <tr style="font-weight:700;background:#e0ebe0;"><td>Total</td><td>${T.nKeys}</td><td>${fmt(T.n)}</td><td>${fmt(T.box)}</td><td>₩${fmt(T.fee)}</td><td>₩${fmt(T.box ? T.fee / T.box : 0)}</td><td>${fpct(pct(T.small, T.n))}</td><td>${T.edge}</td><td>${T.hfCnt}</td></tr>
        </tbody></table></div>
        <div class="table-wrap" style="margin:0;max-height:360px;"><table><thead><tr><th style="text-align:left">주4회+ 도매장</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>해당 주 수</th><th>최다 일수/주</th><th>박스</th></tr></thead><tbody>
          ${R.highFreqList.slice(0, 60).map(h => `<tr><td title="${esc(h.key)}">${esc(h.name)}</td><td title="${esc(h.sr)}">${esc(h.srName)}</td><td>${h.branch}</td><td>${h.region}</td><td class="td-neu">${h.weeks}주</td><td>${h.maxDays}일</td><td>${fmt(h.box)}</td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">주 4회 이상 배송 도매장 없음</td></tr>'}
        </tbody></table></div>
      </div>
    </div>`;

    // ── E. 동일 하차장 통합정산 절감 ──
    //   같은 날 같은 하차지로 2개 이상 코드가 나간 배송건: (코드별 개별 청구 합) − (합산 1건 청구) = 절감액.
    //   KCTC 통합정산 적용 리스트(Freight/KCTC_동일배송지_통합정산_적용리스트_최종.xlsx) 기준 실현 금액.
    const csList = R.codes.filter(c => c.csave > 0).sort((x, y) => y.csave - x.csave);
    const csTotal = csList.reduce((t, c) => t + c.csave, 0);
    // 월별 추이(선택 기간 내)
    const csByMon = {};
    R.D.forEach(d => { if (d.csave) { const k = d.y + '-' + String(d.m).padStart(2, '0'); const a = csByMon[k] || (csByMon[k] = { save: 0, n: 0 }); a.save += d.csave; a.n++; } });
    const csMons = Object.keys(csByMon).sort();
    const csShow = S.showAllCs ? csList : csList.slice(0, 15);
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">E. 동일 하차장 통합정산 절감 — ${esc(periodLabel)}${S.branch !== 'ALL' ? ' · ' + S.branch : ''}${S.sr !== 'ALL' ? ' · ' + esc(srName(S.sr)) : ''} <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">같은 날 2개 이상 코드가 같은 하차지로 나간 건 · (코드별 개별 청구 합 − 합산 1건 청구)</span></div>
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px;">
        ${card('통합 절감액', '₩' + fmt(T.csave), `${fmt(T.cn)}건 통합 배송 · 통합그룹 ${fmt(csList.length)}곳`, T.csave ? 'positive' : '')}
        ${card('절감률', fpct(pct(T.csave, T.fee + T.csave)), `분리 청구 시 ₩${fmt(T.fee + T.csave)} → 실제 ₩${fmt(T.fee)}`, '')}
        ${card('월평균 절감', '₩' + fmt(csMons.length ? T.csave / csMons.length : 0), csMons.length ? `${csMons.length}개월 · 최근 ${csMons[csMons.length - 1]} ₩${fmt(csByMon[csMons[csMons.length - 1]].save)}` : '데이터 없음', '')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);background:#f0f7f0;border-left:3px solid var(--primary);padding:6px 10px;margin-bottom:10px;">
        기준: <b>KCTC 동일배송지 통합정산 적용 리스트</b>(${(() => { const g = new Set(Object.values(M().consol).map(v => v[0])); return `${g.size}그룹 · ${Object.keys(M().consol).length}코드`; })()}) — 채널분기 코드(_프랜차이즈/_클럽/_Hotel/_CGV 등)가 동일 하차지로 확인된 그룹. 추가 발주 없이 얻는 절감이라 MOQ 협의(B)보다 실행 난도가 낮습니다.
      </div>
      <div class="table-wrap" style="margin:0;max-height:420px;">
      <table><thead><tr><th style="text-align:left">통합그룹</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>통합 배송건</th><th>총 배송건</th><th>합산 박스</th><th>실제 청구</th><th>분리 청구 시</th><th>통합 절감액</th></tr></thead><tbody>
      ${csShow.map(c => `<tr><td title="${esc(c.key)}">${esc(c.name)}</td><td title="${esc(c.sr)}">${esc(c.srName)}</td><td>${c.branchTop}</td><td>${c.region}</td><td class="td-neu">${fmt(c.cn)}건</td><td>${fmt(c.n)}</td><td>${fmt(c.box)}</td><td>₩${fmt(c.fee)}</td><td>₩${fmt(c.fee + c.csave)}</td><td class="td-pos"><b>₩${fmt(c.csave)}</b></td></tr>`).join('')
        || '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">해당 기간에 같은 날 2개 이상 코드가 함께 나간 통합 배송이 없습니다</td></tr>'}
      ${csList.length ? `<tr style="font-weight:700;background:#e0ebe0;"><td>Total</td><td colspan="3"></td><td>${fmt(T.cn)}건</td><td>${fmt(T.n)}</td><td>${fmt(T.box)}</td><td>₩${fmt(T.fee)}</td><td>₩${fmt(T.fee + T.csave)}</td><td>₩${fmt(csTotal)}</td></tr>` : ''}
      </tbody></table></div>
      ${csList.length > 15 ? `<div style="text-align:right;margin-top:6px;"><button class="month-btn off" onclick="Freight.toggleAllCs()">${S.showAllCs ? '상위 15곳만' : `전체 ${csList.length}곳 보기`}</button></div>` : ''}
      ${csMons.length > 1 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:8px;">월별: ${csMons.map(k => `${MON_NM[+k.slice(5) - 1]} ₩${fmt(csByMon[k].save)}`).join(' · ')}</div>` : ''}
    </div>`;

    // ── G. 교환 혼입 점검 (발주 판단용) ──
    //   목적: 오더 수량과 교환(맞교환) 물량이 섞여 구간이 잘못 산출되는 것을 막는 것.
    //   실제 청구와 동일하게 반품은 출고에 상계하지 않으므로(transport_logic.js 규칙 1·3),
    //   교환이 섞인 배송건은 "순수 발주량"과 다르게 보일 수 있어 여기서 따로 짚어준다.
    //   반품 물류비 자체는 통제 불가 항목이라 절감 대상이 아니라 참고로만 표기한다.
    const exShip = R.D.filter(d => d.exBox > 0).sort((a, b) => b.exBox - a.exBox);
    const exShow = S.showAllRet ? exShip : exShip.slice(0, 15);
    const soloEx = exShip.filter(d => d.box <= 5);          // 단독 교환출고 추정(그날 출고 합산 ≤5박스)
    const soloExSave = soloEx.reduce((t, d) => {
      const modeRate = rateOf(d.region, 30) || 0;           // 정기 배송일(21~60 구간) 합류 가정
      return t + Math.max(0, (d.rate - modeRate) * d.box);
    }, 0);
    const exEdge = exShip.filter(d => edgeOf(d));           // 교환이 섞인 걸침 오더 — 판단 주의 대상
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">G. 교환 혼입 점검 — ${esc(periodLabel)}${S.branch !== 'ALL' ? ' · ' + S.branch : ''}${S.sr !== 'ALL' ? ' · ' + esc(srName(S.sr)) : ''} <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">같은 날 같은 하차지에 출고와 반품이 함께 발생한 건 — 발주량 판단 시 참고</span></div>
      <div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:10px;">
        <b>교환 판정 기준</b>: 같은 날 <b>동일 품목</b>을 반품하고 다시 출고한 분량만 교환으로 봅니다. 품목이 다른 단순 반품은 출고 물류비·발주 판단과 무관하므로 여기서 제외됩니다.<br>
        실제 청구는 <b>출고와 반품을 각각 별도 구간으로 과금</b>합니다(상계 없음). 따라서 아래 건들의 <b>출고 박스는 교환분이 포함된 실제 출고량</b>이며, 구간·요율도 그 기준으로 산출됩니다.
        순수 신규 발주량으로 보려면 교환 박스를 빼고 보세요 — <b>MOQ 협의 시 이 건들은 교환 여부를 확인한 뒤 판단</b>하시면 됩니다.
        ${T.retFee ? `<br>참고: 이 기간 반품 물류비 ₩${fmt(T.retFee)} (${fmt(T.retN)}건 · ${fmt(T.retBox)}박스, 이 중 교환분 ${fmt(exShip.reduce((t, d) => t + d.exBox, 0))}박스) — 반품 비용은 통제 불가 항목이라 절감 대상에서 제외.` : '<br>이 기간에는 반품 데이터가 없습니다(해당 월 재업로드 시 반영).'}
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px;">
        ${card('교환 혼입 배송건', fmt(exShip.length) + '건', `전체 출고 ${fmt(T.n)}건의 ${fpct(pct(exShip.length, T.n))} · 교환 ${fmt(exShip.reduce((t, d) => t + d.exBox, 0))}박스`, '')}
        ${card('교환 혼입 · 걸침 오더', fmt(exEdge.length) + '건', exEdge.length ? 'MOQ 협의 전 교환 여부 확인 필요' : '해당 없음', exEdge.length ? 'neutral' : 'positive')}
        ${card('단독 교환 출고(≤5박스)', fmt(soloEx.length) + '건', soloEx.length ? `정기 배송일 합류 시 ₩${fmt(soloExSave)} 절감 여지` : '해당 없음', soloEx.length ? 'neutral' : 'positive')}
      </div>
      <div class="table-wrap" style="margin:0;max-height:380px;">
      <table><thead><tr><th style="text-align:left">도매장</th><th style="text-align:left">담당 SR</th><th style="text-align:left">지점</th><th>권역</th><th>일자</th><th>출고 박스(청구 기준)</th><th>교환 박스</th><th>순수 발주 추정</th><th>적용 구간</th><th>요율</th><th>출고 배송료</th></tr></thead><tbody>
      ${exShow.map(d => `<tr><td title="${esc(d.key)}">${esc(d.name)}</td><td title="${esc(d.sr)}">${esc(d.srName)}</td><td>${d.branch}</td><td>${d.region}</td><td>${d.y}-${String(d.m).padStart(2,'0')}-${String(d.day).padStart(2,'0')}</td><td><b>${fmt(d.box)}</b></td><td class="td-neu">${fmt(d.exBox)}</td><td>${fmt(Math.max(0, d.box - d.exBox))}</td><td>${M().tier_labels[d.tier]}</td><td>₩${fmt(d.rate)}</td><td>₩${fmt(d.fee)}</td></tr>`).join('')
        || '<tr><td colspan="11" style="text-align:center;color:var(--text-muted)">교환이 섞인 배송건 없음</td></tr>'}
      </tbody></table></div>
      ${exShip.length > 15 ? `<div style="text-align:right;margin-top:6px;"><button class="month-btn off" onclick="Freight.toggleAllRet()">${S.showAllRet ? '상위 15건만' : `전체 ${exShip.length}건 보기`}</button></div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">교환 출고는 <b>정기 배송일 합류를 원칙</b>으로 (품질 이슈 등 긴급 건 제외) — 단독 출고 시 소량 구간(01~05) 요율이 적용돼 박스당 단가가 크게 오릅니다. · 회송(반송)은 집계 대상이 아닙니다.</div>
    </div>`;

    // ── F. KCTC 계약 요율표 (권역 × 합산박스 구간) ──
    //   요율은 freight_master.js(=Freight/build_master.py RATES 상수)가 원본. 표에는 선택 기간의 실제 사용량 병기.
    const TL_ = M().tier_labels, TMAX = M().tier_max;
    const useRT = {};                                   // {권역: [{n,box,fee} × 5]}
    R.D.forEach(d => { const a = useRT[d.region] || (useRT[d.region] = TL_.map(() => ({ n: 0, box: 0, fee: 0 }))); const t = a[d.tier]; t.n++; t.box += d.box; t.fee += d.fee; });
    const rtRow = rg => {
      const rr = M().rates[rg], u = useRT[rg] || TL_.map(() => ({ n: 0, box: 0, fee: 0 }));
      const tot = u.reduce((t, x) => ({ n: t.n + x.n, box: t.box + x.box, fee: t.fee + x.fee }), { n: 0, box: 0, fee: 0 });
      const maxFee = Math.max(...u.map(x => x.fee));
      const single = rg === '제주권';
      const cells = TL_.map((lb, i) => {
        if (single && i > 0) return '';                  // 제주권은 단일요율 → 셀 병합
        const hot = !single && u[i].fee > 0 && u[i].fee === maxFee;
        const uu = single ? tot : u[i];                  // 단일요율 권역은 구간 구분이 없으므로 전체 합을 표기
        return `<td${single ? ' colspan="5"' : ''} style="${hot ? 'background:#eaf5ea;' : ''}text-align:right;">
          <b>₩${fmt(rr[i])}</b>${single ? ' <span style="font-weight:400;color:var(--text-muted);font-size:10px;">(구간 무관 단일요율)</span>' : ''}
          <div style="font-size:10px;color:var(--text-muted);font-weight:400;">${uu.n ? `${fmt(uu.n)}건 · ${fmt(uu.box)}박스 · ₩${fmt(uu.fee)}` : '-'}</div></td>`;
      }).join('');
      return `<tr><td><b>${rg}</b></td>${cells}<td style="text-align:right;">${fmt(tot.n)}</td><td style="text-align:right;">${fmt(tot.box)}</td><td style="text-align:right;"><b>₩${fmt(tot.fee)}</b></td><td style="text-align:right;">₩${fmt(tot.box ? tot.fee / tot.box : 0)}</td></tr>`;
    };
    // 구간 상향 시 박스당 절감폭(요율 차이) — B(걸침)의 근거
    const stepRow = rg => {
      const rr = M().rates[rg];
      if (rg === '제주권') return `<tr><td><b>${rg}</b></td><td colspan="4" style="color:var(--text-muted);">단일요율 — 구간 상향 효과 없음</td></tr>`;
      return `<tr><td><b>${rg}</b></td>${[1, 2, 3, 4].map(i => `<td style="text-align:right;">₩${fmt(rr[i - 1] - rr[i])}<div style="font-size:10px;color:var(--text-muted);">${TMAX[i - 1]}→${TMAX[i - 1] + 1}박스</div></td>`).join('')}</tr>`;
    };
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">F. KCTC 계약 요율표 — 권역 × 합산박스 구간 (원/박스) <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px;">2025 = 2026 동결 · 구간은 <b>배송처(통합그룹)×배송일 합산박스</b>로 판정 · 아래 회색 수치는 ${esc(periodLabel)}${S.branch !== 'ALL' ? ' · ' + S.branch : ''}${S.sr !== 'ALL' ? ' · ' + esc(srName(S.sr)) : ''} 실적</span></div>
      <div class="table-wrap" style="margin:0 0 12px;">
      <table><thead><tr><th style="text-align:left">권역</th>${TL_.map(l => `<th>${l}박스</th>`).join('')}<th>배송건</th><th>박스</th><th>배송료</th><th>박스당</th></tr></thead><tbody>
        ${M().regions.map(rtRow).join('')}
      </tbody></table></div>
      <div class="chart-title" style="font-size:12px;">구간 상향 시 박스당 절감폭 <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:6px;">B(걸침 오더) 절감액 = 이 값 × 현재 박스</span></div>
      <div class="table-wrap" style="margin:0;">
      <table><thead><tr><th style="text-align:left">권역</th><th>05→06박스</th><th>10→11박스</th><th>20→21박스</th><th>60→61박스</th></tr></thead><tbody>
        ${M().regions.map(stepRow).join('')}
      </tbody></table></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">요율 변경 시 <code>Freight/build_master.py</code>의 <code>RATES</code> 상수만 수정 후 재생성하면 대시보드 전체(A~F)에 즉시 반영됩니다.</div>
    </div>`;

    // ── 미매핑/데이터 정보 ──
    const um = {}; recs.forEach(r => { for (const c in r.unmapped) { const u = r.unmapped[c]; const a = um[c] || (um[c] = [u[0], 0, 0, 0, u[4]]); a[1] += u[1]; a[2] += u[2]; a[3] += u[3]; } });
    const umList = Object.entries(um).sort((a, b) => b[1][1] - a[1][1]);
    html += `<div class="chart-card full" style="margin-bottom:16px;">
      <div class="chart-title">신규/미매핑 배송처 (권역 매핑 없음 → 집계 제외) · ${umList.length}개</div>
      ${umList.length ? `<div class="table-wrap" style="margin:0;max-height:220px;"><table><thead><tr><th style="text-align:left">코드</th><th style="text-align:left">배송처명(DSR)</th><th>지점</th><th>배송건</th><th>박스</th><th>HL</th></tr></thead><tbody>
        ${umList.map(([c, u]) => `<tr><td>${esc(c)}</td><td>${esc(u[0])}</td><td>${esc(u[4])}</td><td>${u[3]}</td><td>${fmt(u[1])}</td><td>${fmt1(u[2])}</td></tr>`).join('')}</tbody></table></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">→ 코드권역매핑 CSV에 추가 후 freight_master.js 재생성하면 다음 업로드부터 집계됩니다.</div>` : '<div style="font-size:12px;color:var(--text-muted);">모든 배송처 코드가 권역에 매핑되었습니다.</div>'}
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">담당 SR: DSR <code>Customer.SR</code> 기준(최신 파일 기준으로 과거 월도 소급) · 매핑 기준일 <b>${_srAsOf || '미설정 — SR 컬럼이 있는 DSR raw를 업로드하세요'}</b> · 배송처 ${fmt(Object.keys(_srMap || {}).length)}곳 배정${(() => { const u = Rb.bySr[SR_NONE]; return u ? ` · <b style="color:#b45309">미지정 ${fmt(u.nKeys)}곳 / ₩${fmt(u.fee)} (${fpct(pct(u.fee, Rb.total.fee))})</b> — 해당 기간에만 거래한 코드는 최신 DSR에 없어 미지정. 주간 DSR raw를 업로드할수록 누적 배정됩니다` : ''; })()}${(() => { const un = [...new Set(srList.filter(x => x !== SR_NONE && !(M().sr_names && M().sr_names[x])))]; return un.length ? ` · <b style="color:#b45309">이름 미등록 ${un.length}명(${un.join(', ')}) → Freight/sr_names.csv 보강</b>` : ''; })()}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">저장된 월: ${keys.map(k => `<span style="display:inline-block;padding:1px 6px;margin:1px;border:1px solid var(--border);border-radius:8px;">${k}${months[k].meta ? ` (~${months[k].meta.maxDay}일·${months[k].meta.nDays != null ? months[k].meta.nDays + '일치' : ''})` : ''}</span>`).join('')}</div>
    </div>`;

    root.innerHTML = html;

    // charts (D) — DSR(On) 월별 (같은 권역·지점 필터)
    const dsrMonthly = (year) => {
      const fee = new Array(12).fill(null), small = new Array(12).fill(null);
      for (let m = 1; m <= 12; m++) { const k = year + '-' + String(m).padStart(2, '0'); if (!months[k]) continue; const t = compute([months[k]], { branch: S.branch, dayCap }).total; fee[m - 1] = t.fee; small[m - 1] = t.n ? Math.round(pct(t.small, t.n) * 10) / 10 : null; }
      return { fee, small };
    };
    const dmLY = dsrMonthly(yearSel - 1), dmCY = dsrMonthly(yearSel);
    const toM = v => v == null ? null : Math.round(v / 1e4) / 100;
    chart('fr-chart-ly', { type: 'bar', data: { labels: MON_NM, datasets: [
        { label: String(yearSel - 1), data: dmLY.fee.map(toM), backgroundColor: 'rgba(107,114,128,.45)' },
        { label: String(yearSel), data: dmCY.fee.map(toM), backgroundColor: 'rgba(32,85,39,.85)' } ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw == null ? '-' : c.raw.toFixed(2) + ' MKRW'}` } } },
                 scales: { y: { ticks: { font: { size: 10 }, callback: v => v + 'M' } }, x: { ticks: { font: { size: 10 } } } } } });
    chart('fr-chart-small', { type: 'line', data: { labels: MON_NM, datasets: [
        { label: String(yearSel - 1), data: dmLY.small, borderColor: 'rgba(107,114,128,.9)', backgroundColor: 'rgba(107,114,128,.9)', tension: .3, pointRadius: 3 },
        { label: String(yearSel), data: dmCY.small, borderColor: '#205527', backgroundColor: '#205527', tension: .3, pointRadius: 3 } ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw == null ? '-' : c.raw + '%'}` } } },
                 scales: { y: { ticks: { font: { size: 10 }, callback: v => v + '%' } }, x: { ticks: { font: { size: 10 } } } } } });
    // 검색창 포커스 유지
    if (q) { const inp = document.getElementById('fr-search'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
  }

  function card(label, value, sub, cls) {
    return `<div class="kpi-card ${cls || ''}"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:18px;">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }
  function tierBar(t) {
    const n = t.reduce((a, b) => a + b, 0) || 1;
    const cols = ['#dc2626', '#f59e0b', '#a3b18a', '#2d7a3a', '#205527'];
    return `<span style="display:inline-flex;width:120px;height:10px;border-radius:3px;overflow:hidden;vertical-align:middle;background:#eee;" title="≤5:${t[0]} / ≤10:${t[1]} / ≤20:${t[2]} / ≤60:${t[3]} / 60+:${t[4]}">${t.map((v, i) => `<span style="width:${v / n * 100}%;background:${cols[i]};"></span>`).join('')}</span> <span style="font-size:10px;color:var(--text-muted)">${t.join('/')}</span>`;
  }
  function autoComment(yearSel, R, RL, region) {
    const out = [];
    const T = R.total, TL = RL ? RL.total : null;
    if (TL && TL.n && T.n) {
      const s0 = pct(TL.small, TL.n), s1 = pct(T.small, T.n), d = s1 - s0;
      const b0 = TL.box ? TL.fee / TL.box : 0, b1 = T.box ? T.fee / T.box : 0;
      out.push(`소량건(≤5박스) 비중 ${s0.toFixed(1)}% → ${s1.toFixed(1)}% (${d >= 0 ? '+' : ''}${d.toFixed(1)}%p) — ${d > 1 ? '소량화 진행(개선 필요)' : d < -1 ? '개선' : '보합'}.${(region === 'ALL' || region === '수도권' || region === '강원권') ? ' 소량화는 수도권·강원 집중 이슈.' : ''}`);
      out.push(`박스당 단가 ₩${fmt(b0)} → ₩${fmt(b1)} (${b0 ? ((b1 - b0) / b0 * 100).toFixed(1) : '-'}%) · 박스 ${fmt(TL.box)} → ${fmt(T.box)} (${TL.box ? ((T.box - TL.box) / TL.box * 100).toFixed(1) : '-'}%) · 예상 배송료 ₩${fmt(TL.fee)} → ₩${fmt(T.fee)} (${TL.fee ? ((T.fee - TL.fee) / TL.fee * 100).toFixed(1) : '-'}%)${(region === 'ALL' || region === '충청권' || region === '전라권') ? ' — 충청·전라는 물량 이탈(박스 감소) 시 단가 상승 압력.' : '.'}`);
      out.push(`걸침 오더 ${fmt(TL.edge)} → ${fmt(T.edge)}건 (비율 ${pct(TL.edge, TL.n).toFixed(1)}% → ${pct(T.edge, T.n).toFixed(1)}%) · 주4회+ 배송 도매장 ${TL.hfCnt} → ${T.hfCnt}곳.`);
    } else out.push(`전년 동월 DSR 데이터가 없어 YoY 코멘트 생략 — Data Update에서 ${yearSel - 1} DSR을 백필하면 자동 비교됩니다.`);
    if (T.n) {
      const top = M().regions.map(r => [r, R.edgeByRegion[r]]).filter(x => x[1]).sort((a, b) => b[1].save - a[1].save).slice(0, 2);
      out.push(`이번 기간: 걸침 오더 ${fmt(T.edge)}건, 전량 상향 시 ₩${fmt(T.edgeSave)} 절감 가능${top.length ? ` (${top.map(x => `${x[0].replace('권','')} ₩${fmt(x[1].save)}`).join(', ')})` : ''} · 소량건 ${fmt(T.small)}건(${fpct(pct(T.small, T.n))}) · 주4회+ 배송 도매장 ${T.hfCnt}곳.`);
    }
    return out.map(s => '· ' + esc(s)).join('<br>');
  }

  // ── 상태 setter ──
  function rerender() { const sb = S.sb || global._supabase; if (sb) render(sb); }
  const api = {
    parseWorkbook, saveMonths, saveSrMap, loadAll, compute, resolveCode, tierOf, rateOf, enrich, srOfKey, srName,
    render, TABLE, BRANCHES,
    setPeriod(v) { S.period = v; S.showAllA = S.showAllB = false; rerender(); },
    setBranch(v) { S.branch = v; S.sr = 'ALL'; rerender(); },
    setSr(v) { S.sr = v; S.showAllA = S.showAllB = S.showAllRep = false; rerender(); },
    setEdgeBand(v) { S.edgeBand = v; S.showAllB = false; rerender(); },
    setEdgeAct(v) { S.edgeAct = !!v; S.showAllB = false; rerender(); },
    setEdgeSort(v) { S.edgeSort = v; S.showAllB = false; rerender(); },
    toggleAllRep() { S.showAllRep = !S.showAllRep; rerender(); },
    toggleAllCs() { S.showAllCs = !S.showAllCs; rerender(); },
    toggleAllRet() { S.showAllRet = !S.showAllRet; rerender(); },
    setSearch(v) { S.search = v; clearTimeout(S._t); S._t = setTimeout(rerender, 250); },
    toggleAllA() { S.showAllA = !S.showAllA; rerender(); },
    toggleAllB() { S.showAllB = !S.showAllB; rerender(); },
    invalidate() { _cache = null; S.period = null; S.showAllA = S.showAllB = false; },   // 데이터 갱신 후 다음 렌더는 최신 월로
    _state: S,
  };
  global.Freight = api;
})(window);
