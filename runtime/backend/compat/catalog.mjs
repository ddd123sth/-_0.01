import fs from 'node:fs';
import { clone, freeze } from '../common.mjs';
import { createOfficialLandCatalog } from '../features/land/catalog.mjs';

const historical = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const official = createOfficialLandCatalog();
// The existing picker keeps its DTO and components. Current public names and
// item quality come from the same verified catalog used by the land domain.
// Legacy-only IDs remain visible/saveable so opening a draft cannot drop an
// old selection; execution still requires the current catalog and live status2.
const currentFlowers = official.ordinaryFlowerIds().map(id => ({ id,
  name: official.item(id)?.name || historical.flowers.find(row => row.id === id)?.name || String(id),
  quality: official.flowerQuality(id) }));
const currentIds = new Set(currentFlowers.map(row => row.id));
const legacyOnly = historical.flowers.filter(row => !currentIds.has(row.id));
const catalog = freeze({ ...historical, flowers: [...currentFlowers, ...legacyOnly],
  source: { ...historical.source, flowers: { current: official.identity(), currentCount: currentFlowers.length,
    preservedLegacyCount: legacyOnly.length, preservationGrantsExecution: false } } });
export const readCatalog = () => clone(catalog);
export const configCatalogs = Object.freeze({ flowerIds: new Set(catalog.flowers.map(row => row.id)), artIds: new Set(catalog.flowerArts.map(row => row.id)) });
