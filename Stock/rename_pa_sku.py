# -*- coding: utf-8 -*-
"""Off 스냅샷의 구(舊) 파울라너 FCST SKU명을 현행명으로 개명·병합.

  PA ORI 500 Can -> PA WHE 500 Can   (바이스비어)
  PA XXX 500 Can -> PA HEL 500 Can   (헬 뮌헨 라거)

6월 FCST 양식이 구명을 써서 '실적=신규명 / FCST=구명'으로 행이 갈라졌고,
그 결과 파울라너 FCST가 대시보드에서 누락됐다. 같은 (채널, 거래처)면 한 행으로 합친다.

사용:  python rename_pa_sku.py          (검증만, dry-run)
       python rename_pa_sku.py --apply  (Supabase 반영)
"""
import json, os, sys, copy, collections, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUP = os.path.join(HERE, "backup", "off_snapshot_before_PA_rename.json")
SB = "https://elqammnozbfhkitnncsz.supabase.co/rest/v1/off_dashboard_snapshots"
KEY = "sb_publishable_WTQJ-31cuRjF21E2lbrdhA__8pzucpd"
RENAME = {"PA ORI 500 Can": "PA WHE 500 Can",
          "PA XXX 500 Can": "PA HEL 500 Can",
          "PA ORI 20000 Keg": "PA WHE 20000 Keg"}
KEYS = ("ch", "acct", "sku")


def hdr(extra=None):
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
    h.update(extra or {})
    return h


def fetch():
    r = urllib.request.Request(SB + "?select=data,updated_at&id=eq.1", headers=hdr())
    return json.load(urllib.request.urlopen(r, timeout=120))[0]


def unwrap(v):
    return v["value"] if isinstance(v, dict) and "value" in v else v


def rewrap(orig, arr):
    if isinstance(orig, dict) and "value" in orig:
        o = dict(orig)
        o["value"] = arr
        return o
    return arr


def add(dst, src):
    """dst 행에 src 행의 월별 배열을 원소별로 더한다 (구조는 dst 유지)."""
    for k in set(dst) | set(src):
        if k in KEYS or k == "brand":
            continue
        a, b = unwrap(dst.get(k)), unwrap(src.get(k))
        if not isinstance(a, list) and not isinstance(b, list):
            continue
        a = a or [0] * 12
        b = b or [0] * 12
        n = max(len(a), len(b))
        merged = [(a[i] if i < len(a) and a[i] else 0) + (b[i] if i < len(b) and b[i] else 0)
                  for i in range(n)]
        dst[k] = rewrap(dst.get(k), merged)
    return dst


def total(rows, sku, field, idx=6):
    return sum((unwrap(r.get(field)) or [0] * 12)[idx] or 0 for r in rows if r["sku"] == sku)


def main():
    apply = "--apply" in sys.argv
    cur = fetch()
    if not os.path.exists(BACKUP):
        os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
        json.dump(cur, open(BACKUP, "w", encoding="utf-8"), ensure_ascii=False)
        print("백업 생성:", BACKUP)

    data = copy.deepcopy(cur["data"])
    rows = data["rows"]
    before = {s: (total(rows, s, "fcst_m"), total(rows, s, "act_hl_m"))
              for s in ["PA WHE 500 Can", "PA HEL 500 Can", "PA ORI 500 Can", "PA XXX 500 Can"]}

    idx = {(r["ch"], r["acct"], r["sku"]): r for r in rows}
    out, merged, renamed = [], 0, 0
    for r in rows:
        new = RENAME.get(r["sku"])
        if not new:
            out.append(r)
            continue
        tgt = idx.get((r["ch"], r["acct"], new))
        if tgt is not None and tgt is not r:
            add(tgt, r)                      # 기존 행에 흡수
            merged += 1
        else:
            r["sku"] = new                   # 대상 행이 없으면 이름만 교체
            idx[(r["ch"], r["acct"], new)] = r
            out.append(r)
            renamed += 1
    data["rows"] = out

    print("\n행 처리: 병합 %d / 단순개명 %d / 최종 행수 %d (이전 %d)" %
          (merged, renamed, len(out), len(rows)))
    print("\n%-18s %12s %12s   %12s %12s" % ("SKU", "fcst7 이전", "fcst7 이후", "act7 이전", "act7 이후"))
    ok = True
    for s in ["PA WHE 500 Can", "PA HEL 500 Can", "PA ORI 500 Can", "PA XXX 500 Can"]:
        a = (total(out, s, "fcst_m"), total(out, s, "act_hl_m"))
        print("%-18s %12.1f %12.1f   %12.1f %12.1f" % (s, before[s][0], a[0], before[s][1], a[1]))
    tb = sum(v[0] for v in before.values())
    ta = sum(total(out, s, "fcst_m") for s in
             ["PA WHE 500 Can", "PA HEL 500 Can", "PA ORI 500 Can", "PA XXX 500 Can"])
    print("\n합계 보존 검증  fcst7: %.4f -> %.4f  %s" % (tb, ta, "OK" if abs(tb - ta) < 1e-6 else "!! 불일치"))
    ok = abs(tb - ta) < 1e-6
    for f in ["ap_m", "rofo_m", "ly_hl_m", "act_hl_m", "act_q_m", "act_nsv_m", "ly_nsv_m"]:
        b = sum(sum(x or 0 for x in (unwrap(r.get(f)) or [])) for r in rows)
        a = sum(sum(x or 0 for x in (unwrap(r.get(f)) or [])) for r in out)
        s = "OK" if abs(b - a) < 1e-6 else "!! 불일치"
        if s != "OK":
            ok = False
        print("  전체 %-10s %18.4f -> %18.4f  %s" % (f, b, a, s))

    if not ok:
        print("\n검증 실패 — 반영하지 않음")
        return
    if not apply:
        print("\n[dry-run] 반영하려면 --apply")
        return

    body = json.dumps({"data": data}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SB + "?id=eq.1", data=body, method="PATCH",
                                 headers=hdr({"Prefer": "return=minimal"}))
    urllib.request.urlopen(req, timeout=180)
    chk = fetch()
    n = sum(1 for r in chk["data"]["rows"] if r["sku"] in RENAME)
    print("\n반영 완료. 재조회 행수 %d, 잔존 구명 행 %d" % (len(chk["data"]["rows"]), n))
    print("PA WHE fcst7 = %.1f / PA HEL fcst7 = %.1f" %
          (total(chk["data"]["rows"], "PA WHE 500 Can", "fcst_m"),
           total(chk["data"]["rows"], "PA HEL 500 Can", "fcst_m")))


if __name__ == "__main__":
    main()
