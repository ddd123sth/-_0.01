# 本项目云服务部署与备份模板

`tools/wujinxia-backup.mjs`、`tools/wujinxia-deploy.mjs` 与 `deploy/` 一起，构成本项目（无尽夏安卓端专用云服务）的发布与备份工具。全部为零 npm 依赖，只用 `node:fs`、`node:path`、`node:crypto`、`node:sqlite`、`node:child_process`。

工具本身默认 dry-run：不加 `--apply` 只打印将要执行的命令，不起 `scp`/`ssh`/`curl`。2026-10-19 已用这两个工具把服务真部署到 `garden-node1` 并把加密备份推到 `aliyun-huantong`，公网入口也已生效：`https://wujinxia01.ainiannian.online`（新 A 记录 + 本项目自己的 ECDSA 证书 + 独立站点文件 `deploy/nginx-wujinxia-app-cloud.conf`）。TLS 在入口机 `aliyun-huantong` 终结，回源走受限账号 `wujinxia-tunnel` 的反向隧道映射到入口机 `127.0.0.1:8091`，再由该端口经隧道回到 `garden-node1` 上只绑回环的服务本体；`gatewayports no` 保证不对外新开端口。现读记录见 `WORKLOG.md` 与 `VALIDATION.md`。参考来源见 [`source.json`](source.json)（只读查看原站脚本的组织形状，没有复制任何代码行、脚本、服务名、目录、端口或站点配置）。

## 两台机器各自职责

| SSH 别名 | 职责 | 本项目落点 |
| --- | --- | --- |
| `garden-node1` | 跑本项目云服务（`wujinxia-app-cloud`）与管理后台静态件 | `/opt/wujinxia-app-cloud`（发布件）、`/var/lib/wujinxia-app-cloud`（数据）、`/etc/wujinxia-app-cloud/env`（环境变量）、`/etc/nginx/conf.d/wujinxia-app-cloud.conf`（站点） |
| `aliyun-huantong` | 只保存**加密后的**备份，不额外跑一套在线库或引擎 | `/var/backups/wujinxia-app-cloud` |

两台机器同时承载原网页版服务，所以本项目只使用自己的系统用户、服务名、目录、数据目录、站点配置文件与端口；不调用原站部署脚本，不覆盖或重启原站服务、站点配置、数据库与备份。共享 nginx 的 `reload` 是**人工步骤**（`install.sh` 里只写提示，不自动执行），因为那条命令会连带原站入口。

## 环境变量

备份（`tools/wujinxia-backup.mjs`）：

| 变量 | 含义 |
| --- | --- |
| `WUJINXIA_DATA_DIR` | 服务数据目录 |
| `WUJINXIA_DB_FILE` | 活库路径，默认 `<WUJINXIA_DATA_DIR>/wujinxia-cloud.db` |
| `WUJINXIA_BACKUP_DIR` | 快照与密文包输出目录（默认 `.runtime/wujinxia-backups`） |
| `WUJINXIA_BACKUP_KEY_FILE` | AES-256-GCM 密钥文件，**唯一**密钥来源：POSIX 下必须 0600，Windows 下不得落在版本控制目录内（只允许 `.runtime/` 这类被忽略目录）。密钥值不写命令行、不进日志、不写 `backups.detail`，包头只记 sha256 前 8 位指纹 |
| `WUJINXIA_BACKUP_REMOTE` | 传输目标，格式 `<ssh别名>:/绝对路径`；写 IP 一律拒绝 |
| `WUJINXIA_REPORT_DIR` / `WUJINXIA_RESTORE_WORK_DIR` | 恢复校验报告与临时解密目录（默认在 `.runtime/`） |
| `WUJINXIA_EXEC_TRACE` | 执行痕迹文件：真执行外部命令前逐行追加，测试据此自证 dry-run |
| `WUJINXIA_TRANSPORT_STUB` | 测试用外部命令替身；生产不设 |

发布（`tools/wujinxia-deploy.mjs`）：`WUJINXIA_DEPLOY_HOST`（别名，不接受 IP）、`_PORT`、`_DOMAIN`、`_VERSION`（健康检查核对基准，必填）、`_ENTRY`、`_SOURCE_ROOT`、`_OUT`、`_RELEASE`（回滚目标 sha），或对应 `--host/--port/--domain/--version/--entry/--source-root/--out/--release` 命令行选项。

## 端口选择规则

内部端口由本项目自选并只绑 `127.0.0.1`，不复用原站端口。**部署前复核空闲回环端口**，发布计划的第一条命令就是它：

```bash
ssh garden-node1 "ss -ltnp 2>/dev/null | grep -w ':8091' || echo PORT_FREE_8091"
```

被占用就换一个再复核，`--port` 只在 1024–65535 内取值；`{{PORT}}` 占位符出现在未指定端口的产物里，表示该值必须由运维填入后再落盘。

## 备份与恢复

```bash
node tools/wujinxia-backup.mjs run                 # snapshot→encrypt→transfer→restore-check→record（transfer 默认 dry-run）
node tools/wujinxia-backup.mjs run --apply         # 真的 scp 到 WUJINXIA_BACKUP_REMOTE
node tools/wujinxia-backup.mjs restore-check --package <密文包>   # 恢复演练
```

- 活库只用 `VACUUM INTO` 做一致性导出（能读到 WAL 里已提交未 checkpoint 的行），**禁止**直接复制正在写的主库文件当备份；测试里有对照实验证明复制会漏行。
- 快照出来立刻在只读连接上跑 `PRAGMA integrity_check` 并逐表 `COUNT(*)` 与活库现读对平，不平等即作废本次快照。
- 密文包格式：`WJXBK001` + 头长度 + JSON 头（算法、IV、密钥指纹、明文 sha256、清单 sha256）+ IV + 密文 + GCM 认证标签；头作为 AAD 参与认证，改一个字节都解不开。
- 清单 `<快照名>.manifest.json` 与密文包一起传到远端，恢复时逐表行数必须与清单对平，差异表名会列进报错与 JSON 报告；解密出的明文临时件校验完默认删除。
- `backups` 表字段 `at, ok, size_bytes, sha256, remote, detail`；`detail` 只记算法、密钥指纹、表行数摘要、包名与恢复结论，出现 IP 字面量就拒绝记账。同一 `sha256 + remote` 重复记账只更新原行。
- 本工具自己用 `node:sqlite` 连接并设 `busy_timeout=5000`，失败会把原因报清楚，不静默跳过。
- 备份方案不等于自动故障切换。

## 发布与回滚

```bash
node tools/wujinxia-deploy.mjs                       # 校验 + 生成产物到 .runtime/wujinxia-deploy/ + 打印 dry-run 计划
node tools/wujinxia-deploy.mjs --apply               # 上传、切软链、只重启本项目服务、健康检查核对版本
node tools/wujinxia-deploy.mjs rollback --release <上一版 sha>          # dry-run 看命令
node tools/wujinxia-deploy.mjs rollback --release <上一版 sha> --apply  # 只切本项目 current 软链
```

- 内容校验：`cloud/` 必须存在且非空；`admin/dist/` 若存在必须非空；`.env`、`*.db`/`-wal`/`-shm`、私钥证书、`secrets*`/`credentials*`、`id_rsa`、`.runtime/`、`.git/` 出现在待上传清单里，或源码里出现 PEM 私钥块，一律拒绝发布。
- 产物：`wujinxia-app-cloud.tar`（零依赖 ustar 打包，内容逐文件 sha256 记在 `manifest.json`）、`wujinxia-app-cloud.service`（独立 `User=`、`WorkingDirectory=/opt/wujinxia-app-cloud/current`、`StateDirectory`、`EnvironmentFile=/etc/wujinxia-app-cloud/env`、`Restart=on-failure`、`WUJINXIA_BIND=127.0.0.1`）、`nginx-wujinxia.conf`（`server_name {{DOMAIN}}`、`proxy_pass http://127.0.0.1:{{PORT}}`、`{{TLS_CERT}}/{{TLS_KEY}}` 占位）、`install.sh`（`useradd --system --shell /usr/sbin/nologin`、目录 0750、装本项目单元与站点文件）、`manifest.json`。
- Node 要求：目标机 Node `>=22.13`（内置 `node:sqlite`），低版本必须显式 `--experimental-sqlite` 启动；工具会在输出里报当次判定。
- 回滚用 `releases/<sha>` + `current` 软链切换，只动本项目路径。
- 发布计划里每条命令都先过禁词闸：出现原站服务名、原站目录、原站域名、原站站点配置编号，或共享 nginx 的 `reload`/`restart`，或非 `127.0.0.1` 的 IP 字面量，直接拒绝执行（禁词清单在 `tools/wujinxia-deploy.mjs` 的 `FORBIDDEN_TARGETS` 与 `SHARED_ENTRY_COMMANDS`）。

## 测试

```bash
node --test tests/deploy-backup-tools.mjs
```

真实 SQLite、真实文件、真实子进程、真实 AES-GCM；临时目录只在 `.runtime/deploy-backup-test-*`，外部命令走 `WUJINXIA_TRANSPORT_STUB` 替身，全程不发起任何网络或服务器连接。
