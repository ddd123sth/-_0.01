import { auxDate } from './auxiliary-contract.mjs';
import { sameOrderFlowerContext } from './wire-facts.mjs';

const clone = value => value == null ? value : structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, String(key));
const validSource = source => source && source.kind === 'response' && typeof source.responseRef === 'string' &&
  source.responseRef.length > 0 && Number.isSafeInteger(source.requestSequence) && source.requestSequence > 0 &&
  Number.isSafeInteger(source.connectionEpoch) && source.connectionEpoch > 0;
const unknown = (reasonCode, detail = {}) => ({ known: false, presence: 'unknown', reasonCode, ...detail });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const dateValue = value => { const ms = auxDate(value); return ms == null ? { valid: false } : { valid: true, value: ms }; };
const nullableDate = value => value === null ? { valid: true, value: null } : dateValue(value);

function mergeCells({ previous, raw, source, context, officialUid, id, kind, fields, requiredFor, deleted }) {
  if (!validSource(source)) return previous ?? unknown(kind + '_ROW_SOURCE_INVALID');
  if (deleted(raw)) return { known: true, presence: 'absent-by-explicit-delete', officialUid, boundOfficialUid: officialUid,
    context: clone(context), type: null, boundType: id, source: clone(source), fieldSources: {}, invalidFields: {}, valid: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return unknown(kind + '_ROW_VALUE_INVALID', { officialUid, boundOfficialUid: officialUid, context: clone(context),
      type: null, boundType: id, source: clone(source), fieldSources: clone(previous?.fieldSources ?? {}),
      invalidFields: { row: kind + '_ROW_VALUE_INVALID' } });
  }
  const compatible = previous && previous.presence !== 'absent-by-explicit-delete' &&
    (previous.boundOfficialUid ?? previous.officialUid) === officialUid && (previous.boundType ?? previous.type) === id &&
    sameOrderFlowerContext(previous.context, context);
  const values = compatible ? Object.fromEntries(fields.filter(([, name]) => own(previous, name)).map(([, name]) => [name, clone(previous[name])])) : {};
  const fieldSources = compatible ? clone(previous.fieldSources ?? {}) : {};
  const invalidFields = compatible ? clone(previous.invalidFields ?? {}) : {};
  let conflict = null;
  for (const [wire, name, parse] of fields) {
    if (!own(raw, wire)) continue;
    const parsed = parse(raw[wire]);
    if (!parsed.valid || (name === 'uid' && parsed.value !== officialUid) ||
        (['type', 'shareId'].includes(name) && parsed.value !== id)) {
      conflict = !parsed.valid ? kind + '_FIELD_INVALID_' + name.toUpperCase() : kind + '_IDENTITY_CONFLICT_' + name.toUpperCase();
      values[name] = null;
      fieldSources[name] = clone(source);
      invalidFields[name] = conflict;
      continue;
    }
    values[name] = clone(parsed.value);
    fieldSources[name] = clone(source);
    delete invalidFields[name];
  }
  const complete = !conflict && requiredFor(values).every(name => own(fieldSources, name) && own(values, name) && !invalidFields[name]);
  return { known: complete, presence: complete ? 'present' : 'unknown',
    reasonCode: conflict || (complete ? null : kind + '_INITIAL_REQUIRED_CELLS_MISSING'), officialUid,
    boundOfficialUid: officialUid, context: clone(context), type: values.type ?? null, boundType: id,
    ...values, source: clone(source), fieldSources, invalidFields, valid: complete };
}

export function mergeOrderFlowerCardCellRow({ previous, outerMap, id, source, context, officialUid } = {}) {
  if (!outerMap || typeof outerMap !== 'object' || Array.isArray(outerMap)) return previous ?? unknown('CARD_MAP_NOT_PROVIDED');
  if (!own(outerMap, id)) return previous ?? unknown('CARD_ROW_NOT_YET_KNOWN');
  return mergeCells({ previous, raw: outerMap[String(id)], source, context, officialUid, id, kind: 'CARD',
    fields: [['0', 'uid', v => positive(v) ? { valid: true, value: v } : { valid: false }],
      ['1', 'type', v => positive(v) ? { valid: true, value: v } : { valid: false }],
      ['2', 'isMain', v => [0, 1, false, true].includes(v) ? { valid: true, value: v === true || v === 1 } : { valid: false }],
      ['5', 'invalidTime', nullableDate]],
    requiredFor: values => values.isMain === true ? ['uid', 'type', 'isMain'] : ['uid', 'type', 'isMain', 'invalidTime'],
    deleted: value => !value });
}

export function mergeOrderFlowerShareCellRow({ previous, outerMap, id, source, context, officialUid } = {}) {
  if (!outerMap || typeof outerMap !== 'object' || Array.isArray(outerMap)) return previous ?? unknown('SHARE_MAP_NOT_PROVIDED');
  if (!own(outerMap, id)) return previous ?? unknown('SHARE_ROW_NOT_YET_KNOWN');
  return mergeCells({ previous, raw: outerMap[String(id)], source, context, officialUid, id, kind: 'SHARE',
    fields: [['0', 'uid', v => positive(v) ? { valid: true, value: v } : { valid: false }],
      ['1', 'shareId', v => positive(v) ? { valid: true, value: v } : { valid: false }],
      ['2', 'shareCnt', v => nonnegative(v) ? { valid: true, value: v } : { valid: false }],
      ['3', 'recvCnt', v => nonnegative(v) ? { valid: true, value: v } : { valid: false }],
      ['4', 'recvTime', nullableDate], ['5', 'total', v => nonnegative(v) ? { valid: true, value: v } : { valid: false }],
      ['6', 'uTime', dateValue]],
    requiredFor: () => ['uid', 'shareId', 'shareCnt', 'recvCnt', 'total', 'uTime'], deleted: () => false });
}
