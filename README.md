# dsh-devlaunch

DeepSeek Harness 的**一键启动插件**：会话头部「启动」按钮 + 会话内「控制台」tab。按项目（workspace）配置启动命令（前端 / 后端 / 其他），一键同时启动，实时流式查看各进程输出。进程挂在 dsh host 进程上，生命周期独立于会话——关掉会话或标签页，dev server 照常运行。

## 界面

- **会话头部按钮**（`conversation.session.header.actions` slot）：分体胶囊按钮 `[▶ 启动 | ▾]` 一键启动全部启用的组；运行中变 `[● 停止(n) | ▾]`（绿色脉冲点、悬停转停止红）；未配置时为虚线 `[⚙ 启动配置]`。下拉菜单：每组状态点、类别色徽标、单独启停/重启图标按钮、配置入口、底部「全部启动（主色）/全部停止（危险描边）」
- **会话 tab「控制台」**（`conversation.view` slot，id `dev-console`）：左栏启动组列表（状态点 + 类别徽标 + 运行时长，选中项左侧蓝色指示条，栏底「全部启动/停止」），主区终端风输出面板（主题感知 code-block 底色、stdout/stderr 分色、行号、行悬停、自动跟随滚动、上翻暂停 +「回到底部」、ANSI 转义清理）；工具条：启动/停止/重启/**复制输出**/清屏 图标按钮 + **仅错误过滤** + **输出搜索**（命中高亮、Esc 清空、过滤时显示 x/y 行计数）
- **配置弹窗**：毛玻璃遮罩 + 弹入动画；组卡片按类别着左侧色条（前端蓝/后端绿/其他紫）；启用改为**开关控件**；输入聚焦高亮环；组的增删改排序、命令 / 相对工作目录 / **就绪检测 URL** / 环境变量（KEY=VALUE 每行）/ **崩溃自动重启开关**；**启动预设编辑器**（命名组合 + 点选成员组）；「从 package.json 导入」扫描根目录**与子目录**（monorepo：`packages/*`、`apps/*` 各自的 scripts 都会出现，建议行带来源目录徽标，导入自动填该包的相对 cwd 与 `目录: 脚本名` 标签）——跳过 `node_modules`/`dist` 等构建目录与点目录，深度上限 3 层、包数上限 50

## 行为要点

- **配置按项目保存**（`~/.dsh/dsh-devlaunch.json`，按 workspaceId 键控）：同项目所有会话共享同一份配置与同一批进程
- **进程独立于会话**：由 host 端 `ProcessSupervisor` spawn 与监管（`shell: true`，Windows 下 `taskkill /T /F` 整树终止，冒烟测试验证无孤儿进程）；dsh host 退出时默认全停
- **输出链路**：stdout/stderr 合流环形缓冲（每进程 2000 行），SSE 增量推送 + 心跳；断线重连按 seq 检测缺口并从 host 补拉
- **幂等启停**：同组单实例；重复启动跳过并提示「已在运行」
- **就绪检测**（0.3.0）：组可配 readyUrl，host 每 1.5s 轮询（单次 2.5s 超时），**任意 HTTP 响应**（含 4xx/5xx）即标记「就绪」——状态点由绿色脉冲（启动中）变为绿色实心（就绪），状态文案与控制台 chip 同步
- **启动预设**（0.3.0）：可命名保存多套组合（如「全量 / 仅前端 / 仅后端」）；头部下拉里的预设 chips 切换后，「一键启动」变为启动所选预设并**自动停止预设外的运行组**；选择按浏览器持久化（localStorage），「全部」恢复默认行为（启动全部启用组）
- **端口识别 + 冲突检测**（0.3.0）：host 实时从输出提取 localhost:NNNN / 127.0.0.1:NNNN / 0.0.0.0:NNNN 端口（上限 8 个），控制台工具栏渲染为**可点端口 chip**（新标签打开）；同一端口被 ≥2 个运行组占用时，涉事组在左栏/菜单标红线，chip 变红提示冲突
- **崩溃自动重启**（0.3.0）：组可开 autoRestart——异常退出（非零退出码）后按指数退避自动拉起（2s→4s→…→30s 封顶，最多 5 次；稳定运行 30s 后计数重置；**手动停止/切换预设永不触发**），左栏与状态文案显示 ↻n 重启计数
- **输出导出**（0.3.0）：控制台工具栏「导出」按钮把当前可见（含过滤后）输出下载为 .log 文件，带命令/时间戳/流标签头

## 路由（同源，无新增鉴权面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-devlaunch/state?workspace=` | 配置 + 运行状态快照 |
| POST | `/dsh-devlaunch/config` | 整体替换工作区配置（校验 cwd 不越出项目根） |
| POST | `/dsh-devlaunch/start` / `stop` | `{workspace, groupIds?}` 缺省=全部启用组 |
| POST | `/dsh-devlaunch/restart` | `{workspace, group}` 单组重启 |
| GET | `/dsh-devlaunch/history` | `?workspace=&group=&afterSeq=` 断线补拉 |
| GET | `/dsh-devlaunch/stream?workspace=` | SSE：state / config / output / reset |
| GET | `/dsh-devlaunch/package-scripts?workspace=` | package.json scripts 扫描（导入建议） |

## 安装 / 激活

```bash
npm install && npm run build    # host ESM + client CJS 双构建
dsh plugin --profile <name> add link:<本目录路径>
# 重启 dsh web（host 半为启动时加载的 cordis 插件），浏览器刷新
```

## 开发

```bash
npm run build         # tsdown 双构建 + wrap client
npm run typecheck
node --experimental-strip-types tests/smoke.mjs   # supervisor 冒烟（真进程 + taskkill 验证）
```

源码结构：`src/host`（config / supervisor / routes / 装配）、`src/client`（controller / launch-button / console-view / config-modal / styles）、`src/shared`（协议与校验纯函数）。

## 升级日志

### 0.3.0
- **就绪检测**：组级 readyUrl（http(s) 绝对 URL，协议校验），host 端 1.5s 间隔轮询、任意 HTTP 响应即就绪；UI 三处呈现（状态点脉冲→实心、菜单/控制台「就绪」文案与蓝字）
- **启动预设**：协议新增 profiles（每项目最多 8 套，成员校验过滤未知/重复 id；旧配置无该字段自动兼容为空）；配置弹窗内置预设编辑器（命名 + 点选成员 chips）；头部下拉预设切换条；startTarget 编排 = 启动预设组 + 停止预设外运行组；选择按浏览器 localStorage 持久化（上限 64 项目）
- **端口识别与冲突**：supervisor 输出扫描 localhost/127.0.0.1/0.0.0.0:port（run 状态新增 ports，上限 8）；控制台端口 chip 可点开 http://localhost:port；client 端 portConflicts() 纯函数检测多组同端口 → 左栏/菜单红线 + 红 chip + tooltip
- **崩溃自动重启**：组级 autoRestart 开关；非零退出码触发指数退避（2s 起、×2、30s 封顶、5 次上限）；30s 稳定运行重置计数；手动启动显式重置；stop() 取消挂起的重启定时器（退避等待中停止不会被定时器复活）；host dispose 全清理
- **输出导出**：控制台「导出」按钮，Blob 下载 .log（组名 slug 文件名，头部带命令/时间/行数，每行 [out]/[err] 流标签），遵循当前过滤视图
- **测试**：新增 tests/features.mjs 14 项（端口提取、自动重启含手动重置/停止不复活、真 HTTP 就绪探测、协议预设与 readyUrl 校验）；smoke 13 + scan-fixture 13 回归全绿

### 0.2.0
- **界面全面美化**（纯 client 半边，刷新浏览器即生效，无需重启 host）：
  - 新增 `src/client/icons.tsx` 共享内联 SVG 图标集（继承 currentColor，明暗主题零额外适配），替换全部 Unicode 字形按钮
  - 头部按钮改为分体胶囊（split pill）：悬停投影/边框着色按状态（启动蓝、运行绿→悬停停止红、未配置虚线琥珀）；运行指示点带脉冲光晕动画
  - 控制台输出区改终端风底色（主题感知 `--dsw-alias-markdown-code-block`）、行悬停、类别色徽标、状态 chip（运行绿/异常红）、左侧栏选中指示条 + 底部全部启停
  - 菜单/弹窗入场动画、弹窗毛玻璃遮罩、`prefers-reduced-motion` 降级；自定义滚动条（DSH scrollbar token）
  - 修复 0.1.x 隐患：样式引用了并不存在的 `--dsw-alias-fill-l2`（主题 CSS 未定义该 token，相关底色实际一直缺失）——全部改用真实 token / color-mix 派生
- **控制台小功能**：复制输出到剪贴板（复制过滤后可见行，成功打勾反馈）；「仅错误」stderr 过滤；输出实时搜索（不区分大小写、命中高亮、Esc 清空、过滤行计数）

### 0.1.2
- **package.json 导入支持子目录扫描**：新增 `src/host/scanner.ts`（`scanPackageScripts`），monorepo 的 `packages/*`、`apps/*` 各包 scripts 全部进入建议列表；建议行带来源目录徽标，导入自动填相对 cwd 与 `目录: 脚本名` 标签（不同包的同名脚本可共存）。跳过 `node_modules`/`dist`/`build` 等与点目录，深度 3 层 / 包数 50 封顶；fixture 测试 13 项覆盖发现、跳过、排序、去重语义

### 0.1.1
- **修复单组重启竞态**：原 `restart()` 为 `stop()+start()`，但树终止是异步的——`close` 事件未到时 `start()` 见到旧 `running` 状态直接返回「已在运行」，重启实际失效。改为 `respawnOnClose` 标记：`close` 事件到达（旧进程树确已收尾）后再复活进程；smoke 增加 restart 回归（断言新 pid + 新输出），隔离 DSH_HOME 的 E2E 全链路 12 项 ALL-PASS

### 0.1.0
- M1：启动按钮、控制台 tab、进程监管、SSE 输出流、配置弹窗、package.json 导入、Windows 进程树终止
