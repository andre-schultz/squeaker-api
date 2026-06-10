#!/usr/bin/env python3
"""Of all 7+ unanswered runs, what share actually scores vs. is discarded (base 0)?
Reads run_classification.json, writes bb_run_classification.png."""
import json, os, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
# argv: [input.json] [out.png] [threshold-label]
INPUT = sys.argv[1] if len(sys.argv) > 1 else "run_classification_t7.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "bb_run_classification.png"
THRESH = sys.argv[3] if len(sys.argv) > 3 else "7"
agg = json.load(open(os.path.join(HERE, INPUT)))

LEAGUES = ["nba", "wnba", "cbb", "wcbb"]
NAMES = {"nba": "NBA", "wnba": "WNBA", "cbb": "Men's CBB", "wcbb": "Women's CBB"}
CATS = [("flip", "Lead flip", "#1f77b4"),
        ("close", "Kept close", "#2ca02c"),
        ("goahead", "Go-ahead", "#9467bd"),
        ("tie", "Equalizer", "#ff7f0e"),
        ("none", "DID NOT COUNT (0)", "#bbbbbb")]

fig, axes = plt.subplots(1, 2, figsize=(16, 6))

# (a) stacked % breakdown of every 7+ run, per league
ax = axes[0]
y = np.arange(len(LEAGUES))
left = np.zeros(len(LEAGUES))
totals = [sum(agg[lg][c] for c, _, _ in CATS) for lg in LEAGUES]
for key, label, color in CATS:
    frac = np.array([100 * agg[lg][key] / totals[i] for i, lg in enumerate(LEAGUES)])
    ax.barh(y, frac, left=left, color=color, edgecolor="white",
            label=label, hatch="//" if key == "none" else None)
    for i, f in enumerate(frac):
        if f > 4:
            ax.text(left[i] + f / 2, y[i], f"{f:.0f}%", ha="center", va="center",
                    fontsize=9, fontweight="bold",
                    color="black" if key == "none" else "white")
    left += frac
ax.set_yticks(y)
ax.set_yticklabels([f"{NAMES[lg]}\n(n={totals[i]})" for i, lg in enumerate(LEAGUES)])
ax.set_xlabel(f"% of all {THRESH}+ unanswered runs")
ax.set_title(f"Where {THRESH}+ runs go: scored vs. discarded", fontweight="bold")
ax.legend(loc="lower right", fontsize=9)
ax.set_xlim(0, 100)

# (b) sizes of the discarded ('none') runs — these are real, often large runs
ax = axes[1]
maxs = max((max(agg[lg]["noneSizes"]) for lg in LEAGUES if agg[lg]["noneSizes"]), default=30)
bins = np.arange(int(THRESH), maxs + 2, 1)
for lg in LEAGUES:
    v = np.array(agg[lg]["noneSizes"])
    if len(v):
        ax.hist(v, bins=bins, density=True, histtype="step", lw=2.2,
                label=f"{NAMES[lg]} (μ={v.mean():.1f}, N={len(v)})")
ax.set_title("Size of runs that DIDN'T count (base 0)", fontweight="bold")
ax.set_xlabel(f"unanswered points in a discarded run (≥{THRESH})")
ax.set_ylabel("density")
ax.legend(fontsize=9)
ax.grid(alpha=0.25)

fig.suptitle(f"{THRESH}+ scoring runs that score nothing (extend a lead, never flip/tie/close)",
             fontsize=14, fontweight="bold")
fig.tight_layout(rect=[0, 0, 1, 0.95])
fig.savefig(os.path.join(HERE, OUT), dpi=110)
print(f"Wrote {OUT}")
