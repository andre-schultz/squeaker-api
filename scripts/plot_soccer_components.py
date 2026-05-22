"""
Break down excitement score components for all soccer games (EPL, MLS, NWSL).
Uses the final snapshot per game. Score is uncapped.
"""

import json, math, os, time
import requests
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from collections import defaultdict

REDIS_URL   = "https://smooth-raptor-113975.upstash.io"
REDIS_TOKEN = "gQAAAAAAAb03AAIgcDJiYzFlN2Q3YzU5ZDQ0YmI1YWQ4OTIwMjQzOTNjYTQ3Ng"
HEADERS = {"Authorization": f"Bearer {REDIS_TOKEN}", "Content-Type": "application/json"}

SOCCER_SPORTS = {"mls", "epl", "nwsl"}
SPORT_LABELS  = {"mls": "MLS", "epl": "EPL", "nwsl": "NWSL"}

COMPONENTS = ["closeness", "ot", "comeback", "momentum", "wp", "upset"]
COMP_LABELS = {
    "closeness": "Closeness\n(0–75)",
    "ot":        "OT\n(0 or 10)",
    "comeback":  "Comeback\n(0 or 10)",
    "momentum":  "Momentum\n(0–20)",
    "wp":        "WP Drama\n(0–15)",
    "upset":     "Upset\n(0–10)",
}


def redis_cmd(*args):
    r = requests.post(f"{REDIS_URL}/pipeline", headers=HEADERS, json=[list(args)])
    r.raise_for_status()
    return r.json()[0].get("result")


def scan_all_audit_keys():
    keys, cursor = [], "0"
    while True:
        result = redis_cmd("SCAN", cursor, "MATCH", "audit:*", "COUNT", "200")
        cursor, batch = result[0], result[1]
        keys.extend(batch)
        if cursor == "0":
            break
    return keys


def fetch_keys_in_batches(keys, batch_size=50):
    results = {}
    for i in range(0, len(keys), batch_size):
        batch = keys[i:i+batch_size]
        r = requests.post(f"{REDIS_URL}/pipeline", headers=HEADERS,
                          json=[["GET", k] for k in batch])
        r.raise_for_status()
        for key, item in zip(batch, r.json()):
            results[key] = item.get("result")
        time.sleep(0.05)
    return results


def main():
    print("Scanning audit keys...")
    keys = scan_all_audit_keys()
    print(f"Found {len(keys)} audit keys — fetching...")
    raw_data = fetch_keys_in_batches(keys)

    # Collect per-game final-snapshot data for soccer leagues
    records = []  # list of dicts: sport, margin, all components, raw, uncapped_final
    for key, val in raw_data.items():
        if not val:
            continue
        snapshots = val if isinstance(val, list) else json.loads(val)
        if not snapshots:
            continue
        snap  = snapshots[-1]
        sport = snap.get("game", {}).get("sport")
        if sport not in SOCCER_SPORTS:
            continue
        exc = snap.get("signals", {}).get("excitement")
        if not exc:
            continue
        margin = snap.get("game", {}).get("margin", None)
        mult   = exc.get("progressMultiplier", 1.0)
        raw    = exc.get("raw", 0)
        records.append({
            "sport":        sport,
            "margin":       margin,
            "closeness":    exc.get("closeness", 0),
            "ot":           exc.get("ot", 0),
            "comeback":     exc.get("comeback", 0),
            "momentum":     exc.get("momentum", 0),
            "wp":           exc.get("wp", 0),
            "upset":        exc.get("upset", 0),
            "raw":          raw,
            "progressMultiplier": mult,
            "uncapped_final": round(raw * mult),
        })

    print(f"\n{len(records)} soccer games found")
    for sport in sorted(SOCCER_SPORTS):
        sub = [r for r in records if r["sport"] == sport]
        print(f"  {SPORT_LABELS[sport]}: {len(sub)} games")

    if not records:
        print("No soccer data.")
        return

    # ── Plot 1: Component distributions (violin / strip) ─────────────────────
    fig, axes = plt.subplots(1, len(COMPONENTS), figsize=(len(COMPONENTS) * 2.8, 5))

    colors = {"mls": "#4C9BE8", "epl": "#E84C9B", "nwsl": "#4CE87A"}

    for ax, comp in zip(axes, COMPONENTS):
        # All-soccer combined violin
        all_vals = [r[comp] for r in records]
        vp = ax.violinplot([all_vals], positions=[0], showmedians=True, widths=0.6)
        for body in vp["bodies"]:
            body.set_facecolor("#CCCCCC")
            body.set_alpha(0.5)
        vp["cmedians"].set_color("black")

        # Per-sport jitter
        for i, sport in enumerate(sorted(SOCCER_SPORTS)):
            vals = [r[comp] for r in records if r["sport"] == sport]
            jitter = np.random.uniform(-0.15, 0.15, len(vals))
            ax.scatter(jitter, vals, color=colors[sport], s=30, alpha=0.8,
                       label=SPORT_LABELS[sport], zorder=3)

        ax.set_xticks([])
        ax.set_title(COMP_LABELS[comp], fontsize=9, fontweight="bold")
        ax.set_ylim(-2, max(
            {"closeness": 78, "ot": 13, "comeback": 13,
             "momentum": 23, "wp": 18, "upset": 13}[comp], 1
        ))
        if comp == "closeness":
            ax.set_ylabel("Points", fontsize=9)
        if comp == COMPONENTS[0]:
            ax.legend(fontsize=8, loc="upper right")

    fig.suptitle("Soccer Games — Score Component Breakdown (EPL + MLS + NWSL)",
                 fontsize=12, fontweight="bold")
    plt.tight_layout()
    out1 = os.path.join(os.path.dirname(__file__), "soccer_components.png")
    fig.savefig(out1, dpi=150, bbox_inches="tight")
    print(f"Saved → {out1}")

    # ── Plot 2: Margin distribution & closeness tier breakdown ────────────────
    margins = [r["margin"] for r in records if r["margin"] is not None]
    closeness_vals = [r["closeness"] for r in records]

    # Margin → tier label
    def tier(m):
        if m <= 1:   return "≤1 (great, 75pt)"
        if m <= 2:   return "2 (good, 56pt)"
        if m <= 3:   return "3 (ok, 36pt)"
        if m <= 4:   return "4 (blowout, 12pt)"
        return f"5+ (0pt)"

    tier_counts = defaultdict(int)
    for m in margins:
        tier_counts[tier(m)] += 1

    tier_order = ["≤1 (great, 75pt)", "2 (good, 56pt)", "3 (ok, 36pt)",
                  "4 (blowout, 12pt)", "5+ (0pt)"]
    tier_colors = ["#2ECC71", "#F1C40F", "#E67E22", "#E74C3C", "#95A5A6"]

    fig2, (ax_margin, ax_raw) = plt.subplots(1, 2, figsize=(10, 4))

    counts = [tier_counts.get(t, 0) for t in tier_order]
    bars = ax_margin.bar(range(len(tier_order)), counts, color=tier_colors, edgecolor="white")
    ax_margin.set_xticks(range(len(tier_order)))
    ax_margin.set_xticklabels(tier_order, rotation=25, ha="right", fontsize=8)
    ax_margin.set_ylabel("Games")
    ax_margin.set_title("Final Margin Distribution\n(with closeness tier)", fontsize=10, fontweight="bold")
    for bar, count in zip(bars, counts):
        if count:
            ax_margin.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.1,
                           str(count), ha="center", va="bottom", fontsize=9)

    # Raw score histogram
    raw_vals = [r["raw"] for r in records]
    uncapped = [r["uncapped_final"] for r in records]
    ax_raw.hist(raw_vals, bins=range(0, 145, 5), color="#4C9BE8", edgecolor="white",
                label="raw (pre-progress)", alpha=0.7)
    ax_raw.hist(uncapped, bins=range(0, 145, 5), color="#E84C4C", edgecolor="white",
                label="uncapped final", alpha=0.6)
    ax_raw.axvline(100, color="black", linewidth=1.2, linestyle="--", label="cap=100")
    ax_raw.set_xlabel("Score")
    ax_raw.set_ylabel("Games")
    ax_raw.set_title("Raw vs Uncapped Final Score\n(all soccer games)", fontsize=10, fontweight="bold")
    ax_raw.legend(fontsize=8)

    fig2.suptitle("Soccer Score Anatomy", fontsize=12, fontweight="bold")
    plt.tight_layout()
    out2 = os.path.join(os.path.dirname(__file__), "soccer_anatomy.png")
    fig2.savefig(out2, dpi=150, bbox_inches="tight")
    print(f"Saved → {out2}")

    # ── Summary stats ─────────────────────────────────────────────────────────
    print("\n── Component means (all soccer) ──")
    for comp in COMPONENTS + ["raw", "uncapped_final"]:
        vals = [r[comp] for r in records]
        print(f"  {comp:20s}: mean={np.mean(vals):5.1f}  median={np.median(vals):5.1f}  "
              f"min={min(vals):3}  max={max(vals):3}")

    print("\n── Closeness tier breakdown ──")
    for t, c in zip(tier_order, counts):
        pct = 100 * c / len(records) if records else 0
        print(f"  {t:25s}: {c:3d} games ({pct:.0f}%)")


if __name__ == "__main__":
    main()
