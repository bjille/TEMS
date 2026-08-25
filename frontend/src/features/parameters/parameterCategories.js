export const UNCATEGORIZED_LABEL = 'Overig';

export function categoryLabel(category) {
  return category && category.trim() ? category.trim() : UNCATEGORIZED_LABEL;
}

/**
 * Category names to offer in a filter/select: every managed category, plus
 * any legacy free-text value still present on the given parameters that
 * isn't (or is no longer) part of the managed list.
 */
export function collectCategories(parameters, managedCategories = []) {
  const set = new Set(managedCategories.map((c) => c.name));
  parameters.forEach((p) => {
    if (p.category && p.category.trim()) set.add(p.category.trim());
  });
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Groups parameters by category label, sorting groups and members alphabetically. */
export function groupByCategory(parameters) {
  const groups = new Map();
  parameters.forEach((p) => {
    const key = categoryLabel(p.category);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === UNCATEGORIZED_LABEL) return 1;
    if (b === UNCATEGORIZED_LABEL) return -1;
    return a.localeCompare(b);
  });
  return sortedKeys.map((key) => ({
    category: key,
    parameters: groups.get(key).sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

const SORTERS = {
  label: (a, b) => a.label.localeCompare(b.label),
  category: (a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)) || a.label.localeCompare(b.label),
  type: (a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label),
  unit: (a, b) => (a.unit || '').localeCompare(b.unit || '') || a.label.localeCompare(b.label),
};

export function sortParameters(parameters, sortBy, sortDir = 'asc') {
  const sorter = SORTERS[sortBy] || SORTERS.label;
  const sorted = [...parameters].sort(sorter);
  return sortDir === 'desc' ? sorted.reverse() : sorted;
}
