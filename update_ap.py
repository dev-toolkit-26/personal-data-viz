import json, openpyxl
from collections import defaultdict

EXCEL_PATH = "AP/ON AP 26 Target_Revenue 0313 (0.0 Ajd) (1).xlsx"
JSON_PATH  = "pl_detail.json"
HTML_PATH  = "index.html"
CONV       = 12.6263   # HL → cases

BRANCH_MAP = {
    "Total":    "TTL",
    "Seoul":    "Seoul",
    "Busan":    "Busan",
    "D&J":      "D&J",
    "Daejeon":  "Daejeon",
    "Gwangju":  "Gwangju",
}

BRANCH_MAP_REGIONAL = {
    "TTL":      "TTL",
    "Seoul":    "Seoul",
    "Busan":    "Busan",
    "D&J":      "DaeGu & JeJu",
    "Daejeon":  "DaeJeon",
    "Gwangju":  "GwangJu",
}

# sku_detail region key per branch
SKU_REGION_MAP = {
    "Seoul":    "Seoul",
    "Busan":    "BuSan",
    "D&J":      "DaeGu&JeJu",
    "Daejeon":  "DaeJeon",
    "Gwangju":  "GwangJu",
}

BRAND_MAP = {
    "Heineken":        "Heineken",
    "Heineken 0.0":    "Heineken 0.0",
    "Heineken Silver": "Heineken Silver",
    "Desperados":      "Desperados",
    "EdelWeiss":       "EdelWeiss",
    "Tiger":           "Tiger",
    "Tiger Radler":    "Tiger Radler",
    "Paulaner":        "Paulaner",
    "SULHWA":          "Snow",
    "Birra Moretti":   "BirraMoretti",
}

# Dashboard SKU name overrides (Excel name → Dashboard name)
SKU_RENAME = {
    "PA ORI 20000 Keg": "PA WHE 20000 Keg",
}

# ── 1. Excel 파싱 ────────────────────────────────────────────────
wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
ws = wb.worksheets[0]

# branch-level volume (for pl_detail, monthly_regional_ap, monthly.ap_2026, wk10_summary)
vol = {v: [0.0]*12 for v in BRANCH_MAP.values()}

# (branch, brand, sku) → monthly HL
sku_data = defaultdict(lambda: [0.0]*12)
# (branch, brand) → monthly HL  (brand total per branch)
brand_data = defaultdict(lambda: [0.0]*12)

for row in ws.iter_rows(min_row=3, values_only=True):
    branch_raw, brand_raw, sku_raw = row[1], row[2], row[3]
    if branch_raw not in BRANCH_MAP:
        continue
    branch = BRANCH_MAP[branch_raw]
    brand_key = BRAND_MAP.get(brand_raw)
    sku_key = SKU_RENAME.get(sku_raw, sku_raw)

    for m in range(12):
        val = row[4 + m]
        if isinstance(val, (int, float)):
            vol[branch][m] += val
            if brand_key:
                sku_data[(branch, brand_key, sku_key)][m] += val
                brand_data[(branch, brand_key)][m] += val

# Round branch volumes
for branch in vol:
    vol[branch] = [round(v, 4) for v in vol[branch]]
vol_fy = {b: round(sum(m), 4) for b, m in vol.items()}

# Compute "On Trade Total" as sum of non-TTL branches
OTT_BRANCHES = ["Seoul", "Busan", "D&J", "Daejeon", "Gwangju"]
brand_data_ott = defaultdict(lambda: [0.0]*12)
sku_data_ott   = defaultdict(lambda: [0.0]*12)
for branch in OTT_BRANCHES:
    b_key = branch
    for (br, brand, sku), monthly in sku_data.items():
        if br == b_key:
            for m in range(12):
                sku_data_ott[(brand, sku)][m] += monthly[m]
    for (br, brand), monthly in brand_data.items():
        if br == b_key:
            for m in range(12):
                brand_data_ott[brand][m] += monthly[m]

print("── 새 AP Volume (HL) ──")
for b in ["TTL", "Seoul", "Busan", "D&J", "Daejeon", "Gwangju"]:
    print(f"  {b}: FY={vol_fy[b]:,.1f}  Mar={vol[b][2]:.2f}")

# ── 2. pl_detail.json 업데이트 ───────────────────────────────────
with open(JSON_PATH, encoding="utf-8") as f:
    data = json.load(f)

for b in BRANCH_MAP.values():
    data["branches"][b]["ap"]["Volume"]["monthly"] = vol[b]
    data["branches"][b]["ap"]["Volume"]["fy"]      = vol_fy[b]

with open(JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

print("\npl_detail.json 업데이트 완료")

# ── 3. index.html 업데이트 ──────────────────────────────────────
with open(HTML_PATH, encoding="utf-8") as f:
    html = f.read()

marker_pos = html.index("/*D*/")
start = html.index("{", marker_pos)
depth = 0
end = start
for i, c in enumerate(html[start:], start):
    if c == "{":
        depth += 1
    elif c == "}":
        depth -= 1
        if depth == 0:
            end = i
            break

dashboard = json.loads(html[start:end + 1])

# ── 3a. revenue.pl_detail Volume AP ─────────────────────────────
for b in BRANCH_MAP.values():
    dashboard["revenue"]["pl_detail"]["branches"][b]["ap"]["Volume"]["monthly"] = vol[b]
    dashboard["revenue"]["pl_detail"]["branches"][b]["ap"]["Volume"]["fy"]      = vol_fy[b]

# ── 3b. monthly_regional_ap ──────────────────────────────────────
for src, dst in BRANCH_MAP_REGIONAL.items():
    if dst in dashboard["monthly_regional_ap"]:
        dashboard["monthly_regional_ap"][dst] = [round(v, 2) for v in vol[src]]

# ── 3c. monthly.ap_2026 (TTL) ────────────────────────────────────
dashboard["monthly"]["ap_2026"] = [round(v, 2) for v in vol["TTL"]]

# ── 3d. wk10_summary.hl ──────────────────────────────────────────
WK_HL_MAP = {
    "TTL":      "TTL",
    "Seoul":    "Seoul",
    "Busan":    "Busan",
    "D&J":      "DaeGu & JeJu",
    "Daejeon":  "DaeJeon",
    "Gwangju":  "GwangJu",
}
for src, dst in WK_HL_MAP.items():
    if dst in dashboard["wk10_summary"]["hl"]:
        entry = dashboard["wk10_summary"]["hl"][dst]
        new_ap = round(vol[src][2], 2)
        entry["ap"] = new_ap
        if new_ap > 0:
            entry["ap_mtd_ach"] = round(entry["mtd_actual"] / new_ap, 4)
            entry["ap_fcst_ach"] = round(entry["this_week_fcst"] / new_ap, 4)

# ── 3e. wk10_summary.cases ───────────────────────────────────────
WK_CASES_MAP = {
    "TTL":      "BEER TTL",
    "Seoul":    "Seoul",
    "Busan":    "Busan",
    "D&J":      "DaeGu & JeJu",
    "Daejeon":  "DaeJeon",
    "Gwangju":  "GwangJu",
}
for src, dst in WK_CASES_MAP.items():
    if dst in dashboard["wk10_summary"]["cases"]:
        entry = dashboard["wk10_summary"]["cases"][dst]
        new_ap = round(vol[src][2] * CONV, 2)
        entry["ap"] = new_ap
        if new_ap > 0:
            entry["ap_mtd_ach"] = round(entry["mtd_actual"] / new_ap, 4)
            entry["ap_fcst_ach"] = round(entry["this_week_fcst"] / new_ap, 4)

# ── 3f. sku_detail ───────────────────────────────────────────────
def update_sku_entry(entry_data, monthly_hl):
    """Update ap, ap_monthly and recalculate achievement rates for a sku/brand entry."""
    ap_monthly = [round(v * CONV, 2) for v in monthly_hl]
    new_ap = ap_monthly[2]  # March (index 2) is current month
    entry_data["ap_monthly"] = ap_monthly
    entry_data["ap"] = new_ap
    if new_ap > 0:
        entry_data["ap_mtd_ach"] = round(entry_data["mtd"] / new_ap, 4)
        entry_data["ap_fcst_ach"] = round(entry_data["this_week_fcst"] / new_ap, 4)
    else:
        entry_data["ap_mtd_ach"] = 0.0
        entry_data["ap_fcst_ach"] = 0.0

for region_entry in dashboard["sku_detail"].values():
    pass  # just to warm up

# Process each region
SD_REGION_TO_BRANCH = {
    "On Trade Total": None,   # use OTT aggregates
    "Seoul":          "Seoul",
    "BuSan":          "Busan",
    "DaeGu&JeJu":    "D&J",
    "DaeJeon":        "Daejeon",
    "GwangJu":        "Gwangju",
}

for sd_region, branch in SD_REGION_TO_BRANCH.items():
    if sd_region not in dashboard["sku_detail"]:
        continue
    for brand_entry in dashboard["sku_detail"][sd_region]:
        dash_brand = brand_entry["brand"]

        # Brand-level monthly HL
        if branch is None:
            b_monthly = brand_data_ott.get(dash_brand, [0.0]*12)
        else:
            b_monthly = brand_data.get((branch, dash_brand), [0.0]*12)

        update_sku_entry(brand_entry["data"], b_monthly)

        # SKU-level
        for sku_entry in brand_entry["skus"]:
            dash_sku = sku_entry["sku"]
            if branch is None:
                s_monthly = sku_data_ott.get((dash_brand, dash_sku), [0.0]*12)
            else:
                s_monthly = sku_data.get((branch, dash_brand, dash_sku), [0.0]*12)
            update_sku_entry(sku_entry["data"], s_monthly)

# ── 저장 ──────────────────────────────────────────────────────────
new_json = json.dumps(dashboard, ensure_ascii=False, separators=(",", ":"))
result = html[:start] + new_json + html[end + 1:]

with open(HTML_PATH, "w", encoding="utf-8") as f:
    f.write(result)

print("index.html 업데이트 완료")
print(f"\n검증:")
print(f"  wk10_summary.hl.TTL.ap = {dashboard['wk10_summary']['hl']['TTL']['ap']} (기대: {round(vol['TTL'][2], 2)})")
print(f"  wk10_summary.cases.BEER TTL.ap = {dashboard['wk10_summary']['cases']['BEER TTL']['ap']} (기대: {round(vol['TTL'][2]*CONV, 2)})")
