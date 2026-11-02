const ROUTE_FLAGS = Object.freeze(['openAdRewardSdk', 'nativeAbSwitch']);

function routeBoolean(value, name) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  return name === 'openAdRewardSdk' ? Boolean(Number(value)) : Boolean(value);
}
function hasOwnValue(object, key) {
  return object !== null && typeof object === 'object' && !Array.isArray(object) && Object.prototype.hasOwnProperty.call(object, key);
}
function safeUrlRoutes(url, source) {
  if (typeof url !== 'string' || url.length > 4096) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return Object.fromEntries(ROUTE_FLAGS.map(name => {
      const all = parsed.searchParams.getAll(name);
      if (all.length > 1) return [name, { known: false, value: null, source: `${source}.query.${name}` }];
      if (!all.length) return [name, { known: true, value: false, source: `${source}.query.${name}:absent-default` }];
      const value = routeBoolean(all[0], name);
      return [name, value === null ? { known: false, value: null, source: `${source}.query.${name}` }
        : { known: true, value, source: `${source}.query.${name}` }];
    }));
  } catch { return null; }
}

// Retain only the two effective flags consumed by the game's normal login
// route. No ad SDK identity, placement, plugin, or arbitrary config shape is
// collected or persisted.
export function createEffectiveAdPlaybackRouteCollector() {
  let effectiveRouteInput = null, routingLandingUrl = null;
  function capture(source, body) {
    if (source === 'SDKlogin') routingLandingUrl = safeUrlRoutes(body?.url, 'SDKlogin.url');
  }
  function setEffectiveRouteInput({ userParams, source, known = false } = {}) {
    const fields = {};
    for (const name of ROUTE_FLAGS) if (hasOwnValue(userParams, name)) {
      const value = routeBoolean(userParams[name], name);
      fields[name] = { known: value !== null, value, rawTruthy: Boolean(userParams[name]), source: `${source || 'unknown'}.${name}` };
    }
    effectiveRouteInput = { fields, source: source || null, known: known === true };
    return snapshot();
  }
  function snapshot() {
    function resolvedFlag(name) {
      const candidate = effectiveRouteInput?.fields?.[name];
      if (!effectiveRouteInput?.known) return { known: false, value: null, source: candidate?.source || null,
        reasonCode: 'SDK_LOGIN_PARAMS_UNRESOLVED' };
      if (candidate && candidate.rawTruthy) return candidate.known
        ? { known: true, value: candidate.value, source: candidate.source }
        : { known: false, value: null, source: candidate.source, reasonCode: 'SDK_OPTION_VALUE_UNRECOGNIZED' };
      const fallback = routingLandingUrl?.[name];
      if (fallback?.known) return { known: true, value: fallback.value, source: fallback.source };
      return { known: false, value: null, source: candidate?.source || null, reasonCode: 'SDK_OPTION_FALLBACK_UNOBSERVED' };
    }
    const openAdRewardSdk = resolvedFlag('openAdRewardSdk'), nativeAbSwitch = resolvedFlag('nativeAbSwitch');
    return { source: 'official-sdk-effective-ad-route/v1', known: openAdRewardSdk.known && nativeAbSwitch.known,
      openAdRewardSdk, nativeAbSwitch,
      resolution: 'USER_PARAMS[name] || GAME_URL_QUERY[name] || empty-default; openAdRewardSdk=Boolean(Number(option)); nativeAbSwitch=Boolean(option)' };
  }
  return Object.freeze({ capture, setEffectiveRouteInput, snapshot });
}
