#!/usr/bin/env python3
"""
Re-score basketball games using sport-specific stats calibration.
floor ≈ p10, ceiling ≈ p80 — derived from real Oct/Nov 2025 (NBA/CBB/WCBB)
and Jul/Aug 2025 (WNBA) game distributions.
"""
import json, numpy as np
from pathlib import Path

IN  = Path('scripts/scores_basketball.json')
OUT = Path('scripts/scores_basketball_v2.json')

with open(IN) as f:
    games = json.load(f)

THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'
MAX_BONUS = 15

# ── Sport-specific ranges (floor=p10, ceiling=p80) ────────────────────────────
RANGES = {
    'nba':  dict(points=(211, 250), threePointers=(20, 31), stealsBlocks=(20, 31)),
    'wnba': dict(points=(140, 180), threePointers=(10, 21), stealsBlocks=(17, 26)),
    'cbb':  dict(points=(131, 169), threePointers=(12, 20), stealsBlocks=(14, 25)),
    'wcbb': dict(points=(116, 154), threePointers=( 8, 17), stealsBlocks=(17, 30)),
}

MARGINS = { 'nba': (3,8,15,30), 'wnba': (3,8,15,30), 'cbb': (3,8,15,30), 'wcbb': (3,8,15,30) }

def nr(value, floor, ceiling):
    return max(0.0, min(1.0, ((value or 0) - floor) / (ceiling - floor)))

def calc_stats(home, away, total_pts, sport):
    r = RANGES[sport]
    threes = (home.get(THREE_KEY) or 0) + (away.get(THREE_KEY) or 0)
    sb     = (home.get('steals') or 0) + (away.get('steals') or 0) \
           + (home.get('blocks') or 0) + (away.get('blocks') or 0)
    components = {
        'points':        nr(total_pts, *r['points']),
        'threePointers': nr(threes,    *r['threePointers']),
        'stealsBlocks':  nr(sb,        *r['stealsBlocks']),
    }
    weights = dict(points=0.20, threePointers=0.45, stealsBlocks=0.35)
    raw = sum(components[k] * weights[k] for k in weights)
    return max(1, round(raw * MAX_BONUS)), components

def closeness(margin, is_ot, sport):
    great, good, ok, blowout = MARGINS[sport]
    if is_ot or margin == 0: return 60
    if margin <= great:  return 60
    if margin <= good:   return 45
    if margin <= ok:     return 29
    if margin <= blowout:return 10
    return 0

def label(score):
    if score >= 80: return 'Must Watch'
    if score >= 60: return 'Exciting'
    if score >= 40: return 'Worth It'
    if score >= 20: return 'So-So'
    return 'Skip It'

# ── Rescore ───────────────────────────────────────────────────────────────────
rescored = []
for g in games:
    sport = g['sport']
    raw_s = g.get('rawStatsData')
    if raw_s:
        total_pts = g['homeScore'] + g['awayScore']
        new_stats, components = calc_stats(raw_s['home'], raw_s['away'], total_pts, sport)
    else:
        new_stats, components = g['statsBonus'], None

    cls = closeness(g['margin'], g['isOT'], sport)
    raw = cls + g['otBon'] + g['comebackBon'] + g['momentumBonus'] + g['upsetBonus'] + new_stats
    new_score = min(100, round(raw))

    rescored.append({**g, 'statsBonus': new_stats, 'statsBonusComponents': components,
                     'excitement': new_score, 'label': label(new_score), 'closeness': cls})

# ── Comparison ────────────────────────────────────────────────────────────────
print(f"\n{'='*68}")
print(f"CALIBRATION COMPARISON  (old = NBA ranges for all, new = sport-specific)")
print(f"{'='*68}\n")

for sport in ['nba', 'wnba', 'cbb', 'wcbb']:
    old_e = [g['excitement']  for g in games    if g['sport'] == sport]
    new_e = [g['excitement']  for g in rescored  if g['sport'] == sport]
    old_s = [g['statsBonus']  for g in games    if g['sport'] == sport]
    new_s = [g['statsBonus']  for g in rescored  if g['sport'] == sport]

    print(f"{sport.upper()}  (n={len(old_e)})")
    print(f"  {'Metric':<20} {'old':>8}  {'new':>8}  {'delta':>8}")
    print(f"  {'-'*46}")
    for lbl, a, b in [
        ('excitement mean',   np.mean(old_e),              np.mean(new_e)),
        ('excitement p75',    np.percentile(old_e, 75),    np.percentile(new_e, 75)),
        ('excitement p90',    np.percentile(old_e, 90),    np.percentile(new_e, 90)),
        ('stats mean',        np.mean(old_s),              np.mean(new_s)),
        ('stats max',         max(old_s),                  max(new_s)),
    ]:
        delta = b - a
        print(f"  {lbl:<20} {a:>8.1f}  {b:>8.1f}  {delta:>+8.1f}")

    tier_labels = ['Must Watch','Exciting','Worth It','So-So','Skip It']
    old_lc = {l: sum(1 for g in games    if g['sport']==sport and g.get('label')==l) for l in tier_labels}
    new_lc = {l: sum(1 for g in rescored  if g['sport']==sport and g['label']==l)     for l in tier_labels}
    n = len(old_e)
    print(f"\n  {'Tier':<14} {'old':>12}  {'new':>12}  delta")
    for t in tier_labels:
        oc, nc = old_lc[t], new_lc[t]
        print(f"  {t:<14} {oc:>4} ({oc/n*100:>4.1f}%)  {nc:>4} ({nc/n*100:>4.1f}%)  {nc-oc:>+4}")
    print()

# ── Top 10 per sport ──────────────────────────────────────────────────────────
print(f"\nTOP 10 PER SPORT — new scoring")
print(f"{'#':<3} {'Score':<6} {'Sport':<6} {'Date':<11} {'Matchup':<18} {'Result':<9} | {'Cls':>4} {'OT':>4} {'CB':>4} {'Mom':>4} {'Stat':>5} | Raw")
print('-' * 95)
for sport in ['nba', 'wnba', 'cbb', 'wcbb']:
    top = sorted([g for g in rescored if g['sport']==sport], key=lambda g: g['excitement'], reverse=True)[:10]
    for i, g in enumerate(top):
        matchup = f"{g['away']}@{g['home']}"
        result  = f"{g['awayScore']}-{g['homeScore']}" + (' OT' if g['isOT'] else '')
        raw = g['closeness']+g['otBon']+g['comebackBon']+g['momentumBonus']+g['upsetBonus']+g['statsBonus']
        print(f"{i+1:<3} {g['excitement']:<6} {sport.upper():<6} {g['date']:<11} {matchup:<18} {result:<9} | "
              f"{g['closeness']:>4} {g['otBon']:>4} {g['comebackBon']:>4} {g['momentumBonus']:>4} "
              f"{g['statsBonus']:>5} | {raw}")
    print()

with open(OUT, 'w') as f:
    json.dump(rescored, f, indent=2)
print(f"Saved → {OUT}")
