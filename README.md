# 无尽夏 · 花园世界安卓端

Android App、设备端 Node 后端、应用管理界面及独立云服务源码。源码来自 2026-11-02 的统一主线；上传版增加了同事接手用的构建和本地启动入口。

## 直接安装使用

仓库的 `downloads/garden-android.apk` 是本次从源码构建的 Android 安装包，支持 Android 8.0 及以上的 arm64 手机和 x86_64 模拟器。拉取后把 APK 发到手机安装即可，也可以在电脑使用 `adb install -r downloads/garden-android.apk`。

```powershell
git clone https://github.com/ddd123sth/-_0.01.git garden-android
cd garden-android
```

App 默认连接 `https://wujinxia01.ainiannian.online/backend-v2`。使用时需要网络和自己的有效软件账号/授权、游戏账号；仓库不提供共享账号。无需在同事电脑另启云服务。安装后由使用者登录并选择功能，不会附带现有设备的自动运行配置。

## 修改代码并构建 APK

当前 Android 构建脚本支持 **Windows x64**。先安装 Git、Node.js 22.13+（推荐 Node 24 LTS）、PowerShell 7（`pwsh`）和 Python 3，并加入 PATH。建议把仓库放在较短的本地路径，首次构建预留约 10GB 空间；需要联网下载 JDK、Gradle、Android SDK、NDK 和 Node Mobile，耗时取决于网络。

```powershell
npm run build
```

脚本会准备缺少的工具链，在本机 `.runtime/` 生成专用开发签名，再打包两种架构。无需手工编辑 SDK 路径，无需先执行 `npm install`。产物为：

```text
.runtime/android-output/garden-backend-rebuild-debug.apk
```

首次下载失败时检查能否访问 Google Android 下载站、GitHub、Gradle、npm 和 SQLite 下载站，然后重跑。下载缓存会保留；哈希错误时只删除提示的损坏下载文件。当前 NDK 包约 663MB。

本机生成的开发签名与仓库附带 APK 的签名不同，因此不能直接覆盖安装附带 APK；请使用独立测试设备/模拟器。卸载会删除 App 数据，先备份需要保留的资料。需要长期覆盖升级时，开发者必须自行妥善保存同一套 `.runtime/backend-rebuild/keys/`，不得提交签名私钥和密码。

需要其他已部署的独立 HTTPS 云服务时：

```powershell
npm run build -- --cloud-url=https://your-domain.example/backend-v2
```

`npm run setup` 只准备工具链与本机签名。Android Studio 直接打开时，先执行该准备步骤；正式打包使用上面的脚本，以便生成引擎资源、原生 SQLite 和签名环境。

## 本地运行云服务与管理后台

这供后端开发使用；本地数据库与线上独立。安装 Node 22.13+ 后运行：

```powershell
npm start
```

看到 `WUJINXIA_CLOUD_READY` 后打开 `http://127.0.0.1:8092/api/software/health`，后台页面为 `http://127.0.0.1:8092/admin/`。按 Ctrl+C 停止。本地云默认没有管理员，创建方式见 `cloud/cli.mjs` 的 `create-admin` 命令（密码通过标准输入或受保护环境变量提供）。`npm start` 不会创建线上账号或部署服务。手机无法直接访问电脑的 `127.0.0.1`；连接自建云须另行部署 HTTPS 服务并指定构建地址。

## 检查及已有边界

```powershell
npm run check:payload
npm test
```

第一条先重新暂存载荷，再检查 Android 依赖闭包与隔离边界，不连接游戏。完整测试集中存在此前统一交付记录的失败项，不能将“可构建/可安装”理解为全部功能已验收。业务阶段判断、部分恢复时限、容量目标和缺真实机会的动作仍有后续工作。

## 源码目录

- `app/`：Android Activity、前台服务、原生恢复与网络控制。
- `ui/`：应用界面及现有生成资源。
- `runtime/backend/`：设备端 API、存储、调度、功能执行和协议适配。
- `vendor/garden-engine/`：运行依赖的协议、schema 和官方配置快照。
- `native/sqlite/`：Android SQLite 原生模块源码。
- `cloud/`、`admin/`、`deploy/`：独立云服务、管理后台与部署源码。
- `tools/`、`tests/`：构建工具与现有测试。
- `docs/design/`：UI 生成器需要的设计源文件及图片；生成后的资源已包含在 `ui/`。

上传版本不包含本机 `.runtime/`、工具缓存、账号/数据库、签名私钥或历史会话记录；保留构建与运行所需的源码和资源。原有本机 Git 历史没有上传。
