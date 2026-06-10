#!/usr/bin/env python3
"""Plot run-frequency and run-size diagnostics for the re-scored basketball games.

Writes scripts/bb_runs_by_league.png with:
  - runs per game (distribution, by league)
  - how often the run bonus fires (% of games with >=1 run, + mean runs/game)
  - size of individual runs (pooled per run, by league)
"""
import json
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
# argv: [input.json] [out_prefix] [label]
INPUT = sys.argv[1] if len(sys.argv) > 1 else "scores_basketball_rescored.json"
PREFIX = sys.argv[2] if len(sys.argv) > 2 else "bb"
LABEL = sys.argv[3] if len(sys.argv) > 3 else "current algorithm"
rows = json.load(open(os.path.join(HERE, INPUT)))

LEAGUES = ["nba", "wnba", "cbb", "wcbb"]
NAMES = {"nba": "NBA", "wnba": "WNBA", "cbb": "Men's CBB", "wcbb": "Women's CBB"}
COLORS = {"nba": "#1f77b4", "wnba": "#ff7f0e", "cbb": "#2ca02c", "wcbb": "#d62728"}
by_league = {lg: [r for r in rows if r["sport"] == lg] for lg in LEAGUES}

n_runs = {lg: np.array([r["nRuns"] for r in by_league[lg]]) for lg in LEAGUES}
sizes = {lg: np.array([s for r in by_league[lg] for s in r.get("runSizes", [])]) for lg in LEAGUES}

fig, axes = plt.subplots(1, 3, figsize=(19, 6))

# ── (a) runs per game ─────────────────────────────────────────────────────────
ax = axes[0]
maxr = max(int(n_runs[lg].max()) for lg in LEAGUES)
bins = np.arange(-0.5, maxr + 1.5, 1)
for lg in LEAGUES:
    v = n_runs[lg]
    ax.hist(v, bins=bins, density=True, histtype="step", lw=2.2, color=COLORS[lg],
            label=f"{NAMES[lg]} (μ={v.mean():.1f}, med={int(np.median(v))})")
ax.set_title("Qualifying runs per game (7+ unanswered)", fontweight="bold")
ax.set_xlabel("number of runs in a game")
ax.set_ylabel("fraction of games")
ax.set_xticks(range(0, maxr + 1))
ax.legend(fontsize=9)
ax.grid(alpha=0.25)

# ── (b) how often the run bonus fires ─────────────────────────────────────────
ax = axes[1]
x = np.arange(len(LEAGUES))
pct_fire = [100 * np.mean(n_runs[lg] > 0) for lg in LEAGUES]
mean_runs = [n_runs[lg].mean() for lg in LEAGUES]
bars = ax.bar(x, pct_fire, color=[COLORS[lg] for lg in LEAGUES], alpha=0.85, edgecolor="white")
for b, p, m in zip(bars, pct_fire, mean_runs):
    ax.text(b.get_x() + b.get_width() / 2, p + 1.2, f"{p:.0f}%\nμ={m:.1f}/gm",
            ha="center", va="bottom", fontsize=10, fontweight="bold")
ax.set_title("How often the run bonus fires", fontweight="bold")
ax.set_ylabel("% of games with ≥1 qualifying run")
ax.set_xticks(x)
ax.set_xticklabels([NAMES[lg] for lg in LEAGUES])
ax.set_ylim(0, 105)
ax.grid(alpha=0.25, axis="y")

# ── (c) size of individual runs ───────────────────────────────────────────────
ax = axes[2]
maxs = max(int(sizes[lg].max()) for lg in LEAGUES if len(sizes[lg]))
bins = np.arange(7, maxs + 2, 1)
for lg in LEAGUES:
    v = sizes[lg]
    ax.hist(v, bins=bins, density=True, histtype="step", lw=2.2, color=COLORS[lg],
            label=f"{NAMES[lg]} (μ={v.mean():.1f}, max={int(v.max())}, N={len(v)})")
ax.set_title("Size of individual runs (per run)", fontweight="bold")
ax.set_xlabel("unanswered points in a run")
ax.set_ylabel("density")
ax.legend(fontsize=9)
ax.grid(alpha=0.25)

fig.suptitle(f"Basketball scoring runs — frequency & size by league — {LABEL}",
             fontsize=15, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.95])
fig.savefig(os.path.join(HERE, f"{PREFIX}_runs_by_league.png"), dpi=110)
plt.close(fig)

# ── console summary ───────────────────────────────────────────────────────────
print(f"{'league':12} {'games':>6} {'%fire':>6} {'runs/gm':>8} {'med':>4} {'maxRuns':>8} "
      f"{'totRuns':>8} {'sizeμ':>6} {'size_med':>9} {'size_p90':>9} {'sizeMax':>8}")
for lg in LEAGUES:
    nr, sz = n_runs[lg], sizes[lg]
    print(f"{NAMES[lg]:12} {len(by_league[lg]):>6} {100*np.mean(nr>0):>5.0f}% "
          f"{nr.mean():>8.2f} {int(np.median(nr)):>4} {int(nr.max()):>8} {len(sz):>8} "
          f"{sz.mean():>6.1f} {int(np.median(sz)):>9} {int(np.percentile(sz,90)):>9} {int(sz.max()):>8}")
print(f"\nWrote {PREFIX}_runs_by_league.png")
