// ═══════════════════════════════════════════════════════════════════
//  off_ingest.js — Off-Trade DSR 파싱/집계 공용 모듈 (On·Off 공유)
//  · window.OffIngest 로 노출. XLSX(SheetJS) 전역 필요.
//  · parseDsrWorkbook: 라인아이템 워크북 → {HL,Qty,NSV} 키="ch|acct|sku"→[12].
//    (Segment 없으면 Group으로 채널 역추론. On-Trade 행은 Group이 지역명이라
//     매핑에 없어 자동 스킵되므로, On+Off 통합 원본을 그대로 넣어도 Off분만 집계됨.)
//  · applyDsrToRows: 집계 결과를 Off rows 배열에 반영(순수 함수, OFF_SEED 비의존).
//  Off/index.html 및 index.html(On) 양쪽에서 재사용.
// ═══════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  function _offCellNum(cell) {
    if (!cell) return 0;
    const v = cell.v;
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function _offCellStr(cell) {
    if (!cell) return null;
    if (cell.v == null) return null;
    return String(cell.v).trim();
  }
  // cellDates(t:'d')는 한국 LMT 등 타임존 아티팩트로 실제 자정에서 몇 시간 어긋나 날짜가 하루 밀릴 수 있음.
  // 가장 가까운 UTC 자정으로 정규화 후 getUTC* 로 읽으면 정확. (숫자 셀은 XLSX.SSF.parse_date_code로 이미 정확)
  function _offNormDate(d) { return new Date(Math.round(d.getTime() / 86400000) * 86400000); }

  // Segment(채널)·Group(거래처) → Off 표준 키 매핑
  const _OFF_TR_CH_MAP = { 'CVS':'CVS','CLSM':'SM','ALSM':'ALSM','Hyper':'HYPER','Cash&Carry':'C&C','Union Shop':'UNION' };
  const _OFF_TR_AC_MAP = {
    'GS25':'GS25','CU':'CU','KoreaSeven':'K7','Emart24':'E24','cspace':'Cspace',
    'Emart':'E-mart','LotteMart':'Lottemart','Lottemart':'Lottemart','Megamart':'Megamart','Homeplus':'Homeplus','NewCore':'NewCore',
    'Hanaromart':'Hanaro','Costco':'Costco','E-Traders':'E-Traders','Vic Market':'Vic Market',
    'GSSuper':'GS Super','LotteSuper':'Lotte Super','Everyday':'Everyday','NoBrand':'Nobrand',
    'Seowon':'Seowon','Korail':'Korail','Express':'Express',
    'ALSM CHN':'ALSM','ALSM Seoul':'ALSM','ALSM YN':'ALSM',
    // Off와 합산 안 하는 별도 채널 (DSR Group: On-line→E-com, military→Military, DutyFree/DF→DF)
    'On-line':'E-com','On-Line':'E-com','Online':'E-com','on-line':'E-com',
    'military':'Military','Military':'Military',
    'DutyFree':'DF','Duty Free':'DF','DF':'DF','dutyfree':'DF','duty free':'DF'
  };
  // Segment 컬럼이 없을 때 Group으로 채널 역추론
  const _OFF_GRP_CH = {
    'GS25':'CVS','CU':'CVS','KoreaSeven':'CVS','Emart24':'CVS','cspace':'CVS',
    'GSSuper':'SM','LotteSuper':'SM','Everyday':'SM','NoBrand':'SM','Seowon':'SM','Korail':'SM','Express':'SM',
    'Emart':'HYPER','LotteMart':'HYPER','Lottemart':'HYPER','Megamart':'HYPER','Homeplus':'HYPER','NewCore':'HYPER',
    'Costco':'C&C','E-Traders':'C&C','Vic Market':'C&C',
    'Hanaromart':'UNION',
    'ALSM CHN':'ALSM','ALSM Seoul':'ALSM','ALSM YN':'ALSM',
    // 별도 채널(Off 합산 제외) — Group으로 채널 판정
    'On-line':'E-com','On-Line':'E-com','Online':'E-com','on-line':'E-com',
    'military':'Military','Military':'Military',
    'DutyFree':'DF','Duty Free':'DF','DF':'DF','dutyfree':'DF','duty free':'DF'
  };

  // ── SKU 코드 정규화 ────────────────────────────────────────────────
  // 구(舊) 양식이 쓰는 폐기된 SKU 코드 → 현행 코드.
  // 파울라너: 6월 FCST 양식이 구명(PA ORI/PA XXX)을 써서 '실적=신규명 / FCST=구명'으로
  //   행이 갈라졌고 그 결과 파울라너 FCST가 대시보드에서 통째로 누락됐다(2026-07 발견·복구).
  //   근거: 7월 FCST 원본의 `SEOWON PA HEL=42.0`이 스냅샷엔 `Seowon PA XXX=42.0`로 적재됨.
  // 원본 파일 양식이 계정마다 섞여 있어 업로드 시점에 흡수한다.
  const _OFF_SKU_ALIAS = {
    'PA ORI 500 CAN': 'PA WHE 500 Can',      // 파울라너 바이스비어 뮌헨 위트비어
    'PA XXX 500 CAN': 'PA HEL 500 Can',      // 파울라너 헬 뮌헨 라거
    'PA ORI 20000 KEG': 'PA WHE 20000 Keg',  // 파울라너 바이스비어 20L 케그
    // 설화 6x1L 캔. FCST 템플릿에 1L 줄이 없어 현업이 'Keg' 줄에 적어 왔다(설화 케그 제품은 없음).
    'SU ORI 1000 KEG': 'SU ORI 1000 Can'
  };
  // 계정을 봐야만 판정되는 오적재 — 같은 코드가 다른 계정에선 정상이라 무조건 치환하면 안 된다.
  // GS25의 'SU ORI 500 Bottle'은 설화 12x618ml GS25 Edition. 템플릿에 618ml 줄이 없어 빈 병 줄에 적힌 것.
  //   (On-Trade의 SU ORI 500 Bottle은 진짜 유흥병이므로 계정 한정 규칙이어야 한다. 현업 확인 완료 2026-07.)
  //   ※ 템플릿 계수도 0.06으로 잘못 박혀 있어 물량이 약 19% 과소 계상됨(실제 12x618ml = 0.07416).
  //     계수 교정은 템플릿 수정으로 처리하고 여기서 임의 배수하지 않는다.
  const _OFF_SKU_ALIAS_BY_ACCT = {
    'GS25': { 'SU ORI 500 BOTTLE': 'SU ORI 618 Can' }
  };
  // 공백 정리 + 별칭 치환. 매칭은 대문자·공백정규화 기준이라 원본 대소문자 흔들림에 안전.
  // acct를 주면 계정 한정 규칙을 먼저 적용한다(생략 시 공통 규칙만).
  function normalizeOffSku(sku, acct) {
    if (sku == null) return sku;
    const s = String(sku).trim().replace(/\s+/g, ' ');
    const u = s.toUpperCase();
    const byAcct = acct && _OFF_SKU_ALIAS_BY_ACCT[acct];
    return (byAcct && byAcct[u]) || _OFF_SKU_ALIAS[u] || s;
  }

  // 헤더 텍스트로 컬럼 찾기 (대소문자/공백 무시)
  function _offFindColByHeader(sh, range, ...candidates) {
    const norm = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, '');
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = sh[XLSX.utils.encode_cell({ r: range.s.r, c: C })];
      const h = norm(cell && cell.v);
      if (!h) continue;
      for (const cand of candidates) {
        if (h === norm(cand) || h.includes(norm(cand))) return C;
      }
    }
    return -1;
  }

  // DSR 라인아이템 워크북 → {HL,Qty,NSV,total,matched,skipped,year}. 키 "ch|acct|sku" → [12 monthly].
  function parseDsrWorkbook(wb, expectedYear) {
    const sh = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(sh['!ref']);
    const cSeg  = _offFindColByHeader(sh, range, 'Segment');
    const cGrp  = _offFindColByHeader(sh, range, 'Group');
    const cSku  = _offFindColByHeader(sh, range, 'New SKU', 'NEW SKU');
    const cDate = _offFindColByHeader(sh, range, 'Date');
    const cMon  = _offFindColByHeader(sh, range, 'Month');
    const cHl   = _offFindColByHeader(sh, range, 'HL', 'Volume in Hectolitre');   // 원본 raw 헤더 별칭
    const cQty  = _offFindColByHeader(sh, range, 'Qty', 'UnitsSold');
    const cNsv  = _offFindColByHeader(sh, range, 'NSV', 'Net Value');
    if (cGrp < 0 || cSku < 0 || cHl < 0 || (cDate < 0 && cMon < 0)) {
      throw new Error('필수 컬럼 누락: Group=' + cGrp + ' SKU=' + cSku + ' HL=' + cHl + ' Date=' + cDate + ' Month=' + cMon);
    }
    const aggHl = {}, aggQt = {}, aggNv = {};
    let total = 0, skipped = 0, yearMatched = 0, yearSeen = new Set();
    const monthsSeen = new Set();   // 이 업로드가 커버하는 월 인덱스(증분 병합용)
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      total++;
      const seg = cSeg >= 0 ? _offCellStr(sh[XLSX.utils.encode_cell({ r: R, c: cSeg })]) : null;
      const grp = _offCellStr(sh[XLSX.utils.encode_cell({ r: R, c: cGrp })]);
      const skuRaw = _offCellStr(sh[XLSX.utils.encode_cell({ r: R, c: cSku })]);
      if (!grp || !skuRaw) { skipped++; continue; }
      const chKey = (seg && _OFF_TR_CH_MAP[seg]) || _OFF_GRP_CH[grp];   // Segment 미인식(E-com·Military 등)이면 Group으로 폴백
      const acKey = _OFF_TR_AC_MAP[grp];
      if (!chKey || !acKey) { skipped++; continue; }  // On-Trade 지역 행 등은 여기서 스킵
      const sku = normalizeOffSku(skuRaw, acKey);     // 계정 한정 규칙이 있으므로 acKey 확정 후 정규화
      let mi = -1, year = expectedYear || 2026;
      if (cDate >= 0) {
        const dCell = sh[XLSX.utils.encode_cell({ r: R, c: cDate })];
        if (dCell) {
          if (dCell.t === 'n') { const d = XLSX.SSF.parse_date_code(dCell.v); if (d) { year = d.y; mi = d.m - 1; } }
          else if (dCell.t === 'd') { const nd = _offNormDate(dCell.v); year = nd.getUTCFullYear(); mi = nd.getUTCMonth(); }
        }
      }
      if (mi < 0 && cMon >= 0) {
        const mCell = sh[XLSX.utils.encode_cell({ r: R, c: cMon })];
        if (mCell) {
          if (mCell.t === 'n') {
            if (mCell.v >= 1 && mCell.v <= 12) { mi = Math.floor(mCell.v) - 1; }
            else { const d = XLSX.SSF.parse_date_code(mCell.v); if (d) { year = d.y; mi = d.m - 1; } }
          } else if (typeof mCell.v === 'string') {
            const s = mCell.v.toString().trim();
            const km = s.match(/^(\d{1,2})\s*월/);
            if (km) { mi = parseInt(km[1], 10) - 1; }
            else {
              const monAbbr = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
              const idx = monAbbr.indexOf(s.slice(0, 3).toLowerCase());
              if (idx >= 0) mi = idx;
            }
          }
        }
      }
      yearSeen.add(year);
      if (mi < 0) { skipped++; continue; }
      if (expectedYear && year !== expectedYear) { continue; }
      yearMatched++;
      const hlN = _offCellNum(sh[XLSX.utils.encode_cell({ r: R, c: cHl })]);
      const qtN = cQty >= 0 ? _offCellNum(sh[XLSX.utils.encode_cell({ r: R, c: cQty })]) : 0;
      const nvN = cNsv >= 0 ? _offCellNum(sh[XLSX.utils.encode_cell({ r: R, c: cNsv })]) : 0;
      const k = chKey + '|' + acKey + '|' + sku;   // sku는 normalizeOffSku로 이미 trim·별칭 처리됨
      if (!aggHl[k]) { aggHl[k] = Array(12).fill(0); aggQt[k] = Array(12).fill(0); aggNv[k] = Array(12).fill(0); }
      aggHl[k][mi] += hlN;
      aggQt[k][mi] += qtN;
      aggNv[k][mi] += nvN;
      monthsSeen.add(mi);
    }
    const months = [...monthsSeen].sort((a, b) => a - b);
    console.log('[OffIngest DSR] 총 ' + total + '행 / 매칭 ' + yearMatched + '행 (연도 ' + expectedYear + ') / 무시 ' + skipped + '행 / 조합 ' + Object.keys(aggHl).length + ' / 커버월(0-based) [' + months.join(',') + '] / 감지 연도 [' + [...yearSeen].join(',') + ']');
    return { HL: aggHl, Qty: aggQt, NSV: aggNv, total, matched: yearMatched, skipped, year: expectedYear, months };
  }

  // 집계 결과(res)를 Off rows 배열에 **월 단위 병합**(mutate). isLy → ly_*, else act_*.
  // res.months(업로드가 커버한 월)만 덮어쓰고 나머지 월은 보존 → 증분(최신월만) 업로드 지원.
  // 반환 {rows, updated, added, actual_months(26Y만 계산, ly면 null), months}.
  function applyDsrToRows(rows, res, isLy) {
    const z = () => Array(12).fill(0);
    // res.months 미제공(undefined)이면 전체 12개월. 빈 배열([])이면 "해당 연도 데이터 없음" → 아무것도 건드리지 않음(베이스라인 보존).
    const months = (res.months === undefined) ? Array.from({ length: 12 }, (_, i) => i) : res.months;
    const hlF = isLy ? 'ly_hl_m' : 'act_hl_m';
    const qF  = isLy ? 'ly_q_m'  : 'act_q_m';
    const nF  = isLy ? 'ly_nsv_m' : 'act_nsv_m';
    const aliasF = isLy ? 'ly_m' : 'act_m';
    let updated = 0, added = 0;
    if (months.length) {
      // 1. 대상 월만 0으로 초기화(그 월 무판매 SKU가 0이 되도록) — 나머지 월은 그대로 보존
      const rowByKey = {};
      for (const r of rows) {
        if (!r[hlF]) r[hlF] = z();
        if (!r[qF])  r[qF]  = z();
        if (!r[nF])  r[nF]  = z();
        for (const mi of months) { r[hlF][mi] = 0; r[qF][mi] = 0; r[nF][mi] = 0; }
        rowByKey[r.ch + '|' + r.acct + '|' + r.sku] = r;
      }
      // 2. 집계값을 대상 월에 반영 (없는 조합은 신규 row 생성)
      for (const k of Object.keys(res.HL)) {
        let r = rowByKey[k];
        if (!r) {
          const p = k.split('|');
          r = { ch: p[0], acct: p[1], brand: '', sku: p[2], ap_m: z(), rofo_m: z(),
                ly_hl_m: z(), ly_q_m: z(), ly_nsv_m: z(), act_hl_m: z(), act_q_m: z(), act_nsv_m: z(), ly_m: z(), act_m: z() };
          rows.push(r); rowByKey[k] = r; added++;
        } else updated++;
        for (const mi of months) { r[hlF][mi] = res.HL[k][mi]; r[qF][mi] = res.Qty[k][mi]; r[nF][mi] = res.NSV[k][mi]; }
      }
      // 3. 별칭(act_m/ly_m) = *_hl_m 동기화
      for (const r of rows) r[aliasF] = r[hlF];
    }
    // 4. actual_months = act_hl_m 전 월에서 마지막 비영 월 (베이스라인+신규 모두 반영, 26Y만)
    let actual_months = null;
    if (!isLy) {
      actual_months = 0;
      for (let i = 0; i < 12; i++) {
        let s = 0; for (const r of rows) s += (r.act_hl_m && r.act_hl_m[i]) || 0;
        if (s > 0.01) actual_months = i + 1;
      }
    }
    return { rows, updated, added, actual_months, months };
  }

  // ── P07 "01. 2026 Volume" RoFo 파서 ──────────────────────────────────
  // 시트 2026RF07: Team/Channel/Brand/SKU(FCST) + Jan~Dec(HL). block1(Jan열~)만 HL.
  // 반환 { offChannel:{offKey:[12]}, onTotal:[12] }. 소계/합계행·비대상 Team 제외.
  const _VOL_CH_MAP = { 'CVS':'CVS','Hyper':'HYPER','Cash & Carry':'C&C','Cash&Carry':'C&C','Union Shop':'UNION','CLSM':'SM','ALSM':'ALSM',
    // Off 미합산 별도 채널 — team=E-comm/DF 안에서 Channel 컬럼 기준으로 분리(E-comm→E-com, DF→DF, Military→Military).
    'E-comm':'E-com', 'DF':'DF', 'Military':'Military' };
  function parseVolumeRofo(wb, sheetName) {
    // 시트 자동탐지: 매월 P0X마다 시트명이 2026RF07/2026RF08…로 바뀌므로 하드코딩하지 않고
    // '<YYYY>RF<NN>' 패턴 중 가장 높은 번호(=최신 P0X)를 고른다. sheetName 명시 시 그것을 우선.
    let sn = sheetName;
    if (!sn) {
      const rfSheets = wb.SheetNames.filter(n => /^\s*\d{4}RF\d+\s*$/i.test(n));
      if (rfSheets.length) {
        rfSheets.sort((a, b) => (parseInt((b.match(/RF(\d+)/i) || [])[1] || 0, 10))
                              - (parseInt((a.match(/RF(\d+)/i) || [])[1] || 0, 10)));
        sn = rfSheets[0].trim();
      } else {
        sn = '2026RF07';   // 폴백
      }
    }
    const sh = wb.Sheets[sn];
    if (!sh) throw new Error("'" + sn + "' 시트 없음 (P0X Volume 파일 확인) · 시트목록[" + wb.SheetNames.join(', ') + "]");
    // RF번호 = P0X 기간 = forecast 시작월(P08 → 8). Rofo 시트가 과거월을 덮지 않도록 쓸 기준.
    const rfPeriod = parseInt((String(sn).match(/RF(\d+)/i) || [])[1], 10) || null;
    const range = XLSX.utils.decode_range(sh['!ref']);
    // 헤더 행 탐색: Team/Channel/Jan 이 있는 행
    let hr = -1, cTeam, cCh, cBrand, cSku, cJan;
    for (let r = range.s.r; r <= Math.min(range.s.r + 15, range.e.r); r++) {
      const map = {};
      for (let c = range.s.c; c <= range.e.c; c++) {
        const v = sh[XLSX.utils.encode_cell({ r, c })];
        if (v && v.v != null) { const kk = String(v.v).trim(); if (map[kk] == null) map[kk] = c; }  // 첫 occurrence 유지(Jan~Dec가 HL/변동분 2번 나옴 → HL block 선택)
      }
      if (map['Team'] != null && map['Channel'] != null && map['Jan'] != null) {
        hr = r; cTeam = map['Team']; cCh = map['Channel']; cBrand = map['Brand']; cSku = map['SKU(FCST)']; cJan = map['Jan']; break;
      }
    }
    if (hr < 0) throw new Error('헤더(Team/Channel/Jan) 못 찾음');
    const z = () => Array(12).fill(0);
    const gs = (r, c) => _offCellStr(sh[XLSX.utils.encode_cell({ r, c })]);
    const gn = (r, c) => _offCellNum(sh[XLSX.utils.encode_cell({ r, c })]);
    const offChannel = {}; const onTotal = z(); const onSku = {}; const onSkuBrand = {};
    const unmappedOff = new Set(); const otherTeam = new Set();   // 진단: 미매핑 OFF 채널 / ON·OFF 아닌 team|채널
    let offRows = 0, onRows = 0;
    for (let r = hr + 1; r <= range.e.r; r++) {
      const team = gs(r, cTeam), ch = gs(r, cCh);
      const brand = cBrand != null ? gs(r, cBrand) : '';
      const sku = cSku != null ? normalizeOffSku(gs(r, cSku)) : '';
      if (!sku || sku === '0') continue;
      if (!brand || brand === 'TOTAL' || brand === 'Brand') continue;    // 합계/헤더행 제외
      if (ch && /total/i.test(ch)) continue;                              // "CVS Total" 등 소계 제외
      if (team === 'OFF' || team === 'E-comm' || team === 'DF') {   // 별도팀도 Channel 기준으로 분리(E-comm→E-com, DF→DF, Military→Military)
        const key = _VOL_CH_MAP[ch]; if (!key) { unmappedOff.add(team + '|' + (ch || '(빈채널)')); continue; }
        if (!offChannel[key]) offChannel[key] = z();
        for (let m = 0; m < 12; m++) offChannel[key][m] += gn(r, cJan + m);
        offRows++;
      } else if (team === 'ON') {
        if (!onSku[sku]) { onSku[sku] = z(); onSkuBrand[sku] = brand; }
        for (let m = 0; m < 12; m++) { const v = gn(r, cJan + m); onTotal[m] += v; onSku[sku][m] += v; }
        onRows++;
      } else if (ch) {
        otherTeam.add((team || '(빈team)') + '|' + ch);   // ON/OFF 아닌 team의 채널 행(E-com/Military 후보)
      }
    }
    console.log('[OffIngest Volume] 시트 ' + sn + ' / OFF ' + offRows + '행(' + Object.keys(offChannel).join(',') + ') / ON ' + onRows + '행(SKU ' + Object.keys(onSku).length + ') / 미매핑OFF[' + [...unmappedOff].join(',') + '] / 기타team[' + [...otherTeam].join(',') + ']');
    return { offChannel, onTotal, onSku, onSkuBrand, rfPeriod, unmappedOff: [...unmappedOff], otherTeam: [...otherTeam] };
  }

  // ── Order Pattern 재집계: DSR 라인아이템 → weekly_acct[ch][acct][월][주5], daily_acct[ch][acct][월][일] (HL) ──
  //  Date 컬럼 기준. expectedYear만 집계. 반환 { weekly_acct, daily_acct, months, year }.
  function parseDsrOrderPattern(wb, expectedYear) {
    const sh = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(sh['!ref']);
    const cSeg  = _offFindColByHeader(sh, range, 'Segment');
    const cGrp  = _offFindColByHeader(sh, range, 'Group');
    const cDate = _offFindColByHeader(sh, range, 'Date');
    const cHl   = _offFindColByHeader(sh, range, 'HL', 'Volume in Hectolitre');   // 원본 raw 헤더 별칭
    if (cGrp < 0 || cHl < 0 || cDate < 0) {   // Date 없으면 주/일별 집계 불가
      console.warn('[OffIngest OrderPattern] Date/Group/HL 컬럼 누락 → 스킵 (Group=' + cGrp + ' HL=' + cHl + ' Date=' + cDate + ')');
      return { weekly_acct: {}, daily_acct: {}, months: [], year: expectedYear };
    }
    const weekly = {}, daily = {};
    const monthsSeen = new Set();
    const _dim = (y, m) => new Date(y, m + 1, 0).getDate();
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const seg = cSeg >= 0 ? _offCellStr(sh[XLSX.utils.encode_cell({ r: R, c: cSeg })]) : null;
      const grp = _offCellStr(sh[XLSX.utils.encode_cell({ r: R, c: cGrp })]);
      if (!grp) continue;
      const chKey = (seg && _OFF_TR_CH_MAP[seg]) || _OFF_GRP_CH[grp];   // Segment 미인식(E-com·Military 등)이면 Group으로 폴백
      const acKey = _OFF_TR_AC_MAP[grp];
      if (!chKey || !acKey) continue;   // On-Trade 지역 행 등 자동 스킵
      const dCell = sh[XLSX.utils.encode_cell({ r: R, c: cDate })];
      if (!dCell) continue;
      let year, mi = -1, day = -1;
      if (dCell.t === 'n') { const d = XLSX.SSF.parse_date_code(dCell.v); if (d) { year = d.y; mi = d.m - 1; day = d.d; } }
      else if (dCell.t === 'd') { const nd = _offNormDate(dCell.v); year = nd.getUTCFullYear(); mi = nd.getUTCMonth(); day = nd.getUTCDate(); }
      if (mi < 0 || day < 1) continue;
      if (expectedYear && year !== expectedYear) continue;
      const hlN = _offCellNum(sh[XLSX.utils.encode_cell({ r: R, c: cHl })]);
      if (!hlN) continue;
      const wk = Math.min(Math.max(Math.ceil(day / 7) - 1, 0), 4);   // 0-based, 5주 (1~7일→W1 …)
      if (!weekly[chKey]) weekly[chKey] = {};
      if (!weekly[chKey][acKey]) weekly[chKey][acKey] = Array.from({ length: 12 }, () => [0, 0, 0, 0, 0]);
      weekly[chKey][acKey][mi][wk] += hlN;
      if (!daily[chKey]) daily[chKey] = {};
      if (!daily[chKey][acKey]) daily[chKey][acKey] = Array.from({ length: 12 }, () => []);
      const arr = daily[chKey][acKey][mi];
      const dim = _dim(year, mi);
      while (arr.length < dim) arr.push(0);
      arr[day - 1] = (arr[day - 1] || 0) + hlN;
      monthsSeen.add(mi);
    }
    const months = [...monthsSeen].sort((a, b) => a - b);
    console.log('[OffIngest OrderPattern] 연도 ' + expectedYear + ' / 커버월(0-based) [' + months.join(',') + '] / 채널 ' + Object.keys(weekly).join(','));
    return { weekly_acct: weekly, daily_acct: daily, months, year: expectedYear };
  }

  // Order Pattern 결과를 기존 pattern에 **월 단위 병합**(mutate). res.months만 덮어쓰고 나머지 월 보존(증분).
  //  대상 월은 기존 전 계정 0으로 초기화 후 새 값 반영 → 그 달 무주문 계정도 0이 됨(applyDsrToRows와 동일 규칙).
  function applyOrderPatternToPattern(pattern, res) {
    if (!pattern.weekly_acct || typeof pattern.weekly_acct !== 'object') pattern.weekly_acct = {};
    if (!pattern.daily_acct  || typeof pattern.daily_acct  !== 'object') pattern.daily_acct  = {};
    const months = res.months || [];
    if (!months.length) return { months: [] };
    const year = res.year || 2026;
    const _dim = (m) => new Date(year, m + 1, 0).getDate();
    // 1) 대상 월 zero-out (기존 모든 계정)
    for (const ch in pattern.weekly_acct)
      for (const ac in pattern.weekly_acct[ch]) {
        const wa = pattern.weekly_acct[ch][ac]; if (!Array.isArray(wa)) continue;
        for (const mi of months) wa[mi] = [0, 0, 0, 0, 0];
      }
    for (const ch in pattern.daily_acct)
      for (const ac in pattern.daily_acct[ch]) {
        const da = pattern.daily_acct[ch][ac]; if (!Array.isArray(da)) continue;
        for (const mi of months) da[mi] = Array(_dim(mi)).fill(0);
      }
    // 2) 새 값 반영 (없던 조합은 신규 생성)
    for (const ch in res.weekly_acct) {
      if (!pattern.weekly_acct[ch]) pattern.weekly_acct[ch] = {};
      for (const ac in res.weekly_acct[ch]) {
        if (!Array.isArray(pattern.weekly_acct[ch][ac])) pattern.weekly_acct[ch][ac] = Array.from({ length: 12 }, () => [0, 0, 0, 0, 0]);
        for (const mi of months) pattern.weekly_acct[ch][ac][mi] = res.weekly_acct[ch][ac][mi];
      }
    }
    for (const ch in res.daily_acct) {
      if (!pattern.daily_acct[ch]) pattern.daily_acct[ch] = {};
      for (const ac in res.daily_acct[ch]) {
        if (!Array.isArray(pattern.daily_acct[ch][ac])) pattern.daily_acct[ch][ac] = Array.from({ length: 12 }, () => []);
        for (const mi of months) pattern.daily_acct[ch][ac][mi] = res.daily_acct[ch][ac][mi];
      }
    }
    return { months };
  }

  global.OffIngest = {
    parseDsrWorkbook, applyDsrToRows, parseVolumeRofo,
    parseDsrOrderPattern, applyOrderPatternToPattern,
    normalizeOffSku,
    _OFF_TR_CH_MAP, _OFF_TR_AC_MAP, _OFF_GRP_CH, _VOL_CH_MAP, _OFF_SKU_ALIAS, _OFF_SKU_ALIAS_BY_ACCT,
    _offFindColByHeader, _offCellStr, _offCellNum
  };
})(typeof window !== 'undefined' ? window : this);
