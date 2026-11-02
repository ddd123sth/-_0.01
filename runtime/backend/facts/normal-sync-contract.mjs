// Domain projections share one finite matched-sync vocabulary. This is a
// source interpretation contract, never permission to send a method: registry,
// proposal admission and the one-use gateway permit remain separate gates.
export const NORMAL_SYNC_METHODS = Object.freeze([
  'index.login', 'usr.heartTick', 'usrLand.refresh', 'usrLand.plant', 'usrLand.water', 'usrLand.harvest',
  'orderCustomer.finishOrder', 'orderCustomer.rejectOrder', 'orderCustomer.genOrder', 'flowerArt.makeFlowerArt',
  'orderFlower.finishOrder', 'orderFlower.finishSatinOrder', 'orderFlower.finishDecorateOrder',
  'orderFlower.enter', 'orderFlower.recvOrderRwd', 'usr.share', 'taskAch.recv',
]);
const methods = new Set(NORMAL_SYNC_METHODS);
const landAccelerationMethods = new Set(['usrLand.speedUp', 'usrLand.speedUpFree']);
export const isNormalSyncMethod = method => methods.has(method);
export const isLandAccelerationMethod = method => landAccelerationMethods.has(method);
