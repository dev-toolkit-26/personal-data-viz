import json
import re
import os

SQL_FILES = {
    "On Trade Total": "sku_On_Trade_Total.sql",
    "Seoul": "sku_Seoul.sql",
    "BuSan": "sku_BuSan.sql",
    "DaeGu&JeJu": "sku_DaeGu_JeJu.sql",
    "DaeJeon": "sku_DaeJeon.sql",
    "GwangJu": "sku_GwangJu.sql",
}

APR_IDX = 3  # ap_monthly index for April

def safe_div(a, b):
    if b is None or b == 0:
        return 0.0
    return round(a / b, 4)

def update_data_fields(d):
    """Update ap, ap_mtd_ach, ap_fcst_ach for a brand or SKU data dict."""
    ap_monthly = d.get("ap_monthly", [])
    new_ap = ap_monthly[APR_IDX] if len(ap_monthly) > APR_IDX else 0.0

    mtd = d.get("mtd", 0) or 0
    fcst = d.get("this_week_fcst", 0) or 0

    d["ap"] = new_ap
    d["ap_mtd_ach"] = safe_div(mtd, new_ap)
    d["ap_fcst_ach"] = safe_div(fcst, new_ap)

    # hl_factor at brand level tracks total ap (not a fixed conversion factor)
    # Update only when hl_factor is large (brand-level, not SKU-level conversion)
    if "hl_factor" in d and d.get("hl_factor", 0) > 1:
        d["hl_factor"] = new_ap

    return d

BASE = os.path.dirname(os.path.abspath(__file__))

for region, filename in SQL_FILES.items():
    path = os.path.join(BASE, filename)
    sql = open(path, encoding="utf-8").read()

    # Extract JSON array from SQL
    m = re.search(r"'\[(.+)\]'::jsonb", sql, re.DOTALL)
    if not m:
        print(f"[SKIP] {filename}: JSON not found")
        continue

    json_str = "[" + m.group(1) + "]"
    data = json.loads(json_str)

    for brand_entry in data:
        update_data_fields(brand_entry["data"])
        for sku_entry in brand_entry.get("skus", []):
            update_data_fields(sku_entry["data"])

    new_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    # Escape single quotes for SQL
    new_json_escaped = new_json.replace("'", "''")

    region_key = region.replace('"', '\\"')
    new_sql = (
        f"UPDATE dashboard_snapshots SET data = jsonb_set("
        f"data, '{{sku_detail,\"{region_key}\"}}' ::text[], "
        f"'{new_json_escaped}'::jsonb, false) WHERE id = 1;"
    )

    out_path = os.path.join(BASE, filename.replace(".sql", "_apr.sql"))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(new_sql)
    print(f"[OK] {filename} -> {os.path.basename(out_path)}")

print("Done.")
