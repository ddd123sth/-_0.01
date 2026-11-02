const CANONICAL_ALIASES = Object.freeze({
  '交订单': Object.freeze(['交订单', '订单']),
});

const ALIAS_TO_CANONICAL = new Map(Object.entries(CANONICAL_ALIASES)
  .flatMap(([canonical, aliases]) => aliases.map(alias => [alias, canonical])));

export function canonicalLogCategory(category) {
  return typeof category === 'string' ? ALIAS_TO_CANONICAL.get(category) || category : category;
}

export function logCategoryAliases(category) {
  const canonical = canonicalLogCategory(category);
  return Object.hasOwn(CANONICAL_ALIASES, canonical) ? [...CANONICAL_ALIASES[canonical]] : [category];
}

export function canonicalLogCategories(categories) {
  return [...new Set((Array.isArray(categories) ? categories : []).map(canonicalLogCategory))].sort();
}
