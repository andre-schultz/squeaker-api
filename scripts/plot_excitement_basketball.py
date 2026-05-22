#!/usr/bin/env python3
"""Plot excitement score distributions for NBA, WNBA, CBB, WCBB.
Same layout as the football plot: histograms → combined KDE → tier bars."""

import json
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec
from scipy.stats import gaussian_kde
from pathlib import Path

DATA = Path(__file__).parent / 'scores_basketball_v2.json'
OUT  = Path(__file__).parent / 'excitement_distribution_basketball.png'

with open(DATA) as f:
    games = json.load(f)

NBA_COLOR  = '#C9A84C'   # gold
WNBA_COLOR = '#F26522'   # orange
CBB_COLOR  = '#1D4E89'   # blue
WCBB_COLOR = '#6A1E8A'   # purple

SPORT_META = {
    'nba':  ('NBA',  NBA_COLOR),
    'wnba': ('WNBA', WNBA_COLOR),
    'cbb':  ('CBB',  CBB_COLOR),
    'wcbb': ('WCBB', WCBB_COLOR),
}

TIERS = [
    ('Must Watch',  80, 100),
    ('Exciting',    60,  79),
    ('Worth It',    40,  59),
    ('So-So',       20,  39),
    ('Skip It',      0,  19),
]
TIER_COLORS = {
    'Must Watch': '#22c55e',
    'Exciting':   '#84cc16',
    'Worth It':   '#eab308',
    'So-So':      '#f97316',
    'Skip It':    '#ef4444',
}

def score_stats(scores):
    arr = np.array(scores)
    return dict(n=len(arr), mean=arr.mean(), median=np.median(arr),
                p25=np.percentile(arr, 25), p75=np.percentile(arr, 75))

def tier_pct(scores, lo, hi):
    n = sum(1 for s in scores if lo <= s <= hi)
    return n / len(scores) * 100 if scores else 0

all_scores = {k: [g['excitement'] for g in games if g['sport'] == k]
              for k in SPORT_META}
all_stats  = {k: score_stats(v) for k, v in all_scores.items()}

# ── Figure: 4 rows × 2 cols for histograms, then KDE row, then tier-bar row ──
# GridSpec: rows 0-1 = histograms (2 rows × 2 cols),
#           row  2   = combined KDE (full width),
#           row  3   = tier breakdown bars (2 × 2)

fig = plt.figure(figsize=(16, 15))
fig.patch.set_facecolor('#0f172a')

gs = GridSpec(4, 2, figure=fig, hspace=0.50, wspace=0.32,
              left=0.07, right=0.97, top=0.93, bottom=0.05,
              height_ratios=[1, 1, 1.1, 1])

ax_hist = {
    'nba':  fig.add_subplot(gs[0, 0]),
    'wnba': fig.add_subplot(gs[0, 1]),
    'cbb':  fig.add_subplot(gs[1, 0]),
    'wcbb': fig.add_subplot(gs[1, 1]),
}
ax_kde      = fig.add_subplot(gs[2, :])
ax_tier     = {
    'nba':  fig.add_subplot(gs[3, 0]),
    'wnba': fig.add_subplot(gs[3, 0]),   # placeholder – will be split below
    'cbb':  fig.add_subplot(gs[3, 1]),
    'wcbb': fig.add_subplot(gs[3, 1]),
}

# Redo tier axes as a 2×2 sub-grid inside row 3
for ax in list(ax_tier.values()) + [ax_kde] + list(ax_hist.values()):
    try: ax.remove()
    except: pass

gs_tier = GridSpec(1, 4, figure=fig,
                   left=0.07, right=0.97, bottom=0.05, top=0.24,
                   wspace=0.40)
ax_tier = {
    'nba':  fig.add_subplot(gs_tier[0, 0]),
    'wnba': fig.add_subplot(gs_tier[0, 1]),
    'cbb':  fig.add_subplot(gs_tier[0, 2]),
    'wcbb': fig.add_subplot(gs_tier[0, 3]),
}

gs_hist = GridSpec(2, 2, figure=fig,
                   left=0.07, right=0.97, bottom=0.50, top=0.93,
                   hspace=0.45, wspace=0.32)
ax_hist = {
    'nba':  fig.add_subplot(gs_hist[0, 0]),
    'wnba': fig.add_subplot(gs_hist[0, 1]),
    'cbb':  fig.add_subplot(gs_hist[1, 0]),
    'wcbb': fig.add_subplot(gs_hist[1, 1]),
}
ax_kde = fig.add_axes([0.07, 0.27, 0.90, 0.20])

all_axes = list(ax_hist.values()) + [ax_kde] + list(ax_tier.values())
for ax in all_axes:
    ax.set_facecolor('#1e293b')
    ax.tick_params(colors='#94a3b8', labelsize=9)
    for spine in ax.spines.values():
        spine.set_edgecolor('#334155')

def style_ax(ax, title, xlabel='', ylabel=''):
    ax.set_title(title, color='#e2e8f0', fontsize=10, fontweight='bold', pad=6)
    ax.set_xlabel(xlabel, color='#94a3b8', fontsize=8)
    ax.set_ylabel(ylabel, color='#94a3b8', fontsize=8)
    ax.grid(axis='y', color='#334155', linewidth=0.5, alpha=0.7)
    ax.grid(axis='x', color='#334155', linewidth=0.3, alpha=0.4)

def add_tier_bands(ax):
    for name, lo, hi in TIERS:
        ax.axvspan(lo, hi + 0.99, alpha=0.08, color=TIER_COLORS[name], zorder=0)

bins = range(0, 102, 5)

# ── Histograms ────────────────────────────────────────────────────────────────
for sport, (name, color) in SPORT_META.items():
    scores = all_scores[sport]
    st     = all_stats[sport]
    ax     = ax_hist[sport]

    add_tier_bands(ax)
    ax.hist(scores, bins=bins, color=color, edgecolor='#0f172a',
            linewidth=0.4, alpha=0.9, zorder=2)
    ax.axvline(st['mean'],   color='#facc15', linewidth=1.5, linestyle='--',
               label=f"Mean {st['mean']:.1f}", zorder=3)
    ax.axvline(st['median'], color='#fb923c', linewidth=1.5, linestyle=':',
               label=f"Median {st['median']:.0f}", zorder=3)
    ax.set_xlim(0, 100)
    style_ax(ax, f"{name}  ({st['n']} games)", 'Excitement Score', 'Games')
    ax.legend(fontsize=8, facecolor='#1e293b', labelcolor='#e2e8f0',
              edgecolor='#334155')

# ── Combined KDE ──────────────────────────────────────────────────────────────
x = np.linspace(0, 100, 500)

def safe_kde(scores):
    if len(scores) < 2: return np.zeros_like(x)
    return gaussian_kde(scores, bw_method=0.18)(x)

add_tier_bands(ax_kde)
for sport, (name, color) in SPORT_META.items():
    scores = all_scores[sport]
    kde    = safe_kde(scores)
    ax_kde.fill_between(x, kde, alpha=0.18, color=color)
    ax_kde.plot(x, kde, color=color, linewidth=2.2,
                label=f'{name} (n={len(scores)})')

for lo in [20, 40, 60, 80]:
    ax_kde.axvline(lo, color='#475569', linewidth=0.8, linestyle='--', alpha=0.7)

style_ax(ax_kde,
         'Excitement Score Distribution — NBA · WNBA · CBB · WCBB',
         'Excitement Score', 'Density')
ax_kde.set_xlim(0, 100)
ax_kde.legend(fontsize=9, facecolor='#1e293b', labelcolor='#e2e8f0',
              edgecolor='#334155', ncol=4, loc='upper left')

ymax = ax_kde.get_ylim()[1]
for name, lo, hi in TIERS:
    mid = (lo + hi) / 2
    ax_kde.text(mid, ymax * 0.97, name, ha='center', va='top',
                color=TIER_COLORS[name], fontsize=8, fontweight='bold', alpha=0.9)

# ── Tier breakdown bars ───────────────────────────────────────────────────────
def plot_tier_bars(ax, scores, title, color):
    names  = [t[0] for t in TIERS]
    pcts   = [tier_pct(scores, t[1], t[2]) for t in TIERS]
    colors = [TIER_COLORS[n] for n in names]
    bars   = ax.barh(names, pcts, color=colors, edgecolor='#0f172a',
                     linewidth=0.4, alpha=0.9)
    for bar, pct in zip(bars, pcts):
        if pct > 2:
            ax.text(pct + 0.3, bar.get_y() + bar.get_height() / 2,
                    f'{pct:.1f}%', va='center', ha='left',
                    color='#e2e8f0', fontsize=8, fontweight='bold')
    ax.set_xlim(0, max(pcts) * 1.3 + 5)
    ax.invert_yaxis()
    style_ax(ax, title, '% of Games', '')
    ax.tick_params(axis='y', colors='#e2e8f0', labelsize=8)

for sport, (name, color) in SPORT_META.items():
    st = all_stats[sport]
    plot_tier_bars(ax_tier[sport], all_scores[sport],
                   f'{name}  (avg {st["mean"]:.1f})', color)

# ── Title & footer ────────────────────────────────────────────────────────────
fig.suptitle('Squeaker Excitement Score Distribution  ·  Basketball  (sport-specific stats calibration)',
             color='#f1f5f9', fontsize=13, fontweight='bold', y=0.975)

parts = []
for sport, (name, _) in SPORT_META.items():
    st = all_stats[sport]
    parts.append(f"{name}: n={st['n']}, mean={st['mean']:.1f}, "
                 f"median={st['median']:.0f}, IQR [{st['p25']:.0f}–{st['p75']:.0f}]")
fig.text(0.5, 0.01, '   |   '.join(parts),
         ha='center', color='#64748b', fontsize=7.5)

plt.savefig(OUT, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
print(f'Saved → {OUT}')
plt.show()
