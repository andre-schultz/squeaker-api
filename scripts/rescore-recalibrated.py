#!/usr/bin/env python3
"""
Re-score games using sport-specific stats normalizer calibration.
Floor ≈ p25 (below-average games score ~0 on component)
Ceiling ≈ p80 (top-quintile games score near 15)

Prints before/after comparison and saves rescored JSON.
"""
import json, numpy as np
from pathlib import Path

IN  = Path('scripts/scores_oct_nov_2025_v2.json')
OUT = Path('scripts/scores_oct_nov_2025_v3.json')

with open(IN) as f:
    games = json.load(f)

# ── Sport-specific calibration ────────────────────────────────────────────────
# Each tuple is (floor, ceiling). Values chosen from real game percentiles:
#   floor   ≈ p25 of that stat across all games  (below-avg = 0 pts)
#   ceiling ≈ p80 of that stat                   (top quintile = full pts)
#
#                    points   turnovers   first_downs   yards
# floor ≈ p10  (only bottom ~10% score 0 on each component)
# ceiling ≈ p80 (top quintile scores near max)
#
#            NFL percentiles:  p10  p25  p50  p75  p80  p90
#  total_pts                    29   37   46   54   57   62
#  turnovers                     0    1    1    2    3    3
#  first_downs                  31   35   39   43   45   47
#  yards                       523  583  662  730  770  810
#
#            CFB percentiles:  p10  p25  p50  p75  p80  p90
#  total_pts                    32   42   51   63   67   75
#  turnovers                     0    1    1    2    3    3
#  first_downs                  32   35   40   44   46   49
#  yards                       575  647  738  837  875  928
NFL_RANGES = dict(points=(25, 57), turnovers=(0, 3), firstDowns=(28, 46), yards=(480, 770))
CFB_RANGES = dict(points=(28, 67), turnovers=(0, 3), firstDowns=(29, 46), yards=(550, 875))

MAX_BONUS = 15

def nr(value, floor, ceiling):
    return max(0.0, min(1.0, ((value or 0) - floor) / (ceiling - floor)))

def calc_football_stats(home, away, total_pts, ranges):
    turnovers = (home.get('interceptions', 0) or 0) + (away.get('interceptions', 0) or 0) \
              + (home.get('fumbles', 0) or 0)        + (away.get('fumbles', 0) or 0)
    first_downs = (home.get('firstDowns', 0) or 0) + (away.get('firstDowns', 0) or 0)
    yards       = (home.get('totalYards',  0) or 0) + (away.get('totalYards',  0) or 0)

    components = {
        'points':     nr(total_pts,  *ranges['points']),
        'turnovers':  nr(turnovers,  *ranges['turnovers']),
        'firstDowns': nr(first_downs,*ranges['firstDowns']),
        'yards':      nr(yards,      *ranges['yards']),
    }
    weights = dict(points=0.25, turnovers=0.35, firstDowns=0.20, yards=0.20)
    raw = sum(components[k] * weights[k] for k in weights)
    return max(1, round(raw * MAX_BONUS)), components

def excitement_label(score):
    if score >= 80: return 'Must Watch'
    if score >= 60: return 'Exciting'
    if score >= 40: return 'Worth It'
    if score >= 20: return 'So-So'
    return 'Skip It'

def closeness(margin, is_ot):
    if is_ot or margin == 0: return 60
    if margin <= 3:  return 60
    if margin <= 7:  return 45
    if margin <= 14: return 29
    if margin <= 24: return 10
    return 0

# ── Rescore ───────────────────────────────────────────────────────────────────
rescored = []
for g in games:
    ranges = NFL_RANGES if g['sport'] == 'nfl' else CFB_RANGES
    sb = g.get('statsBonusBreakdown')

    if sb:
        total_pts = g['homeScore'] + g['awayScore']
        new_stats, components = calc_football_stats(sb['home'], sb['away'], total_pts, ranges)
    else:
        new_stats = g['statsBonus']
        components = None

    raw = (closeness(g['margin'], g['isOT'])
           + g['otBon'] + g['comebackBon']
           + g['momentumBonus'] + g['upsetBonus']
           + new_stats)

    new_score = min(100, round(raw))
    rescored.append({
        **g,
        'statsBonus': new_stats,
        'statsBonusComponents': components,
        'excitement': new_score,
        'label': excitement_label(new_score),
    })

# ── Comparison report ─────────────────────────────────────────────────────────
print(f"\n{'='*65}")
print(f"CALIBRATION COMPARISON  (v2 = old ranges, v3 = sport-specific)")
print(f"{'='*65}\n")

for sport in ['nfl', 'cfb']:
    old = [g['excitement']  for g in games    if g['sport'] == sport]
    new = [g['excitement']  for g in rescored  if g['sport'] == sport]
    old_stats = [g['statsBonus'] for g in games    if g['sport'] == sport]
    new_stats = [g['statsBonus'] for g in rescored  if g['sport'] == sport]

    print(f"{sport.upper()}  (n={len(old)})")
    print(f"  {'Metric':<18} {'v2 (old)':>10}  {'v3 (new)':>10}")
    print(f"  {'-'*40}")
    for label, a, b in [
        ('excitement mean',  np.mean(old),           np.mean(new)),
        ('excitement median',np.median(old),          np.median(new)),
        ('excitement p75',   np.percentile(old, 75),  np.percentile(new, 75)),
        ('excitement p90',   np.percentile(old, 90),  np.percentile(new, 90)),
        ('stats mean',       np.mean(old_stats),      np.mean(new_stats)),
        ('stats p75',        np.percentile(old_stats,75), np.percentile(new_stats,75)),
        ('stats max',        max(old_stats),           max(new_stats)),
    ]:
        print(f"  {label:<18} {a:>10.1f}  {b:>10.1f}  ({'+' if b>=a else ''}{b-a:.1f})")

    labels = ['Must Watch', 'Exciting', 'Worth It', 'So-So', 'Skip It']
    thresholds = [80, 60, 40, 20, 0]
    print(f"\n  {'Tier':<14} {'v2':>8}  {'v3':>8}")
    for lbl, lo in zip(labels, thresholds):
        hi = 100
        n_old = sum(1 for s in old if s >= lo and (lo == 0 or True))
        n_new = sum(1 for s in new if s >= lo and (lo == 0 or True))
        # simpler: just count by label
    old_lbl_counts = {l: sum(1 for g in games    if g['sport']==sport and g.get('label')==l) for l in labels}
    new_lbl_counts = {l: sum(1 for g in rescored  if g['sport']==sport and g['label']==l)     for l in labels}
    for lbl in labels:
        oc = old_lbl_counts[lbl]; nc = new_lbl_counts[lbl]; n = len(old)
        diff = nc - oc
        arrow = f"({'+' if diff>=0 else ''}{diff})"
        print(f"  {lbl:<14} {oc:>4} ({oc/n*100:>4.1f}%)  {nc:>4} ({nc/n*100:>4.1f}%)  {arrow}")
    print()

# ── Top 20 under new scoring ──────────────────────────────────────────────────
print(f"\nTOP 20 GAMES — v3 scoring")
print(f"{'#':<3} {'Score':<6} {'Sport':<5} {'Date':<11} {'Matchup':<22} {'Result':<9} | "
      f"{'Cls':>4} {'OT':>4} {'CB':>4} {'Mom':>4} {'Up':>4} {'Stat':>5} | Raw")
print('-' * 105)
top20 = sorted(rescored, key=lambda g: g['excitement'], reverse=True)[:20]
for i, g in enumerate(top20):
    matchup = f"{g['away']}@{g['home']}"
    result  = f"{g['awayScore']}-{g['homeScore']}" + (' OT' if g['isOT'] else '')
    raw = g['closeness']+g['otBon']+g['comebackBon']+g['momentumBonus']+g['upsetBonus']+g['statsBonus']
    print(f"{i+1:<3} {g['excitement']:<6} {g['sport'].upper():<5} {g['date']:<11} {matchup:<22} {result:<9} | "
          f"{g['closeness']:>4} {g['otBon']:>4} {g['comebackBon']:>4} {g['momentumBonus']:>4} "
          f"{g['upsetBonus']:>4} {g['statsBonus']:>5} | {raw}")

with open(OUT, 'w') as f:
    json.dump(rescored, f, indent=2)
print(f"\nSaved → {OUT}")
