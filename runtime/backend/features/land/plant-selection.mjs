import { fingerprint, freeze } from '../../common.mjs';
import { timedSyncPhase } from '../../../performance-diagnostics.mjs';
import { field, positiveId, valueOf } from './rpc-contract.mjs';

export function selectPlantCandidates({ view, config, catalog, resources, groups, context = view?.context }) {
  return timedSyncPhase('land.select', () => {
    if (typeof catalog?.withSourceReadiness === 'function') {
      return catalog.withSourceReadiness(() => selectPlantCandidatesInScope({ view, config,
        catalog, resources, groups, context }));
    }
    return selectPlantCandidatesInScope({ view, config, catalog, resources, groups, context });
  });
}

function selectPlantCandidatesInScope({ view, config, catalog, resources, groups, context = view?.context }) {
  const excluded = [], candidates = [], mode = config.plantMode;
  const supportedModes = ['least_stock', 'chosen_flowers', 'chosen_quality', 'chosen_top'];
  if (!supportedModes.includes(mode)) return freeze({ known: false, candidates, excluded, reasonCode: 'LAND_PLANT_MODE_INVALID', poolBasis: null });
  if (!view?.current || view.identity?.verified !== true) return freeze({ known: false, candidates, excluded, reasonCode: 'LAND_IDENTITY_NOT_CURRENT', poolBasis: null });
  let top = null;
  if (mode === 'chosen_top') {
    top = valueOf(view.top);
    if (!Array.isArray(top)) return freeze({ known: false, candidates, excluded, reasonCode: 'LAND_TOP_NOT_OBSERVED', poolBasis: null });
  }
  const chosen = new Set(config.plantFlowerIds), qualities = new Set(config.plantQualities), blacklist = new Set(config.plantBlacklistIds);
  const topSet = new Set(top || []), basis = [], selectionRows = [];
  let stockPoolIncomplete = false;
  for (const cultivation of Object.values(view.cultivates || {}).sort((a, b) => a.flowerId - b.flowerId)) {
    const flowerId = cultivation.flowerId;
    const deny = reasonCode => selectionRows.push({ flowerId, reasonCode });
    if (!positiveId(flowerId) || cultivation.current !== true || cultivation.valid !== true || cultivation.removed ||
        field(cultivation, 'status') !== 2 || field(cultivation, 'flowerId') !== flowerId) {
      deny('LAND_FLOWER_NOT_CURRENTLY_PLANTABLE'); continue;
    }
    if (blacklist.has(flowerId)) { deny('LAND_FLOWER_BLACKLISTED'); continue; }
    if (mode === 'chosen_flowers' && !chosen.has(flowerId) || mode === 'chosen_top' && !topSet.has(flowerId)) continue;
    const support = catalog.supports({ purpose: 'plant', flowerId, fields: mode === 'chosen_quality' ? ['id', 'color'] : ['id'] });
    if (support?.supported !== true || !catalog.flower(flowerId)) { deny(support?.reasonCode || 'LAND_CATALOG_FLOWER_UNSUPPORTED'); continue; }
    const quality = catalog.flowerQuality(flowerId);
    const qualityValue = typeof quality === 'number' ? quality : quality?.value;
    if (mode === 'chosen_quality' && (!Number.isSafeInteger(qualityValue) || !qualities.has(qualityValue))) {
      deny(Number.isSafeInteger(qualityValue) ? 'LAND_QUALITY_NOT_SELECTED' : 'LAND_FLOWER_QUALITY_UNKNOWN'); continue;
    }
    selectionRows.push({ flowerId, cultivation, qualityValue });
  }
  const eligibleIds = selectionRows.filter(row => row.cultivation).map(row => row.flowerId);
  const hasBatchReader = typeof resources.balanceBatch === 'function';
  const stockBatch = eligibleIds.length && hasBatchReader && eligibleIds.length <= 8192
    ? resources.balanceBatch({ context, itemIds: eligibleIds }) : null;
  const stockByFlower = stockBatch && stockBatch.items && typeof stockBatch.items === 'object' ? stockBatch.items : null;
  for (const row of selectionRows) {
    const flowerId = row.flowerId;
    if (!row.cultivation) { excluded.push({ flowerId, reasonCode: row.reasonCode }); continue; }
    const cultivation = row.cultivation, qualityValue = row.qualityValue;
    const stock = hasBatchReader ? stockByFlower?.[String(flowerId)] : resources.balance({ context, itemId: flowerId });
    if (stock?.effective?.known !== true || !Number.isFinite(stock.effective.value) || stock.effective.value < 0) {
      stockPoolIncomplete = true;
      basis.push({ flowerId, cultivationVersion: cultivation.semanticVersion, accountingVersion: stock?.accountingVersion ?? null,
        stock: null, stockKnown: false, quality: mode === 'chosen_quality' ? qualityValue : null });
      excluded.push({ flowerId, reasonCode: 'LAND_FLOWER_STOCK_UNKNOWN' }); continue;
    }
    const occupied = groups.flowerOccupancy(flowerId);
    const availableCapacity = Math.max(0, config.groupSize - occupied);
    basis.push({ flowerId, cultivationVersion: cultivation.semanticVersion, accountingVersion: stock.accountingVersion,
      stock: stock.effective.value, occupied, quality: mode === 'chosen_quality' ? qualityValue : null });
    if (!availableCapacity) { excluded.push({ flowerId, reasonCode: 'LAND_SAME_FLOWER_CAPACITY_REACHED' }); continue; }
    candidates.push({ flowerId, stockConfirmed: stock.effective.value, stockBasisRef: stock.base?.basisRef ?? null,
      availableCapacity, cultivationVersion: cultivation.semanticVersion, accountingVersion: stock.accountingVersion });
  }
  candidates.sort((a, b) => a.stockConfirmed - b.stockConfirmed || a.flowerId - b.flowerId);
  const poolBasis = { version: 'land-pool/v1', mode, members: basis, scope: 'observed-supported-current-eligible-pool',
    top: mode === 'chosen_top' ? [...top].sort((a, b) => a - b) : null, catalog: catalog.identity().manifestSha256 };
  return freeze({ known: !stockPoolIncomplete, candidates: stockPoolIncomplete ? [] : candidates, excluded, poolBasis, fingerprint: fingerprint(poolBasis),
    reasonCode: stockPoolIncomplete ? 'LAND_PLANT_POOL_STOCK_INCOMPLETE' : candidates.length ? null : excluded.length ? excluded[0].reasonCode : 'LAND_PLANT_POOL_EMPTY' });
}
