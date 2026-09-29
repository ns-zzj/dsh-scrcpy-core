# 我们依赖的 DSH 契约（上游一变，先查这里）

> **为什么有这份文件**：DSH 0.1.7 改了菜单的挂载点 / 主题变量，我们的菜单背景变半透明 ——
> 当时是**靠 F12 一点点试出来的**。有这张表，下次上游一变，**定位从几小时变几分钟**。
>
> **规矩**（对齐 `~/.dsh/AGENTS.md` 第 2 条）：
> 1. 只写**我们实测过**的契约；没验过的必须标「未验证」；
> 2. **新增任何"碰 DSH 的东西" → 回来补一行**；
> 3. 界面出问题（尤其**视觉**问题）→ **先查本表**，再怀疑我们自己的 CSS。

## 1. 宿主半区（`core/lib/index.js`）

| 依赖 | 我们怎么用 | 坏了会怎样 |
|---|---|---|
| `ctx.tools.register(tool)` + `defineTool`（`@deepseek-ai/dsh-tools`） | 注册 7 个 `scrcpy_*` 工具；peerDep 写 `>=0.1.5-0`（optional） | 工具不出现 → 插件形同不存在 |
| `ctx.get('systemPrompt').section({ name, order, text })` | 插固定三段提示词（`text` 用**字符串**，实测可行） | AI 不知道有这个插件 |
| `ctx.webServer.register({ kind: 'exact', path, handler })` | 挂 `/dsh-scrcpy/rpc`（客户端是静态包，**不能自己起服务**，UI 全部数据都走它） | 面板打不开、全部 UI 失效 |
| `ctx.provide('scrcpyProviders', registry)` | 给 provider 用的服务名（**这是我们自己的契约**，见 `CONTRACT.md`） | provider 停在 `pending (waiting for service)` |
| `ctx.get('approval')` | 二次确认弹层（点击/长按/按键/输入/读控件） | 确认框不弹 → 权限门禁失效 |
| `ctx.get('llm')` → `listProviders()` / `listModels()` / `stream()` | 截图识别。**provider id 绝不写死** | **踩过**：0.1.5 叫 `deepseek-official`、0.1.7 叫 `deepseek-account`，写死 → 模型列表恒空、下拉禁用 |
| `ctx.get('attachments').saveImages([...])` | 把截图变成模型能吃的图片引用 | 截图识别不可用 |
| `ctx.on('dispose', …)` | 注销工具 / 路由 / 提示词 | 热重载后残留旧实例 |

## 2. 浏览器半区（`core/client/client.js`）

| 依赖 | 我们怎么用 | 注意 |
|---|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | 客户端入口。**factory 直接返回 exports 对象**（不是 `{ exports }`） | 写错 → 客户端半区完全不加载 |
| `exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight']` | 声明需要的客户端服务 | 缺任一 → 退回浮层面板（我们做了降级） |
| `ctx.get('slots')` + `slots.inject(name, fn)` / `slots.register({ name, key }, comp)` | 注册槽位与每设备标签页 | **槽位名拼错是静默的**（我们用 `safeInject` 包了 try/catch） |
| 槽位 **`conversation.session.header.utilities`** | 会话右上角那个「scrcpy 菜单」入口 | 菜单消失 |
| `ctx.get('sidebarRightTabs')` | 按 kind 注册"每设备一张标签页"（kind = `dsh-scrcpy-devices-<设备键>`） | 投屏标签页打不开 |
| `ctx.get('sidebarRight')` → `openTab(kind)` / `close(id)` / `active()` / `isExpanded()` / `toggleExpanded()` | 打开/关闭标签页、判断"是否最前 + 侧栏展开"（**切页暂停投屏靠它**） | 不能打开/关闭；暂停逻辑失效 |
| 主题：CSS 变量 `--dsw-*`、`--ds-font-family-code`、暗色选择器 `body[data-ds-dark-theme]` | 全部样式。**一律带 fallback**（`var(--x, #fff)`） | **0.1.7 踩过**：挂载点变了 + 某变量变半透明 → 菜单背景透底 |
| `dsh.client.platform: "web"` | 清单字段 | 客户端半区不加载 |
| `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` | 清单字段 | 该包在 0.1.7 **已被移除**；实测**静默跳过、无害**，但语义已失效（未验证能否删掉） |

## 3. 打包 / 安装 / 加载（宿主 loader 与插件面板）

| 依赖 | 事实 | 来源 |
|---|---|---|
| `dsh.bundle.patch` → `cordis.patch.yml` | bundle 层靠它向组合树插插件行 | 实测 |
| profile 的 `dsh.profile.bundles` 是**组合树** | reconcile **只看 profile 的直接依赖** | 实测 |
| core 必须装成**直接依赖** | 只装 provider 时 core 只是传递依赖 → 层不挂载、**零警告** | 两组对照实测 |
| 每行 id 只能有**一个 owner** | 两层插同 id → `duplicate loader entry id` → **启动直接失败** | 实测 |
| 桌面端 `dsh plugin --profile desktop …` | **被 CLI 拒绝**（`profile "desktop" is managed exclusively by the Electron application`）→ 只能走应用内插件面板（接受 **tgz 路径 / npm 名 / `github:` 规格**） | 实测 |
| **禁用 = 从 `dsh.profile.bundles` 摘掉**（依赖保留） | **启用是热的**（立刻生效）；**禁用只写文件**，已装载的实例不会在运行中卸载 → **要重启** | 实测 |
| `exports` 必须暴露 `"./client"`、`"./cordis.patch.yml"`、`"./package.json"` | 少一个就加载不到对应部分 | 实测 |

## 4. 与视觉/上游无关但同类的坑（顺手记）

| 坑 | 事实 |
|---|---|
| 控件树坐标系 | `uiautomator` 的 bounds 用**当前显示方向**的空间；而 `wm size` 报的是**自然方向**的宽高顺序 → 横屏时必须换分母，否则点歪（2026-09-26 真机踩过，已修） |
| 帧率语义 | H.264 是**变化驱动**：画面静止时 **0 帧**是正常的，不是卡住 |
