# -*- coding: utf-8 -*-
"""Daily stock 제품코드 -> 대시보드 SKU 코드 매핑 생성 + 검증.
단위: QTY = 케이스(CS). hl = 케이스당 HL (= units_per_case * ml / 100000).
"""
import json, os, sys, collections
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# code: (sku, units_per_case, ml, note)
# note: EXPORT=국내 가용재고 제외, NEW=대시보드에 없는 신규 SKU, CHECK=코드 확인 필요
M = {
    # ---------- OFF ----------
    122228: ("HE ORI 5000 Keg",   2, 5000, ""),
    152604: ("HE ORI 5000 Keg",   2, 5000, ""),
    511526: ("HE ORI 5000 Keg",   2, 5000, ""),
    124242: ("HE ORI 710 Can",   12,  710, ""),
    512519: ("HE ORI 500 Can",   24,  500, ""),
    512568: ("HE ORI 500 Can",   24,  500, ""),
    512869: ("HE ORI 500 Can",   24,  500, ""),
    512906: ("HE ORI 500 Can",   24,  500, ""),
    512272: ("HE ORI 330 Can",   24,  330, ""),
    512469: ("HE ORI 330 Can",   24,  330, ""),
    124572: ("HE 0.0 500 Can",   24,  500, ""),
    512687: ("HE 0.0 500 Can",   24,  500, ""),
    124544: ("HE 0.0 330 Can",   24,  330, ""),
    512270: ("HE 0.0 330 Can",   24,  330, ""),
    124955: ("HE SLV 500 Can",   24,  500, ""),
    124950: ("HE SLV 330 Can",   24,  330, ""),
    512433: ("HE SLV 250 Can",   24,  250, ""),
    512694: ("HE SLV 250 Can",   24,  250, ""),
    125377: ("TI ORI 500 Can",   24,  500, ""),
    511994: ("TI ORI 500 Can",   24,  500, ""),
    123417: ("TI ORI 330 Can",   24,  330, ""),
    152576: ("TI RAD 500 Can",   24,  500, ""),
    511100: ("TI RAD 500 Can",   24,  500, ""),
    152917: ("TI RAD 330 Can",   24,  330, ""),
    512871: ("TI RAD 330 Can",   24,  330, ""),         # 베트남 생산 전환분(EXKR=한국향) — 수출 아님
    152916: ("TI RGR 500 Can",   24,  500, ""),         # 자몽
    511588: ("TI PML 500 Can",   24,  500, ""),         # 포멜로
    124662: ("ED WHE 500 Can",   24,  500, ""),
    512357: ("BI ORI 440 Can",   24,  440, ""),
    512430: ("SU ORI 500 Can",   24,  500, ""),
    512814: ("SU ORI 1000 Can",   6, 1000, "NEW"),
    512886: ("SU ORI 618 Can",   12,  618, "NEW"),
    512696: ("PA HEL 500 Can",   24,  500, ""),
    512916: ("PA HEL 500 Can",   24,  500, ""),
    512700: ("PA WHE 500 Can",   24,  500, ""),
    512699: ("PA WHE 500 Can",   24,  500, ""),
    512904: ("PA WHE 500 Can",   24,  500, ""),
    512853: ("PA 0.0 500 Can",   24,  500, "NEW"),      # 파울라너 바이스비어 0,0 (무알콜)
    #  ※ PA XXX 500 Can은 일반 헬(PA HEL)의 구명이라 여기 쓰면 무알콜이 일반에 합산된다
    # ---------- ON ----------
    121916: ("HE ORI 330 Bottle", 24,  330, ""),
    511990: ("HE ORI 330 Bottle", 24,  330, ""),        # 가정용 전환분
    122536: ("HE ORI 8000 Blade",  1, 8000, ""),
    511128: ("HE ORI 20000 Air Keg", 1, 20000, ""),
    124548: ("HE 0.0 330 Bottle", 24,  330, ""),
    124954: ("HE SLV 330 Bottle", 24,  330, ""),
    152577: ("TI ORI 640 Bottle", 12,  640, ""),
    152643: ("TI ORI 640 Bottle", 12,  640, ""),
    511621: ("TI ORI 330 Bottle", 24,  330, ""),
    511815: ("TI ORI 330 Bottle", 24,  330, ""),
    512044: ("BI ORI 330 Bottle", 24,  330, ""),
    512724: ("BI ORI 330 Bottle", 24,  330, ""),
    512491: ("SU ORI 500 Bottle", 12,  500, ""),
    512493: ("SU ORI 500 Bottle", 12,  500, ""),
    512588: ("DE ORI 330 Bottle", 24,  330, ""),
    512845: ("DE ORI 330 Bottle", 24,  330, ""),
    512701: ("PA WHE 20000 Keg",   1, 20000, ""),
}


def load_stock():
    wb = openpyxl.load_workbook(os.path.join(HERE, "Daily stock 07.21.xlsx"), data_only=True)
    return list(wb["Sheet1"].iter_rows(values_only=True))[1:]


def dashboard_factors():
    """대시보드 SKU -> hl_factor (검증용)."""
    f = {}
    p = os.path.join(ROOT, "sku_On_Trade_Total.json")
    for b in json.load(open(p, encoding="utf-8")):
        for s in b.get("skus", []):
            hf = s["data"].get("hl_factor")
            if hf:
                f[s["sku"]] = hf
    s = open(os.path.join(ROOT, "Off", "off_seed.js"), encoding="utf-8").read()
    off = json.loads(s[s.index("=") + 1:].strip().rstrip(";"))
    for r in off["rows"]:
        hl = r.get("act_hl_m", {}).get("value") or []
        q = r.get("act_q_m", {}).get("value") or []
        tot_hl = sum(x or 0 for x in hl)
        tot_q = sum(x or 0 for x in q)
        if tot_q and r["sku"] not in f:
            f[r["sku"]] = round(tot_hl / tot_q, 6)
    return f


def main():
    rows = load_stock()
    names, ch = {}, {}
    qty = collections.Counter()
    for r in rows:
        names[r[1]] = r[2]
        ch[r[1]] = r[0]
        qty[r[1]] += r[5]

    missing = [c for c in qty if c not in M]
    if missing:
        print("!! 매핑 누락:", [(c, names[c]) for c in missing])

    fac = dashboard_factors()
    out = {}
    warn = []
    for code, (sku, upc, ml, note) in M.items():
        hl = round(upc * ml / 100000.0, 6)
        d = fac.get(sku)
        if d and abs(d - hl) > 0.0005:
            warn.append("%s %s: 계산 %.4f vs 대시보드 %.4f" % (code, sku, hl, d))
        out[str(code)] = {
            "name": names.get(code, ""),
            "channel": ch.get(code, ""),
            "sku": sku,
            "units_per_case": upc,
            "ml": ml,
            "hl_per_case": hl,
            "in_dashboard": sku in fac,
            "note": note,
        }

    print("\n=== HL 계수 불일치 ===")
    print("\n".join(warn) if warn else "(없음) 전 SKU 일치")

    nd = sorted({v["sku"] for v in out.values() if not v["in_dashboard"]})
    print("\n=== 대시보드에 없는 SKU ===\n" + ("\n".join(nd) if nd else "(없음)"))

    unused = sorted(set(fac) - {v["sku"] for v in out.values()})
    print("\n=== 대시보드에만 있고 재고 0인 SKU ===\n" + "\n".join(unused))

    tot = sum(qty.values())
    exp = sum(qty[int(c)] for c, v in out.items() if v["note"] == "EXPORT")
    print("\n총 QTY %d CS / 매핑 %d SKU-code / 수출제외 %d CS" % (tot, len(out), exp))
    print("총 HL %.1f" % sum(qty[int(c)] * v["hl_per_case"] for c, v in out.items()))

    p = os.path.join(HERE, "sku_map.json")
    json.dump(out, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("saved ->", p)


if __name__ == "__main__":
    main()
