// Per-method official refusal contract for reward/upgrade writes.
//
// Why this file exists: an answered reply whose frame carries a rejection code is
// not automatically "this request did nothing". Only the official client message
// table can say what a code means, and a code only means something for the method
// whose own business object its text names. A generic "不足" borrowed from another
// action is exactly the kind of blanket failure this contract must refuse.
//
// Evidence source (vendored official config, present in this repository):
//   vendor/garden-engine/server/data/official-cfg/c_msgCode.json
// Every code below is listed with its exact official text; tests/official-refusal
// asserts the texts still match that table, so a table update that changes a
// wording fails the contract instead of silently widening the exit.
//
// Two classes only, both of which the server answered (transport=answered) for
// this exact wire request:
//   consumed  - the official text states the target was already obtained. This
//               request therefore produced no new effect AND the opportunity is
//               already gone; it must never be retried or credited.
//   refused   - the official text states a precondition of this same action was
//               not met (insufficient item/currency, limit reached, cooldown,
//               sold out, not unlocked, nothing to harvest). Nothing was spent,
//               but the opportunity may still exist later: a bounded backoff is
//               recorded, and no quota is charged.
//
// Everything else stays unknown: a bare `rejected` flag, a presentation notice
// ({msg,type}), a string key we have no official text for, a push, a transport
// failure or an HTTP/connection error never enters this exit.
export const OFFICIAL_REFUSAL_VERSION = 'rewards/official-refusal/v1';

// Exact official text of every code this contract accepts. The texts are the
// semantic evidence; keep them verbatim so a mismatched official table is caught.
export const OFFICIAL_REFUSAL_TEXT = Object.freeze({
  12: '没次数了',
  204: '元宝不足，请前往充值！',
  206: '购买次数已达上限',
  219: '操作次数已达上限',
  251: '奖励已领取，无法再次领取该奖励！',
  258: '奖励已领取，无法再次领取该奖励！',
  301: '$@{item|${iid}}不足',
  304: '静态商城无法刷新',
  305: '刷新次数已达上限',
  306: '刷新冷却中',
  312: '无法再购买当前商品',
  313: '日限购不足',
  314: '周限购次数不足',
  315: '月限购次数不足',
  316: '总限购次数不足',
  320: '商品已售罄',
  335: '已领取过该奖励',
  359: '贡献度不足',
  363: '公会财富不足',
  383: '每日建设次数已达上限',
  386: '奖励已领取',
  498: '刷新cd中，无法刷新',
  625: '刷新次数已达上限',
  629: '刷新次数已达上限',
  2038: '暂无收获',
  2154: '当前已在种植中',
  2166: '暂无空闲土地',
  2601: '货架未解锁',
  3046: '暂未有可收获的鲜花',
});

// The reward-claim family shares one official wording for "this reward was
// already collected"; every claim method can legitimately receive it.
const ALREADY_CLAIMED = Object.freeze([251, 258, 335, 386]);
const NO_ATTEMPT_LEFT = Object.freeze([12, 219]);

// method -> the codes that method's own business object can raise. A method that
// is absent here has no refusal exit at all.
export const METHOD_REFUSALS = Object.freeze({
  'mail.pickOneKey': Object.freeze({ consumed: ALREADY_CLAIMED }),
  'taskDly.recv': Object.freeze({ consumed: ALREADY_CLAIMED }),
  'taskDly.recvBox': Object.freeze({ consumed: ALREADY_CLAIMED, refused: NO_ATTEMPT_LEFT }),
  'taskWeek.recv': Object.freeze({ consumed: ALREADY_CLAIMED }),
  'taskMain.recv': Object.freeze({ consumed: ALREADY_CLAIMED }),
  'benefitBox.draw': Object.freeze({ consumed: ALREADY_CLAIMED, refused: NO_ATTEMPT_LEFT }),
  'storyMain.unlock': Object.freeze({ refused: Object.freeze([301, 219]) }),
  // usr.share serves the free gift bag, the double-coin renewal and the guild
  // video build: all three are refused by attempt/share limits only.
  'usr.share': Object.freeze({ refused: Object.freeze([12, 219, 206]) }),
  'fml.bld': Object.freeze({ refused: Object.freeze([206, 219, 301, 359, 363, 383]) }),
  'fmlLand.harvestAll': Object.freeze({ refused: Object.freeze([12, 219, 2038, 3046]) }),
  'fmlLand.plant': Object.freeze({ refused: Object.freeze([219, 301, 2154, 2166]) }),
  'fmlLand.unlock': Object.freeze({ refused: Object.freeze([206, 219, 301, 359]) }),
  'fmlLand.upgrade': Object.freeze({ refused: Object.freeze([206, 219, 301, 359]) }),
  'shopCultivate.buy': Object.freeze({ refused: Object.freeze([204, 206, 219, 301, 312, 313, 314, 315, 316, 320, 2601]) }),
  'shopCultivate.refresh': Object.freeze({ refused: Object.freeze([12, 219, 304, 305, 306, 498, 625, 629]) }),
  'cultivate.upgrade': Object.freeze({ refused: Object.freeze([204, 219, 301]) }),
});

export const REJECTION_STATES = Object.freeze({ consumed: 'rejected-consumed', refused: 'rejected-refused' });
// How long a precondition refusal may keep its exact target out of the send path.
// Shorter than a card's own day, long enough that a stale fact read cannot turn
// one refusal into a hot send loop.
export const REFUSAL_BACKOFF_MS = 10 * 60 * 1000;

export function refusalCodeSet(method) {
  const table = METHOD_REFUSALS[method];
  if (!table) return Object.freeze([]);
  return Object.freeze([...(table.consumed || []), ...(table.refused || [])]);
}

// Returns null unless the exact answered reply for this method carries an
// official code whose own wording proves the refusal class.
export function classifyOfficialRefusal({ method, action = null, response } = {}) {
  if (typeof method !== 'string' || !Object.hasOwn(METHOD_REFUSALS, method)) return null;
  if (!response || response.transport !== 'answered' || response.envelopeOk !== true || response.rejected !== true) return null;
  // A presentation notice is not a business verdict, even if it carries a code.
  if (response.noticeOnly === true) return null;
  if (typeof response.method === 'string' && response.method !== method) return null;
  const code = Number.isSafeInteger(response.remoteCode) ? response.remoteCode : null;
  if (code === null) return null;
  const table = METHOD_REFUSALS[method];
  const kind = (table.consumed || []).includes(code) ? 'consumed' : (table.refused || []).includes(code) ? 'refused' : null;
  if (!kind) return null;
  const officialText = OFFICIAL_REFUSAL_TEXT[code];
  if (typeof officialText !== 'string' || !officialText) return null;
  const rejection = Object.freeze({ version: OFFICIAL_REFUSAL_VERSION, method, action,
    class: kind, msgCode: code, msgKey: null, officialText,
    responseRef: typeof response.responseRef === 'string' ? response.responseRef : null,
    wireKey: typeof response.wireKey === 'string' ? response.wireKey : null,
    requestSequence: Number.isSafeInteger(response.requestSequence) ? response.requestSequence : null,
    connectionEpoch: Number.isSafeInteger(response.connectionEpoch) ? response.connectionEpoch : null,
    sentDeviceMs: Number.isSafeInteger(response.sentDeviceMs) ? response.sentDeviceMs : null,
    receivedDeviceMs: Number.isSafeInteger(response.receivedDeviceMs) ? response.receivedDeviceMs : null,
    transport: response.transport, rejected: true, noticeOnly: false });
  return Object.freeze({ class: kind, code, officialText,
    reasonCode: kind === 'consumed' ? 'REWARD_OFFICIAL_REFUSED_TARGET_CONSUMED' : 'REWARD_OFFICIAL_REFUSED_PRECONDITION',
    rejection });
}