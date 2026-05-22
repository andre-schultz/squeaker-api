"""
Plot excitement score distribution per league from Redis audit keys.
Uses the final (latest) snapshot per game. Score is uncapped (no min(100,...)).
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

HEADERS = {
    "Authorization": f"Bearer {REDIS_TOKEN}",
    "Content-Type": "application/json",
}

SPORT_LABELS = {
    "nba":  "NBA",
    "nhl":  "NHL",
    "mlb":  "MLB",
    "nfl":  "NFL",
    "cfb":  "College FB",
    "cbb":  "College BB",
    "mls":  "MLS",
    "epl":  "EPL",
    "ucl":  "Champions League",
    "wnba": "WNBA",
    "nwsl": "NWSL",
    "wcbb": "Women's College BB",
}


def redis_cmd(*args):
    cmd = list(args)
    r = requests.post(f"{REDIS_URL}/pipeline", headers=HEADERS, json=[cmd])
    r.raise_for_status()
    data = r.json()
    # pipeline returns list of {result: ...} or single object
    if isinstance(data, list):
        return data[0].get("result")
    return data.get("result")


def redis_pipeline(commands):
    r = requests.post(f"{REDIS_URL}/pipeline", headers=HEADERS, json=commands)
    r.raise_for_status()
    return [item.get("result") for item in r.json()]


def scan_all_audit_keys():
    keys = []
    cursor = "0"
    while True:
        result = redis_cmd("SCAN", cursor, "MATCH", "audit:*", "COUNT", "200")
        cursor, batch = result[0], result[1]
        keys.extend(batch)
        if cursor == "0":
            break
    return keys


def fetch_keys_in_batches(keys, batch_size=50):
    """Fetch multiple keys via pipeline in batches."""
    results = {}
    for i in range(0, len(keys), batch_size):
        batch = keys[i:i+batch_size]
        commands = [["GET", k] for k in batch]
        r = requests.post(f"{REDIS_URL}/pipeline", headers=HEADERS, json=commands)
        r.raise_for_status()
        for key, item in zip(batch, r.json()):
            results[key] = item.get("result")
        time.sleep(0.05)  # be polite
    return results


def uncapped_final(excitement):
    """Compute round(raw * progressMultiplier) without the min(100) cap."""
    raw  = excitement.get("raw", 0)
    mult = excitement.get("progressMultiplier", 1.0)
    return round(raw * mult)


def main():
    print("Scanning audit keys...")
    keys = scan_all_audit_keys()
    print(f"Found {len(keys)} audit keys")

    print("Fetching audit data...")
    raw_data = fetch_keys_in_batches(keys)

    scores_by_sport = defaultdict(list)
    skipped = 0

    for key, val in raw_data.items():
        if not val:
            skipped += 1
            continue

        snapshots = val if isinstance(val, list) else json.loads(val)
        if not snapshots:
            skipped += 1
            continue

        # Use the final snapshot — most representative state of the game
        snap = snapshots[-1]
        sport = snap.get("game", {}).get("sport")
        exc   = snap.get("signals", {}).get("excitement")

        if not sport or not exc:
            skipped += 1
            continue

        score = uncapped_final(exc)
        scores_by_sport[sport].append(score)

    print(f"Skipped {skipped} empty/missing keys")
    for sport, scores in sorted(scores_by_sport.items()):
        print(f"  {sport:6s}: {len(scores):4d} games  "
              f"  mean={np.mean(scores):.1f}  median={np.median(scores):.1f}  "
              f"max={max(scores)}")

    if not scores_by_sport:
        print("No data found.")
        return

    # ── Plot ──────────────────────────────────────────────────────────────────
    sports = sorted(scores_by_sport.keys(), key=lambda s: SPORT_LABELS.get(s, s))
    ncols = 3
    nrows = math.ceil(len(sports) / ncols)

    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 5, nrows * 3.5))
    axes = axes.flatten() if hasattr(axes, 'flatten') else [axes]

    all_scores = [s for v in scores_by_sport.values() for s in v]
    global_max = max(all_scores) + 5

    for ax, sport in zip(axes, sports):
        scores = scores_by_sport[sport]
        label  = SPORT_LABELS.get(sport, sport.upper())

        bins = range(0, global_max + 10, 5)
        ax.hist(scores, bins=bins, color="#4C9BE8", edgecolor="white", linewidth=0.4)
        ax.axvline(100, color="#E84C4C", linewidth=1.2, linestyle="--", label="cap=100")
        ax.set_title(f"{label}  (n={len(scores)})", fontsize=11, fontweight="bold")
        ax.set_xlabel("Excitement score (uncapped)", fontsize=9)
        ax.set_ylabel("Games", fontsize=9)
        ax.set_xlim(0, global_max + 5)
        ax.legend(fontsize=8)

        mean_val = np.mean(scores)
        ax.axvline(mean_val, color="#F5A623", linewidth=1.0, linestyle=":", label=f"mean={mean_val:.0f}")
        ax.legend(fontsize=8)

    # Hide unused subplots
    for ax in axes[len(sports):]:
        ax.set_visible(False)

    fig.suptitle("Excitement Score Distribution by League (uncapped)", fontsize=14, fontweight="bold", y=1.01)
    plt.tight_layout()

    out_path = os.path.join(os.path.dirname(__file__), "score_distribution.png")
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"\nSaved → {out_path}")


if __name__ == "__main__":
    main()
