/**
 * V5 账号服务请求体的**官方权威规格**。
 *
 * 证据来源（全部离线，不涉及任何真实登录）：
 *  1. 热更新账号 SDK `_ref/android_apk/hotupdate/moac_rn_4.3.3.74.index.android.bundle`
 *     里的 `mo.AC.SecureRequestBuilder.buildFullFingerprintInner` / `buildV5DeviceFields`
 *     / `RequestSecurity.buildCanonical` 与 `V5_ANDROID_PARAM_RULES`（逐行移植，非猜测）。
 *  2. 官方客户端在同一次**成功登录**中自己打到 logcat 的 canonical 明文（35 键，见下）。
 *     原始 logcat 只落 `.runtime/`（含凭据，不进仓库），这里只保留键名与结构结论。
 *
 * 结论优先级：官方实际发出的字节 > 官方源码里的赋值顺序 > 本仓库历史实现。
 */

/** 官方成功登录那次，canonical 里真实出现的键（按字典序，canonical 本身按键排序）。 */
export const OFFICIAL_V5_LOGIN_BODY_KEYS = Object.freeze([
  "android_id", "appId", "app_instance_id", "brand", "build_fingerprint",
  "carrier", "clid", "cpu", "darwin_version", "deviceId",
  "device_product", "gpu", "idfv", "keychain_id", "lang",
  "language", "manufacturer", "model", "name", "networkCountryCode",
  "network_type", "oaid", "os_version", "packageName", "platform",
  "ram_gb", "requestSecurityIvVersion", "resolution", "sdk_version", "showVerEighteenAgeTips",
  "simCountryCode", "sysLanguage", "timezone", "value", "version",
]);

/**
 * 在这台设备上官方**就是发空串**的字段。
 * 重要：空串会被 official canonical 保留（`buildCanonical` 只排除 null/undefined/对象），
 * 所以「空」不是缺字段，不需要也不应该拿它当拒发理由 —— 拿它去 fail closed 会让我们的
 * 请求比官方更严格，反而成为可区分特征。
 */
export const OFFICIAL_EMPTY_ON_ANDROID = Object.freeze([
  "build_fingerprint", "carrier", "darwin_version", "device_product", "idfv", "oaid", "simCountryCode",
]);

/** 官方热更新代码里 `INNER_FINGERPRINT_BASE_KEYS` 的指纹基字段（业务参数只允许叠加其余键）。 */
export const V5_FINGERPRINT_BASE_KEYS = Object.freeze([
  "appId", "platform", "version", "packageName", "clid", "deviceId", "requestSecurityIvVersion",
  "gpu", "os_version", "language", "carrier", "sdk_version", "timezone", "cpu", "model",
  "network_type", "resolution", "ram_gb", "brand", "manufacturer", "device_product",
  "app_instance_id", "keychain_id", "idfv", "darwin_version", "android_id", "build_fingerprint", "oaid",
]);

/** 逐条移植自官方 `V5_ANDROID_PARAM_RULES`（level 与 nativeKeys 是官方原话，含 fallback 说明）。 */
export const V5_ANDROID_PARAM_RULES = Object.freeze([
  { field: "deviceId", level: "required", nativeKeys: ["appInfo.deviceId", "equipment.deviceId"] },
  { field: "packageName", level: "required", nativeKeys: ["AppEntry 顶层 packageName"] },
  { field: "appId", level: "required", nativeKeys: ["res.gfsdkConfig.appId"] },
  { field: "version", level: "required", nativeKeys: ["AppEntry pkVersion / baseInfo"] },
  { field: "clid", level: "required", nativeKeys: ["AppEntry.clid"] },
  { field: "equipment", level: "required", nativeKeys: ["AppEntry.equipment 字符串"] },
  { field: "android_id", level: "required", nativeKeys: ["appInfo.deviceId"], hint: "固定使用 appInfo.deviceId" },
  { field: "build_fingerprint", level: "required", androidNative: true, nativeKeys: ["AppEntry.build_fingerprint", "AppEntry.buildFingerprint"] },
  { field: "oaid", level: "recommended", androidNative: true, nativeKeys: ["AppEntry.oaid"] },
  { field: "model", level: "recommended", nativeKeys: ["equipment.equipmentModel", "equipment.model"] },
  { field: "cpu", level: "recommended", nativeKeys: ["AppEntry.cpuType", "equipment.cpuType", "equipment.cpu"] },
  { field: "ram_gb", level: "recommended", nativeKeys: ["appInfo.memoryState", "equipment.ram", "equipment.ram_gb"] },
  { field: "resolution", level: "recommended", nativeKeys: ["equipment.screenWidth+screenHeight", "equipment.resolution"] },
  { field: "os_version", level: "recommended", nativeKeys: ["equipment.os_version", "AppEntry.systemOSVersion"] },
  { field: "timezone", level: "recommended", nativeKeys: ["AppEntry.timeZone", "equipment.timezone"], hint: "缺失时 RN 使用 Intl timezone fallback" },
  { field: "network_type", level: "recommended", nativeKeys: ["equipment.netWorkType", "equipment.network_type"] },
  { field: "brand", level: "recommended", nativeKeys: ["equipment.equipmentBrand", "equipment.brand"] },
  { field: "manufacturer", level: "recommended", nativeKeys: ["equipment.manufacturer"] },
  { field: "app_instance_id", level: "recommended", nativeKeys: ["AppEntry.app_instance_id", "equipment.app_instance_id"], hint: "缺失时 SDK 使用 inst-{deviceId} fallback" },
  { field: "gpu", level: "optional", nativeKeys: ["AppEntry.gpu"], hint: "Android 缺失时 RN 使用 unknow fallback" },
  { field: "device_product", level: "optional", nativeKeys: ["AppEntry.device_product", "AppEntry.deviceProduct"] },
  { field: "carrier", level: "optional", nativeKeys: ["AppEntry.isp"] },
  { field: "language", level: "optional", nativeKeys: ["equipment.language", "baseInfo.rnLang"], hint: "有 RN fallback" },
  { field: "sdk_version", level: "optional", nativeKeys: ["equipment.sdk_version"], hint: "有 systemOSVersion fallback" },
]);

export const ANDROID_GPU_UNKNOWN = "unknow";

const first = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
  }
  return "";
};

/**
 * 逐行移植官方 `pickEq`：按候选键顺序取第一个非空值（equipment 内部）。
 */
export function pickEquipment(equipment = {}, ...keys) {
  for (const key of keys) {
    const value = equipment?.[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

/** 官方 `ramMbToGbString`：ceil(MB/1024)，无效则空串。 */
export function ramMbToGbString(value) {
  const mb = Number(value);
  if (!Number.isFinite(mb) || mb <= 0) return "";
  return String(Math.ceil(mb / 1024));
}

/**
 * 官方 `buildV5DeviceFields`（Android 分支）的等价实现。
 * `appEntry` 对应官方 `getAppEntryData()`，`equipment` 对应官方 `AC.equipment`（已解析）。
 */
export function buildV5DeviceFields({ appEntry = {}, equipment = {}, appInfo = {}, platform = "Android" } = {}) {
  const isAndroid = String(platform || "").toLowerCase() === "android";
  const memoryState = first(appInfo.memoryState, equipment.memoryState);
  const deviceId = first(appInfo.deviceId, equipment.deviceId);
  const ramSource = first(memoryState, equipment.ram);
  const brand = isAndroid
    ? first(equipment.equipmentBrand, equipment.brand)
    : first(equipment.brand, equipment.equipmentBrand);
  const resolution = first(equipment.resolution)
    || (first(equipment.screenWidth) && first(equipment.screenHeight)
      ? `${first(equipment.screenWidth)}x${first(equipment.screenHeight)}`
      : "");
  return {
    timezone: first(appEntry.timeZone, appEntry.timezone, equipment.timezone, equipment.timeZone),
    cpu: first(appEntry.cpuType, equipment.cpuType, equipment.cpu),
    model: isAndroid ? first(equipment.equipmentModel, equipment.model) : first(equipment.model, equipment.equipmentModel),
    network_type: isAndroid
      ? first(equipment.netWorkType, equipment.network_type, equipment.networkType)
      : first(equipment.network_type, equipment.networkType, equipment.netWorkType),
    resolution,
    ram_gb: ramMbToGbString(ramSource) || first(equipment.ram_gb, equipment.ramGb),
    brand,
    manufacturer: first(equipment.manufacturer, brand),
    device_product: first(appEntry.device_product, appEntry.deviceProduct),
    app_instance_id: first(appEntry.app_instance_id, equipment.app_instance_id),
    keychain_id: first(equipment.deviceId, equipment.keychain_id, equipment.keychainId),
    idfv: first(equipment.idfv),
    darwin_version: first(appEntry.darwin_version),
    android_id: deviceId,
    build_fingerprint: first(appEntry.build_fingerprint, appEntry.buildFingerprint),
    oaid: first(appEntry.oaid),
  };
}

/**
 * 与官方 canonical 的键集做差集。官方是「基字段 + 业务叠加」，所以多一个键、少一个键
 * 都是可被服务端观测到的形态差异 —— 必须显式暴露，不允许静默。
 */
export function diffV5LoginBody(body = {}) {
  const actual = Object.keys(body).filter((key) => key !== "fullSignature").sort();
  const expected = [...OFFICIAL_V5_LOGIN_BODY_KEYS].sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, actualCount: actual.length };
}
