# 三版原型公网预览

访问地址：[花开无尽夏 · 三版原型](https://wujinxia01.ainiannian.online/preview/)。无需登录，可转发给他人查看；首页三版等权展示，进入各自的交互原型、三屏大图或完整弹窗图集。选择结果由看稿人自行反馈，站点没有投票或账号收集功能。

## 当前发布

- 2026-10-20 17:42:45 +08:00 发布 `20261020-d45cf5b0a598`，共 199 个文件，44,943,516 字节。方案 01 游戏号横幅按用户要求换为方案 02 的雨伞花径，方案 01 的整体样式继续保留。
- 入口机 `aliyun-huantong`，本项目专用域名 `wujinxia01.ainiannian.online` 的 `/preview/`；不使用原网页版域名或其站点配置。
- 静态内容用户 `wujinxia-app-preview`（系统用户、nologin），目录 `/var/www/wujinxia-app-prototypes/releases/<release>`，`current` 软链指向当前版本；没有新增进程、回源端口或业务服务。
- 预览 location 为 `/etc/nginx/wujinxia-app-design-preview.conf`，仅由本项目 HTTPS server 的 `/etc/nginx/conf.d/wujinxia-app-cloud.conf` 引入；`/preview/` 直接静态读取，其他原有路由继续原有回源。
- 首次接入前后均完成 `nginx -t`，用户本次发布要求下执行平滑 reload；最终静态内容更新仅原子切换软链（`reloaded=0`）。没有重启云服务、隧道或原站服务。配置和软链先态备份在 `/var/lib/wujinxia-app-preview-deploy/20261020T094245Z-20261020-d45cf5b0a598/`，0700。

## 发布范围

`tools/package-design-preview.mjs` 以明确名单打包 HTML、CSS、原型 JS、三版图稿、121 张面板图和必要插画/原图标/功能图标许可；发布目录不含 runtime、云服务、账号资料、凭据、数据库、原始日志、APK、生成脚本或工作文档。包、逐文件 SHA-256、归档及检查记录都留在忽略目录 `.runtime/design-preview/`，不加入 Git。

GET/HEAD 可读；POST 等方法拒绝，目录不列出文件。页面与 nginx 均设置 CSP，`connect-src 'none'`、`form-action 'none'`；原型只更新浏览器页面内存。响应包含禁止嗅探、禁止嵌入、无来源传递和 `noindex` 标记。没有接入真实软件或游戏账号。

## 重发与恢复

1. 修改设计后，运行 `node tools/package-design-preview.mjs`。输出目录 `.runtime/design-preview/public/` 必须仅包含明确名单，脚本遇到额外旧文件会拒绝沿用；部署 shell/config 的 LF 规范化副本在 `.runtime/design-preview/deploy/`，位于公开目录之外。
2. 用 `tar -czf .runtime/design-preview/site.tar.gz -C .runtime/design-preview/public .` 归档。发布编号在 `release.json`；把归档、`files.sha256` 与 `deploy/` 内三份发布文件拷贝到入口机 `/tmp/wujinxia-app-preview-<release>/`（0700）。不得把项目根目录整体上传。
3. 现读入口机本项目站点配置 SHA-256，传给 `bash /tmp/wujinxia-app-preview-<release>/install-design-preview.sh <release> <expected-nginx-sha256>`。安装器检查当前配置未变、逐文件摘要、独立内容目录、配置备份与 `nginx -t`；失败自动恢复配置和原软链。只有配置发生变化时才平滑 reload，纯静态版本切换不 reload。不要使用本脚本部署业务云服务或其他项目。
4. 成功后核对公开 HTTPS、三版交互、图集、资源和原有入口健康状态。回到已有静态版本可把 `current` 原子切回对应 `releases/<release>`，不需 reload。若要撤销首次接入，先恢复首次备份的站点配置并移除本次专用 include，`nginx -t` 后平滑 reload；不要改原站配置或删除业务数据。

## 本批检查边界

服务器逐文件 SHA-256 核对全部 199 文件。公网首页和原图标返回 200、POST 返回 403、未发布的 README 返回 404；本项目健康接口与原站只读入口在发布前后均返回 200。浏览器公网排版、三版交互与资源检查记录在 `.runtime/design-preview/public-inspection.json`；本轮雨伞横幅、主题保持及三张更新大图摘要检查记录在 `umbrella-inspection.json`。

这些是静态预览发布检查，不是安卓功能、雷电官服或真机稳定性验收；本批不构建安装 APK、不连接游戏、不操作设备或真实账号，也没有真实配置需要恢复。
