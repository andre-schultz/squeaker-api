// Shared helpers used by the stats-derived services (statsBonus, approxStats).

// Null-safe addition of two numeric stat fields.
export function sum(a, b) {
  return (a || 0) + (b || 0);
}

// ESPN packs made + attempted three-pointers under a single combined key.
export const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
