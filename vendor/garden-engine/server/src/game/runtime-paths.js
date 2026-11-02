// 真实链路的所有落盘文件必须按**仓库根**解析，绝不允许按进程 cwd 解析。
//
// 事故记录（2026-09-08）：设备档案、artifact、拟人账本、单会话锁的默认路径原本是
// `path.join(process.cwd(), ".runtime", ...)` 或裸相对串。面板服务从 `server/` 目录
// 启动时，它们全部指向 `server/.runtime/`，后果依次是：
//   1. 真实托管预检报「设备字段缺 deviceId、brand、model……」八项全缺，任务直接判失败
//      （档案其实一直躺在仓库 .runtime/ 里）；
//   2. 拟人账本与**单会话账号锁**分裂到两个目录——从仓库根跑的探针/工具与面板 Worker
//      各自持有不同的锁，等于「同一账号并发两个真实会话」的保护形同虚设；
//   3. 重登冻结跨进程失效（冻结写在一边、判断读在另一边），会放行本该拦下的重试。
// 同类缺陷在官方数值配置表上已修过一次（official-cfg.js 的「换启动目录静默全缺」），
// 这一处是同一个病根的其余分支，收敛到本模块，避免再各写一遍。
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：`server/src/game` 上三级。 */
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** 真实链路运行态目录（采集档案、artifact）。 */
export const RUNTIME_ROOT = path.join(REPO_ROOT, ".runtime");

/** 真实 Worker 的子目录：拟人账本、单会话锁、Chrome profile、日常去重账本。 */
export const GAME_LAUNCHER_ROOT = path.join(RUNTIME_ROOT, "game-launcher");
