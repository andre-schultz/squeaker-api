#!/usr/bin/env python3
"""Plot distributions of the re-scored basketball games (current algorithm).

Reads scripts/scores_basketball_rescored.json and writes three PNGs:
  bb_total_by_league.png        - total excitement score, per league
  bb_components_by_league.png   - each score component, leagues overlaid
  bb_momentum_by_league.png     - momentum + its sub-components, per league
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


def vals(lg, key):
    return np.array([r[key] for r in by_league[lg]], dtype=float)


def mom_vals(lg, sub):
    return np.array([r["momentumBreakdown"][sub] for r in by_league[lg]], dtype=float)


# ── 1. Total score, per league (2x2, with mean/median lines) ──────────────────
fig, axes = plt.subplots(2, 2, figsize=(13, 9), sharex=True, sharey=True)
bins = np.arange(0, 102, 4)
for ax, lg in zip(axes.flat, LEAGUES):
    v = vals(lg, "total")
    ax.hist(v, bins=bins, color=COLORS[lg], alpha=0.85, edgecolor="white")
    ax.axvline(v.mean(), color="black", ls="--", lw=1.5, label=f"mean {v.mean():.1f}")
    ax.axvline(np.median(v), color="black", ls=":", lw=1.5, label=f"median {np.median(v):.0f}")
    ax.set_title(f"{NAMES[lg]}  (n={len(v)})", fontweight="bold")
    ax.set_xlabel("excitement score (0-100)")
    ax.set_ylabel("games")
    ax.legend(fontsize=9)
    ax.grid(alpha=0.25)
fig.suptitle(f"Total excitement score by league — {LABEL}", fontsize=15, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.97])
fig.savefig(os.path.join(HERE, f"{PREFIX}_total_by_league.png"), dpi=110)
plt.close(fig)


# ── 2. Components, leagues overlaid (step histograms, density) ────────────────
COMPONENTS = [
    ("closeness", "Closeness (0-65)", np.arange(0, 67, 3)),
    ("ot", "OT bonus (0/5)", np.arange(0, 7, 1)),
    ("comeback", "Comeback (0-15) — excluded for BB", np.arange(0, 16, 1)),
    ("momentum", "Momentum (0-25)", np.arange(0, 27, 1.5)),
    ("upset", "Upset (0-10) — not computed this batch", np.arange(0, 11, 1)),
    ("stats", "Stats activity (0-20)", np.arange(0, 21, 1)),
]
fig, axes = plt.subplots(2, 3, figsize=(17, 9))
for ax, (key, title, bins) in zip(axes.flat, COMPONENTS):
    for lg in LEAGUES:
        v = vals(lg, key)
        ax.hist(v, bins=bins, density=True, histtype="step", lw=2,
                color=COLORS[lg], label=f"{NAMES[lg]} (μ={v.mean():.1f})")
    ax.set_title(title, fontweight="bold")
    ax.set_xlabel("points")
    ax.set_ylabel("density")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.25)
fig.suptitle(f"Score components by league — {LABEL} (density-normalized)",
             fontsize=15, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.97])
fig.savefig(os.path.join(HERE, f"{PREFIX}_components_by_league.png"), dpi=110)
plt.close(fig)


# ── 3. Momentum + sub-components, per league ──────────────────────────────────
# Top row: total momentum per league (filled). Bottom: surge / runs / close,
# leagues overlaid (step). Sub-components are pre-cap contributions.
fig = plt.figure(figsize=(17, 10))
gs = fig.add_gridspec(2, 3, height_ratios=[1, 1])

ax_tot = fig.add_subplot(gs[0, :])
bins = np.arange(0, 26, 1)
for lg in LEAGUES:
    v = vals(lg, "momentum")
    ax_tot.hist(v, bins=bins, histtype="step", lw=2.2, color=COLORS[lg],
                label=f"{NAMES[lg]} (μ={v.mean():.1f}, n={len(v)})")
ax_tot.set_title("Total momentum bonus (capped at 25) by league", fontweight="bold")
ax_tot.set_xlabel("momentum points")
ax_tot.set_ylabel("games")
ax_tot.legend(fontsize=9)
ax_tot.grid(alpha=0.25)

SUBS = [
    ("surge", "Comeback surge (erase 7+ deficit)", np.arange(0, 26, 1)),
    ("runs", "Scoring runs (7+ unanswered)", np.arange(0, 26, 1)),
    ("close", "Time spent close (0-10)", np.arange(0, 11, 0.5)),
]
for col, (sub, title, bins) in enumerate(SUBS):
    ax = fig.add_subplot(gs[1, col])
    for lg in LEAGUES:
        v = mom_vals(lg, sub)
        ax.hist(v, bins=bins, density=True, histtype="step", lw=2,
                color=COLORS[lg], label=f"{NAMES[lg]} (μ={v.mean():.1f})")
    ax.set_title(title, fontweight="bold", fontsize=10)
    ax.set_xlabel("points (pre-cap)")
    ax.set_ylabel("density")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.25)

fig.suptitle(f"Momentum breakdown by league — {LABEL}", fontsize=15, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.97])
fig.savefig(os.path.join(HERE, f"{PREFIX}_momentum_by_league.png"), dpi=110)
plt.close(fig)


# ── Console summary table ─────────────────────────────────────────────────────
def stat(lg, key, sub=None):
    v = mom_vals(lg, sub) if sub else vals(lg, key)
    return v

print(f"{'league':10} {'n':>5} {'total':>7} {'close':>7} {'mom':>6} "
      f"{'surge':>6} {'runs':>6} {'clz':>6} {'stats':>6} {'%runs>0':>8}")
for lg in LEAGUES:
    rows_lg = by_league[lg]
    n = len(rows_lg)
    pct_runs = 100 * np.mean(mom_vals(lg, "runs") > 0)
    print(f"{NAMES[lg]:10} {n:>5} "
          f"{vals(lg,'total').mean():>7.1f} {vals(lg,'closeness').mean():>7.1f} "
          f"{vals(lg,'momentum').mean():>6.1f} {mom_vals(lg,'surge').mean():>6.2f} "
          f"{mom_vals(lg,'runs').mean():>6.2f} {mom_vals(lg,'close').mean():>6.2f} "
          f"{vals(lg,'stats').mean():>6.1f} {pct_runs:>7.0f}%")
print(f"\nWrote: {PREFIX}_total/_components/_momentum_by_league.png")
