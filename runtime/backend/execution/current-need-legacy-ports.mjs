const REQUIRED_PORTS = Object.freeze(['candidateProjection', 'validateResourceBaseline', 'appendBasis', 'currentAdmission']);

// Current-need consumers share one deliberately narrow view of archived
// evidence. Keep the port list explicit and fail startup when composition
// omits a synchronous validator needed by any domain.
export function createCurrentNeedLegacyPorts(source) {
  if (!source || typeof source !== 'object') throw new TypeError('Current-need legacy ports require a source adapter');
  const ports = {};
  for (const name of REQUIRED_PORTS) {
    const fn = source[name];
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Current-need legacy port must be synchronous: ' + name);
    }
    ports[name] = fn;
  }
  if (source.resourceFootprints !== undefined) {
    if (typeof source.resourceFootprints !== 'function' || source.resourceFootprints.constructor?.name === 'AsyncFunction')
      throw new TypeError('Legacy resource footprint projection must be synchronous');
    ports.resourceFootprints = source.resourceFootprints;
  }
  return Object.freeze(ports);
}
