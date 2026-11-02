import { freeze } from '../../common.mjs';

const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const quantity = input => typeof input === 'number' ? { known: amount(input), value: input } : input;

export function planStockCapacity({ flowerId, target, stockConfirmed, yieldExpected, yieldReserved, groupCapacity }) {
  if (!Number.isSafeInteger(groupCapacity) || groupCapacity < 0 || !Number.isSafeInteger(target) || target < 0) {
    return freeze({ known: false, flowerId, capacity: 0, reasonCode: 'LAND_STOCK_INPUT_INVALID' });
  }
  if (target === 0) return freeze({ known: true, flowerId, capacity: groupCapacity, targetApplied: false, reasonCode: null });
  const stock = quantity(stockConfirmed), expected = quantity(yieldExpected), reserved = quantity(yieldReserved);
  // Unreadable future yield cannot create a deficit when confirmed inventory
  // alone already satisfies the target. Do not turn that proven no-op into a
  // permanent wait for unrelated crop fields.
  if (stock?.known === true && amount(stock.value) && stock.value >= target &&
      ![expected, reserved].every(item => item?.known === true && amount(item.value))) {
    return freeze({ known: true, flowerId, capacity: 0, targetApplied: true, gapUpperBound: target - stock.value,
      reasonCode: 'LAND_STOCK_TARGET_REACHED' });
  }
  if (![stock, expected, reserved].every(item => item?.known === true && amount(item.value))) {
    return freeze({ known: false, flowerId, capacity: 0, reasonCode: 'LAND_POSITIVE_TARGET_YIELD_UNKNOWN' });
  }
  const gap = target - stock.value - expected.value - reserved.value;
  if (gap <= 0) return freeze({ known: true, flowerId, capacity: 0, targetApplied: true, gap, reasonCode: 'LAND_STOCK_TARGET_REACHED' });
  // One smallest indivisible plot may exceed the remaining branch target.
  // A caller must supply an evidenced per-plot yield, never a default of one.
  const perPlot = expected.perPlot ?? reserved.perPlot;
  if (!amount(perPlot) || perPlot === 0) return freeze({ known: false, flowerId, capacity: 0, gap,
    reasonCode: 'LAND_PER_PLOT_YIELD_UNKNOWN' });
  return freeze({ known: true, flowerId, capacity: Math.min(groupCapacity, Math.ceil(gap / perPlot)),
    targetApplied: true, gap, perPlot, reasonCode: null });
}
