#!/usr/bin/env python3
"""Plot excitement score distributions for NFL and CFB (Oct/Nov 2025)."""

import json
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
from scipy.stats import gaussian_kde
from pathlib import Path

DATA = Path(__file__).parent / 'scores_oct_nov_2025_v3.json'
OUT  = Path(__file__).parent / 'excitement_distribution_v3.png'

with open(DATA) as f:
    games = json.load(f)

nfl_scores = [g['excitement'] for g in games if g['sport'] == 'nfl']
cfb_scores = [g['excitement'] for g in games if g['sport'] == 'cfb']

# ── Palette ───────────────────────────────────────────────────────────────────
NFL_COLOR = '#013369'   # NFL dark blue
CFB_COLOR = '#C41230'   # CFB crimson
TIER_COLORS = {
    'Must Watch':  '#22c55e',  # green
    'Exciting':    '#84cc16',  # lime
    'Worth It':    '#eab308',  # yellow
    'So-So':       '#f97316',  # orange
    'Skip It':     '#ef4444',  # red
}
TIERS = [
    ('Must Watch',  80, 100),
    ('Exciting',    60,  79),
    ('Worth It',    40,  59),
    ('So-So',       20,  39),
    ('Skip It',      0,  19),
]

def tier_pct(scores, lo, hi):
    n = sum(1 for s in scores if lo <= s <= hi)
    return n / len(scores) * 100 if scores else 0

def score_stats(scores, label):
    arr = np.array(scores)
    return {
        'label':  label,
        'n':      len(arr),
        'mean':   arr.mean(),
        'median': np.median(arr),
        'p25':    np.percentile(arr, 25),
        'p75':    np.percentile(arr, 75),
    }

nfl_stats = score_stats(nfl_scores, 'NFL')
cfb_stats = score_stats(cfb_scores, 'CFB')

# ── Figure ────────────────────────────────────────────────────────────────────
fig = plt.figure(figsize=(16, 11))
fig.patch.set_facecolor('#0f172a')

gs = GridSpec(3, 2, figure=fig, hspace=0.45, wspace=0.32,
              left=0.07, right=0.97, top=0.91, bottom=0.08)

ax_nfl_hist = fig.add_subplot(gs[0, 0])
ax_cfb_hist = fig.add_subplot(gs[0, 1])
ax_kde      = fig.add_subplot(gs[1, :])
ax_tier_nfl = fig.add_subplot(gs[2, 0])
ax_tier_cfb = fig.add_subplot(gs[2, 1])

for ax in [ax_nfl_hist, ax_cfb_hist, ax_kde, ax_tier_nfl, ax_tier_cfb]:
    ax.set_facecolor('#1e293b')
    ax.tick_params(colors='#94a3b8', labelsize=9)
    for spine in ax.spines.values():
        spine.set_edgecolor('#334155')

def style_ax(ax, title, xlabel='', ylabel=''):
    ax.set_title(title, color='#e2e8f0', fontsize=11, fontweight='bold', pad=8)
    ax.set_xlabel(xlabel, color='#94a3b8', fontsize=9)
    ax.set_ylabel(ylabel, color='#94a3b8', fontsize=9)
    ax.grid(axis='y', color='#334155', linewidth=0.5, alpha=0.7)
    ax.grid(axis='x', color='#334155', linewidth=0.3, alpha=0.4)

# Add vertical tier bands to a histogram axis
def add_tier_bands(ax):
    for name, lo, hi in TIERS:
        ax.axvspan(lo, hi + 0.99, alpha=0.08, color=TIER_COLORS[name], zorder=0)

# ── Histogram: NFL ────────────────────────────────────────────────────────────
bins = range(0, 102, 5)
add_tier_bands(ax_nfl_hist)
counts, edges, _ = ax_nfl_hist.hist(
    nfl_scores, bins=bins, color=NFL_COLOR, edgecolor='#0f172a',
    linewidth=0.4, alpha=0.9, zorder=2
)
ax_nfl_hist.axvline(nfl_stats['mean'],   color='#facc15', linewidth=1.5, linestyle='--', label=f"Mean {nfl_stats['mean']:.1f}", zorder=3)
ax_nfl_hist.axvline(nfl_stats['median'], color='#fb923c', linewidth=1.5, linestyle=':',  label=f"Median {nfl_stats['median']:.0f}", zorder=3)
style_ax(ax_nfl_hist, f"NFL  ({nfl_stats['n']} games)", 'Excitement Score', 'Games')
ax_nfl_hist.set_xlim(0, 100)
ax_nfl_hist.legend(fontsize=8, facecolor='#1e293b', labelcolor='#e2e8f0', edgecolor='#334155')

# ── Histogram: CFB ────────────────────────────────────────────────────────────
add_tier_bands(ax_cfb_hist)
ax_cfb_hist.hist(
    cfb_scores, bins=bins, color=CFB_COLOR, edgecolor='#0f172a',
    linewidth=0.4, alpha=0.9, zorder=2
)
ax_cfb_hist.axvline(cfb_stats['mean'],   color='#facc15', linewidth=1.5, linestyle='--', label=f"Mean {cfb_stats['mean']:.1f}", zorder=3)
ax_cfb_hist.axvline(cfb_stats['median'], color='#fb923c', linewidth=1.5, linestyle=':',  label=f"Median {cfb_stats['median']:.0f}", zorder=3)
style_ax(ax_cfb_hist, f"CFB  ({cfb_stats['n']} games)", 'Excitement Score', 'Games')
ax_cfb_hist.set_xlim(0, 100)
ax_cfb_hist.legend(fontsize=8, facecolor='#1e293b', labelcolor='#e2e8f0', edgecolor='#334155')

# ── KDE overlay ───────────────────────────────────────────────────────────────
x = np.linspace(0, 100, 500)

def safe_kde(scores):
    if len(scores) < 2: return np.zeros_like(x)
    kde = gaussian_kde(scores, bw_method=0.18)
    return kde(x)

nfl_kde = safe_kde(nfl_scores)
cfb_kde = safe_kde(cfb_scores)

add_tier_bands(ax_kde)
ax_kde.fill_between(x, nfl_kde, alpha=0.25, color=NFL_COLOR)
ax_kde.fill_between(x, cfb_kde, alpha=0.25, color=CFB_COLOR)
ax_kde.plot(x, nfl_kde, color=NFL_COLOR, linewidth=2.5, label=f'NFL (n={len(nfl_scores)})')
ax_kde.plot(x, cfb_kde, color=CFB_COLOR, linewidth=2.5, label=f'CFB (n={len(cfb_scores)})')

# Tier boundary lines
for lo in [20, 40, 60, 80]:
    ax_kde.axvline(lo, color='#475569', linewidth=0.8, linestyle='--', alpha=0.7)

# Tier labels along top
for name, lo, hi in TIERS:
    mid = (lo + hi) / 2
    ax_kde.text(mid, ax_kde.get_ylim()[1] if ax_kde.get_ylim()[1] > 0 else 0.04,
                name, ha='center', va='bottom', color=TIER_COLORS[name],
                fontsize=7.5, fontweight='bold')

style_ax(ax_kde, 'Excitement Score Distribution — NFL vs CFB (Oct–Nov 2025)', 'Excitement Score', 'Density')
ax_kde.set_xlim(0, 100)
ax_kde.legend(fontsize=10, facecolor='#1e293b', labelcolor='#e2e8f0', edgecolor='#334155')

# Re-add tier labels after ylim is set
for name, lo, hi in TIERS:
    mid = (lo + hi) / 2
    ymax = ax_kde.get_ylim()[1]
    ax_kde.text(mid, ymax * 0.97, name, ha='center', va='top',
                color=TIER_COLORS[name], fontsize=8, fontweight='bold', alpha=0.9)

# ── Tier breakdown bar charts ─────────────────────────────────────────────────
def plot_tier_bars(ax, scores, title, color):
    names  = [t[0] for t in TIERS]
    pcts   = [tier_pct(scores, t[1], t[2]) for t in TIERS]
    colors = [TIER_COLORS[n] for n in names]
    bars = ax.barh(names, pcts, color=colors, edgecolor='#0f172a', linewidth=0.4, alpha=0.9)
    for bar, pct in zip(bars, pcts):
        if pct > 2:
            ax.text(pct + 0.3, bar.get_y() + bar.get_height() / 2,
                    f'{pct:.1f}%', va='center', ha='left',
                    color='#e2e8f0', fontsize=9, fontweight='bold')
    ax.set_xlim(0, max(pcts) * 1.25 + 5)
    ax.invert_yaxis()
    style_ax(ax, title, '% of Games', '')
    ax.tick_params(axis='y', colors='#e2e8f0', labelsize=9)

plot_tier_bars(ax_tier_nfl, nfl_scores,
               f'NFL Tier Breakdown  (avg {nfl_stats["mean"]:.1f})', NFL_COLOR)
plot_tier_bars(ax_tier_cfb, cfb_scores,
               f'CFB Tier Breakdown  (avg {cfb_stats["mean"]:.1f})', CFB_COLOR)

# ── Title & footer ────────────────────────────────────────────────────────────
fig.suptitle('Squeaker Excitement Score Distribution  ·  Oct – Nov 2025  (sport-specific stats calibration)',
             color='#f1f5f9', fontsize=14, fontweight='bold', y=0.975)

fig.text(0.5, 0.01,
         f'NFL: n={len(nfl_scores)}, mean={nfl_stats["mean"]:.1f}, median={nfl_stats["median"]:.0f}, IQR [{nfl_stats["p25"]:.0f}–{nfl_stats["p75"]:.0f}]   |   '
         f'CFB: n={len(cfb_scores)}, mean={cfb_stats["mean"]:.1f}, median={cfb_stats["median"]:.0f}, IQR [{cfb_stats["p25"]:.0f}–{cfb_stats["p75"]:.0f}]',
         ha='center', color='#64748b', fontsize=8.5)

plt.savefig(OUT, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Saved → {OUT}')
plt.show()
