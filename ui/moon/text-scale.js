/* Scale only declared moon typography, in its original stylesheet/cascade position.
 * The native onGardenWindow contract owns --g-text-scale. Do not sample computed
 * element sizes: inherited/legacy tokens may already include that scale.
 * Runtime CSSOM adaptation also survives regeneration of moon.css/metrics.css. */

const MOON_SOURCES = new Map(['moon.css', 'metrics.css', 'formal-dialogs.css', 'feedback.css'].map(name => {
  const url = new URL(`./${name}`, import.meta.url);
  return [`${url.origin}${url.pathname}`, name];
}));
const PIXEL_LENGTH = /^(?:\d+(?:\.\d+)?|\.\d+)px$/i;
const PROPERTIES = ['font-size', 'line-height'];
let installed;

function moonSource(href) {
  try {
    const url = new URL(href, document.baseURI);
    if (url.origin !== location.origin) return null;
    return MOON_SOURCES.get(`${url.origin}${url.pathname}`) || null;
  } catch { return null; }
}

export function installMoonTextScale() {
  if (installed) { installed.refresh(); return installed; }
  const records = new Map();
  const boundLinks = new WeakSet();
  let scheduled = false;

  function issue(record, operation, error) {
    const name = typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
    const code = `${operation}:${name}`;
    if (!record.issues.includes(code) && record.issues.length < 8) record.issues.push(code);
  }

  function adaptStyle(style, record) {
    // Snapshot both longhands before a numeric font shorthand is reserialized.
    // font:inherit yields inherited longhands and is intentionally left alone.
    const declarations = PROPERTIES.map(property => ({
      property, value: style.getPropertyValue(property).trim(), priority: style.getPropertyPriority(property),
    }));
    for (const { property, value, priority } of declarations) {
      if (!value) continue;
      if (value.includes('--g-text-scale')) { record.scaledDeclarations++; continue; }
      if (!PIXEL_LENGTH.test(value)) { record.unchangedDeclarations++; continue; }
      try {
        style.setProperty(property, `calc(${value} * var(--g-text-scale, 1))`, priority);
        if (!style.getPropertyValue(property).includes('--g-text-scale')) {
          style.setProperty(property, value, priority);
          issue(record, property, { name: 'UnsupportedValue' });
          continue;
        }
        record.convertedDeclarations++;
        record.scaledDeclarations++;
      } catch (error) { issue(record, property, error); }
    }
  }

  function adaptRules(rules, record, seen) {
    for (const rule of rules) {
      if (rule.type === 1 && rule.style) {
        record.styleRules++;
        adaptStyle(rule.style, record);
      }
      try {
        // Includes inactive @media/@supports/@layer rules; activating one later
        // must not restore unscaled typography. Never rewrite animation geometry.
        if (rule.cssRules) adaptRules(rule.cssRules, record, seen);
        if (rule.type === 3 && rule.styleSheet && moonSource(rule.styleSheet.href) && !seen.has(rule.styleSheet)) {
          seen.add(rule.styleSheet);
          adaptRules(rule.styleSheet.cssRules, record, seen);
        }
      } catch (error) { issue(record, 'nested-cssom', error); }
    }
  }

  function scanLink(link) {
    const source = moonSource(link.href);
    if (!source) { records.delete(link); return; }
    let record = records.get(link);
    if (!record || record.source !== source || record.sheet !== link.sheet) {
      record = { source, sheet: link.sheet, status: 'pending', convertedDeclarations: 0, issues: [] };
      records.set(link, record);
    }
    record.styleRules = 0;
    record.scaledDeclarations = 0;
    record.unchangedDeclarations = 0;
    if (!link.sheet) {
      if (record.status !== 'load-error') record.status = 'pending';
      return;
    }
    record.issues = [];
    try {
      adaptRules(link.sheet.cssRules, record, new Set([link.sheet]));
      record.status = record.issues.length ? 'partial' : 'adapted';
    } catch (error) {
      record.status = 'cssom-unavailable';
      issue(record, 'stylesheet-cssom', error);
    }
  }

  function refresh() {
    const links = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter(link => moonSource(link.href));
    const current = new Set(links);
    for (const link of records.keys()) if (!current.has(link)) records.delete(link);
    for (const link of links) {
      if (!boundLinks.has(link)) {
        boundLinks.add(link);
        link.addEventListener('load', () => scanLink(link));
        link.addEventListener('error', () => {
          scanLink(link);
          const record = records.get(link);
          if (record) record.status = 'load-error';
        });
      }
      scanLink(link);
    }
  }

  function scheduleRefresh() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => { scheduled = false; refresh(); });
  }

  installed = Object.freeze({
    refresh,
    snapshot: () => ({
      source: 'moon-declared-cssom', scaleVariable: '--g-text-scale',
      expectedSources: [...MOON_SOURCES.values()],
      stylesheets: [...records.values()].map(({ sheet, ...record }) => ({ ...record, issues: [...record.issues] })),
    }),
  });
  refresh();
  // Load/error covers initially pending CSS. Observe replacement links too, but
  // never observe scale changes or multiply an already adapted declaration again.
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });
  return installed;
}
