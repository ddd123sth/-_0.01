import { fingerprint, freeze } from './common.mjs';

// Immutable bootstrap caches only. The source game version selects a resource
// URL/cache candidate; capabilities are selected exclusively by wire contract.
// These ids fingerprint normalized business tables, not manifest text or URLs.
const TABLES = freeze({
  '480.0.27': {
    c_item: '3d6b64484b042c316703ad306172b1532ab97064f753d39d1338ed2d9226b25f',
    c_farmLand: 'dcf56f3add7b5aec05f7dec2327744fd0af6958fbbd8e25677abdfab1891462f',
    c_flower: 'bb94c2badd2205c7f76041dcdeef22ec0105bac39d2c3a7fdc3c4c6df963dd92',
    c_flowerLvl: '9b463b6289fcdb02e053afd7d04db7808db7ed81ac7709d83fd8a25360d556e1',
    c_flowerLvlCfg: 'e736177d4ae3700e87e0a2c3d5e2baaadf6c4128727ce750aa85e778f672077d',
    c_flowerArt: 'a285efc1d1d7ab1e008f66a030ef8ff111e5268cf30af3256cf6c351ffcf767c',
  },
  '480.0.46': {
    c_item: '67badfb8604c89758f2db201f8dd84112dabb577945895e285285254b9f80912',
    c_farmLand: 'dcf56f3add7b5aec05f7dec2327744fd0af6958fbbd8e25677abdfab1891462f',
    c_flower: '24b88e83ec0c299f2ff2133a31e08f7c924f71782efa9878edd165d355d6bb3d',
    c_flowerLvl: '9b463b6289fcdb02e053afd7d04db7808db7ed81ac7709d83fd8a25360d556e1',
    c_flowerLvlCfg: 'e736177d4ae3700e87e0a2c3d5e2baaadf6c4128727ce750aa85e778f672077d',
    c_flowerArt: '32328629914a29540a974b86ebffdfe091c61668deedeea444cb0a8dad8d98be',
  },
});
const IDS = freeze(Object.fromEntries(Object.entries(TABLES).map(([sourceVersion, tables]) =>
  [sourceVersion, 'sha256:' + fingerprint(tables)])));

export function officialDataSnapshotForSourceVersion(gameVersion) {
  const dataSnapshotId = IDS[gameVersion];
  return dataSnapshotId ? freeze({ dataSnapshotId, sourceVersion: gameVersion, tableHashes: TABLES[gameVersion] }) : null;
}

export const knownOfficialDataSnapshots = () => freeze(Object.fromEntries(Object.entries(IDS).map(([version, id]) => [id, { sourceVersion: version, tableHashes: TABLES[version] }])));
