# -*- coding: utf-8 -*-
"""통합 수급(Supply vs Demand) 엔진.

원칙: 채널별로 보지 않고 SKU 단위로 재고를 풀링해서
      "지금 재고로 이번달/다음달 수요를 맞출 수 있나"만 본다.

수요 = max(당월 FCST, MTD run-rate)   <- 보수적으로 큰 쪽 (쇼트 방지 목적)
단위 = QTY(물리 단위) 로 통일. c/s(=HL/0.0792)와 혼용 금지 — 20L 케그 1QTY = 2.525 c/s.
공급 = 가용재고 = 잔여 유통기한 >= SHELF_MIN[규격]
                & 출고보류/비매품/시음주/쉬링크/수출향 제외
"""
import json, os, datetime, collections, urllib.request
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")

TODAY = datetime.date(2026, 7, 21)
MONTH = 7                      # 당월 (1-based)
DAYS_IN_MONTH = 31
ELAPSED = TODAY.day            # 경과일
# 출고 가능 최소 잔여 유통기한. 재고파일의 주요판매채널(제품 규격) 기준.
#   OFF(캔/유통용) = 180일  <- CVS 6개월 룰. 채널별 세분화는 추후 업데이트 예정
#   ON (병/생/케그) = 90일   <- 3개월
SHELF_MIN = {"OFF": 180, "ON": 90}
# 유통기한 출고룰 면제 SKU — 특수 SKU(채널 전용 에디션·대용량)라 일반 룰을 적용하지 않는다.
SHELF_EXEMPT = {"SU ORI 1000 Can",    # 설화 6x1L 캔
                "SU ORI 618 Can"}     # 설화 12x618ml GS25 Edition
# 재고를 별도 운영해 데일리스탁에 안 잡히는 채널 (면세만 별도, E-com·Military는 같은 창고)
EXCL_CH = {"DF"}
CS_HL = 0.0792                 # c/s 환산 기준 (330ml x 24 = 0.0792 HL)
NON_SELLABLE = {"비매품", "시음주", "쉬링크", "출고보류", "유통기한임박"}
DELISTED = {"HE ORI 8000 Blade", "HE SLV 8000 Blade",
            "ED WHE 8000 Blade", "TI ORI 8000 Blade"}   # 8L Blade 단종
# Off 스냅샷의 구(舊) FCST 명칭 -> 현행 명칭
SKU_ALIAS = {"PA ORI 500 Can": "PA WHE 500 Can",
             "PA XXX 500 Can": "PA HEL 500 Can",
             "PA ORI 20000 Keg": "PA WHE 20000 Keg",
             "SU ORI 1000 Keg": "SU ORI 1000 Can"}   # 설화 케그 제품 없음 — 1L 캔 오적재
# 계정을 봐야 판정되는 오적재 (off_ingest.js _OFF_SKU_ALIAS_BY_ACCT와 동일 규칙)
SKU_ALIAS_ACCT = {"GS25": {"SU ORI 500 Bottle": "SU ORI 618 Can"}}   # 설화 618ml GS25 Edition


def _alias(sku, acct=None):
    return (SKU_ALIAS_ACCT.get(acct) or {}).get(sku) or SKU_ALIAS.get(sku, sku)

SB_URL = "https://elqammnozbfhkitnncsz.supabase.co/rest/v1/"
SB_KEY = "sb_publishable_WTQJ-31cuRjF21E2lbrdhA__8pzucpd"
MAP = json.load(open(os.path.join(HERE, "sku_map.json"), encoding="utf-8"))
HLF = {v["sku"]: v["hl_per_case"] for v in MAP.values()}
# 현재 재고 0이라 sku_map에 없지만 수요가 붙을 수 있는 SKU (HL->QTY 환산용)
HLF.update({"DE ORI 500 Can": 0.12, "ED PEZ 500 Can": 0.12, "TI MIX 500 Can": 0.12,
            "ED WHE 330 Bottle": 0.0792, "SU ORI 1000 Keg": 0.06})


def snap(table, fname):
    """Supabase 스냅샷 (로컬 캐시)."""
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, fname)
    if not os.path.exists(p):
        u = SB_URL + table + "?select=data,updated_at&id=eq.1"
        r = urllib.request.Request(u, headers={"apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY})
        json.dump(json.load(urllib.request.urlopen(r, timeout=120))[0],
                  open(p, "w", encoding="utf-8"), ensure_ascii=False)
    return json.load(open(p, encoding="utf-8"))


def _v(r, k):
    x = r.get(k)
    x = x["value"] if isinstance(x, dict) else x
    return x or [0] * 12


def supply():
    """SKU -> {total, avail, near(임박), blocked}  단위 QTY."""
    wb = openpyxl.load_workbook(os.path.join(HERE, "Daily stock 07.21.xlsx"), data_only=True)
    out = collections.defaultdict(lambda: collections.Counter())
    for r in list(wb["Sheet1"].iter_rows(values_only=True))[1:]:
        m = MAP[str(r[1])]
        sku, q = m["sku"], r[5]
        d = (datetime.date(*map(int, r[3].split("-"))) - TODAY).days
        o = out[sku]
        o["total"] += q
        if r[4] in NON_SELLABLE or m["note"] == "EXPORT":
            o["blocked"] += q
        elif sku not in SHELF_EXEMPT and d < SHELF_MIN[m["channel"]]:
            o["near"] += q
        else:
            o["avail"] += q
            o["min_days"] = min(o["min_days"], d) if o["min_days"] else d
    return out


def demand():
    """SKU -> {fcst, mtd, rr(run-rate), next(익월)}  단위 QTY.

    대시보드 SKU 레벨 값은 QTY, 브랜드/합계 레벨 값은 c/s(=HL/0.0792)라 섞으면 안 됨.
    Off는 HL로 저장돼 있어 hl_factor로 나눠 QTY로 환산한다.
    """
    out = collections.defaultdict(lambda: collections.Counter())
    i = MONTH - 1

    for b in snap("dashboard_snapshots", "on.json")["data"]["sku_detail"]["On Trade Total"]:
        for s in b.get("skus", []):
            d, o = s["data"], out[_alias(s["sku"])]
            o["fcst"] += max(d.get("this_week_fcst") or 0, 0)
            o["mtd"] += max(d.get("mtd") or 0, 0)
            o["next"] += max((d.get("rofo_monthly") or [0] * 12)[i + 1] or 0, 0)

    for r in snap("off_dashboard_snapshots", "off.json")["data"]["rows"]:
        if r.get("ch") in EXCL_CH:
            continue
        sku = _alias(r["sku"], r.get("acct"))
        f = HLF.get(sku)
        if not f:
            continue
        o = out[sku]
        o["fcst"] += max(_v(r, "fcst_m")[i] or 0, 0) / f
        o["mtd"] += max(_v(r, "act_q_m")[i] or 0, 0)
        o["next"] += max(_v(r, "rofo_m")[i + 1] or 0, 0) / f

    for sku, o in out.items():
        o["rr"] = o["mtd"] / ELAPSED * DAYS_IN_MONTH
        o["use"] = max(o["fcst"], o["rr"])        # 보수적 채택
    return out


def main():
    sup, dem = supply(), demand()
    rows = []
    for sku in sorted(set(sup) | set(dem)):
        if sku in DELISTED:
            continue
        s, d = sup.get(sku, collections.Counter()), dem.get(sku, collections.Counter())
        use = d["use"]
        rest = max(use - d["mtd"], 0)                       # 당월 잔여 수요
        daily = use / DAYS_IN_MONTH
        cover = s["avail"] / use if use else None           # 당월 기준 커버 개월
        after = s["avail"] - rest                           # 당월 채우고 남는 재고
        nxt = (after / d["next"]) if d["next"] else None    # 익월 커버율
        days = (s["avail"] / daily) if daily else None
        rows.append(dict(sku=sku, avail=s["avail"], near=s["near"], blocked=s["blocked"],
                         total=s["total"], fcst=d["fcst"], mtd=d["mtd"], rr=d["rr"],
                         use=use, rest=rest, cover=cover, after=after, nxt=nxt, days=days,
                         nextd=d["next"]))

    rows.sort(key=lambda r: (r["cover"] is None, r["cover"]))
    print("당월 %d월 / 기준일 %s (경과 %d/%d일)" % (MONTH, TODAY, ELAPSED, DAYS_IN_MONTH))
    print("단위: QTY = 물리 단위(케그 1통·캔 1박스). HL = QTY x hl_factor. c/s = HL / %.4f\n" % CS_HL)
    print("%-22s %9s %7s %9s %9s %9s %8s %7s %6s" %
          ("SKU", "가용(QTY)", "임박", "FCST", "런레이트", "채택수요", "잔여수요", "소진일", "커버"))
    for r in rows:
        print("%-22s %9d %7d %9.0f %9.0f %9.0f %8.0f %7s %6s" % (
            r["sku"], r["avail"], r["near"], r["fcst"], r["rr"], r["use"], r["rest"],
            ("%.0f일" % r["days"]) if r["days"] is not None else "-",
            ("%.2f" % r["cover"]) if r["cover"] is not None else "-"))

    print("\n" + "=" * 88)
    print("■ 당월(%d월) 내 쇼트 — 남은 수요 > 가용재고" % MONTH)
    print("  %-22s %10s %10s %10s %9s" % ("SKU", "부족(QTY)", "부족(HL)", "부족(c/s)", "가용(QTY)"))
    for r in rows:
        if r["rest"] > r["avail"]:
            gap, f = r["rest"] - r["avail"], HLF.get(r["sku"], 0)
            print("  %-22s %10.0f %10.1f %10.0f %9d" %
                  (r["sku"], gap, gap * f, gap * f / CS_HL, r["avail"]))

    print("\n■ 익월(%d월) 쇼트 예고 — 당월 채우고 남은 재고 < 익월 RoFo" % (MONTH + 1))
    print("  ※ 입고(수입 도착) 예정 미반영 — 재고 회전이 통상 1~1.5개월이라 광범위하게 잡힘. 순위만 참고")
    for r in rows:
        if r["nextd"] and r["after"] < r["nextd"]:
            gap, f = r["nextd"] - r["after"], HLF.get(r["sku"], 0)
            print("  %-22s 부족 %8.0f QTY (%7.1f HL)  커버 %.2f" %
                  (r["sku"], gap, gap * f, r["nxt"]))

    print("\n■ 런레이트가 FCST를 넘는 SKU (FCST 하향 = 쇼트 위험 은폐)")
    for r in rows:
        if r["fcst"] and r["rr"] > r["fcst"] * 1.1:
            print("  %-22s 런레이트 %.0f vs FCST %.0f (%.0f%%)" %
                  (r["sku"], r["rr"], r["fcst"], r["rr"] / r["fcst"] * 100))


if __name__ == "__main__":
    main()
