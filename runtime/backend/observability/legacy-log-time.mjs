// Reviewed legacy db.js localStamp uses the product's UTC+08:00 wall clock.
// Never pass a zone-less legacy timestamp to the host-dependent Date parser.
export function legacyLogTime(value) {
  if (typeof value !== 'string') return null;
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(value);
  const zoned = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const parts = local || zoned;
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, fraction = ''] = parts;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, mo - 1, d);
  calendar.setUTCHours(h, mi, s, 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59
    || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return null;
  const zone = local ? '+08:00' : parts[8];
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0').slice(0, 3)}${zone}`;
  const epoch = Date.parse(normalized);
  return Number.isFinite(epoch) ? { iso: new Date(epoch).toISOString(), original: value,
    sourceFormat: local ? 'legacy_local_stamp_utc_plus_08' : 'iso_explicit_zone' } : null;
}
