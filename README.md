# dsh-scrcpy-core

DSH 的 scrcpy 共用核心 —— **对用户、对 AI 都只有这一个门面**。

它自己不认识任何平台：鸿蒙、安卓各由一个 **provider** 包提供"这类设备怎么说话"。

| 包 | 作用 |
|---|---|
| **`@nszzj/dsh-scrcpy-core`**（本包） | 投屏面板 UI、每设备一个标签页、jmuxer 解码、AI 工具、提示词、权限门禁、设备与聚焦状态、命令路由 |
| `dsh-hos-scrcpy` | 鸿蒙 provider：`hdc` 传输 + Java sidecar（HOScrcpy SDK） |
| `dsh-android-scrcpy` | 安卓 provider：`adb` 传输 + 官方 `scrcpy-server` |

**provider 不注册 UI、不注册 AI 工具、不写 AI 提示词、不关心"当前聚焦哪台"** —— 那些全在 core。

---

## 安装

### 桌面端（0.1.7，当前主力）

`dsh plugin --profile desktop …` **会被 CLI 拒绝**：

```
error: profile "desktop" is managed exclusively by the Electron application
```

必须走**应用内的插件面板**。面板接受三种形式：

- **npm 包名**（core 是 `@nszzj/dsh-scrcpy-core`；鸿蒙是 `@nszzj/dsh-hos-scrcpy`；安卓是 `@nszzj/dsh-android-scrcpy`）
- **本地 tgz 路径**（例如 `nszzj-dsh-scrcpy-core-1.0.0.tgz`）
- **`github:` 规格**（例如 `github:ns-zzj/dsh-scrcpy-core`）

**要装两个包：core + 你要的平台 provider。**

### 命令行（`web` 等 profile）

```bash
dsh plugin --profile <profile> add dsh-scrcpy-core dsh-hos-scrcpy      # 或 dsh-android-scrcpy
```

然后重启 `dsh web`，会话右上角出现「**scrcpy 菜单**」即成功。

### 三件必须知道的事

1. **core 必须装成 profile 的直接依赖**（就是上面那样把它单独列出来）。
   只装 provider 时 core 只是**传递依赖**，不会被登记成 bundle 层 —— 层不挂载、那一行没人插，
   **而且不会有任何警告**（2026-09-25 两组对照实测）。
2. **装 provider 不会自动带 core**（"自由装"）。没装 core 时 provider 的状态是
   `pending (waiting for service: scrcpyProviders)` —— **不报错，但也用不了**，这是设计如此，不是 bug。
3. **桌面端：禁用 / 启用后想立刻看到效果要重启。**
   实测：**启用是热的**（立刻生效、不用重启）；**禁用只写文件** ——
   它会把这个包从 profile 的 `dsh.profile.bundles` 里摘掉（依赖保留，所以恢复时**不用重装**），
   但**已经装载的插件实例不会在运行中卸载**，所以要**重启**才真正消失。

### 支持范围

主力是**桌面端**（Electron）。`dsh web`（在浏览器里打开 GUI）大体也能用 ——
客户端半区本来就是浏览器代码，RPC 也走宿主 HTTP —— 但**未做完整验证**，出问题请以桌面端为准。

> WS 握手的 Origin 校验**同时放行** `dsh-app://`（桌面端渲染进程的真实 Origin，2026-09-26 实测；
> 不是 `http://127.0.0.1:19387`）与本机 http 回环（`127.0.0.1` / `localhost` / `[::1]`，端口不限），
> 所以 web 版不会因为这条被挡；只有**外部网页**（以及 DNS rebinding）会拿到 403。

---

## 怎么用

1. 会话右上角点「**scrcpy 菜单**」→ 按平台分组的设备列表（**鸿蒙设备 / 安卓设备**），每组还带自己的环境检测
   （鸿蒙组显示 `Java` + `hdc`，安卓组显示 `adb`）。
2. 设备那行点「**启动**」→ 起服务、打开这台设备的**投屏标签页**（每台设备一张，互不干扰）。
3. 投屏面板上可以：鼠标点/拖 = 触摸、`返回/主页/音量` 按键、「输入」按钮（向当前聚焦的输入框注入文本）、
   「添加截图至聊天框」、以及该平台支持时的「日志」。
4. 切走别的标签页**不断流**：画面只是暂停广播（省解码与内存），回来接着放。

### 设置

- **AI 控制设置**（每台设备的投屏面板 →「设置」）：四项权限 + **识别模型**。
- **连接设置**（菜单里各平台组右上角）：由该 provider 自己提供字段与检测，core **不认识**
  "Java 路径 / hdc / adb" 这些概念，只负责把它渲染成表单。
- **识别模型**下拉列出**所有 provider 的所有模型**（不按"是否支持图片"筛 —— 非官方 API 大多不报这个字段，
  会误伤）。选了不支持图片的模型，就由上游 API 自己报错。

---

## 给 AI 的工具（一套中性名，只注册一次）

| 工具 | 作用 | 需要权限 |
|---|---|---|
| `scrcpy_devices` | **入口**：列出已连接设备、当前聚焦哪台、它四项权限状态 | 不需要 |
| `scrcpy_screenshot` | 截屏 + 内置视觉模型识别（描述画面、找控件） | 允许截图 |
| `scrcpy_locate` | 读控件清单（`type/text/id/key/clickable/fx/fy/w/h`，比例坐标 0..1） | 允许控制 |
| `scrcpy_tap` / `scrcpy_longpress` | 按比例坐标点击 / 长按，执行前弹确认并**在画面上闪绿点显示落点** | 允许控制 |
| `scrcpy_key` | 按 **provider 声明的**可用键（安卓 provider 目前是 `back` 返回 / `home` 回桌面；声明变了界面标题也跟着变） | 允许按键 |
| `scrcpy_input` | 向当前聚焦的输入框注入文本（支持中文） | 允许输入 |

**所有操作类工具只作用于"当前聚焦"的那台设备**（= 用户在投屏面板里正看着的那台）。
没有聚焦设备时工具会明确报错，**绝不替你猜一台**。

### 权限：四项 × 三态

每台设备**独立**四组开关，每组三态：`禁止使用` / `需要确认` / `无需确认`。

- 「允许控制」「允许按键」「允许输入」**都依赖「允许截图」** —— 关掉截图会连带关掉它们。
- `需要确认`：每次调用弹二次确认（用户可能拒绝，拒绝后 AI 不应重试）；`无需确认`：直接执行。

---

## 版本与兼容

- 三个包**各自独立发版**、各自独立安装。
- provider 在登记自己时声明 **`coreCompat`**（一段"匹配我需要的 core"的文字）：
  支持 `"1.0.0"`（精确）/ `"^1.0.0"`（同 major）/ `">=1.0.0"`（下限）。
- **判定权在 core**：core 拿自己的版本比对，不通过就把该 provider 标成**停用** ——
  它的设备不进列表、动作不路由（= 不让用），菜单那一组显示「**已停用**」+ 一句原因。
  provider 自己**不报错**，坏的那个不会拖垮别的；core 里也**不维护**"支持哪些 provider 版本"的表。
- 装了 provider 没装 core：只是 `pending`（等 `scrcpyProviders` 服务），不报错、用不了。

---

## 已知限制

- **安卓 provider 目前没有日志流**（鸿蒙那边是 `hilog`）；没有该能力的 provider，投屏面板不显示「日志」按钮。
- **"暂无画面"的含义按平台不同**：鸿蒙 SDK 只在画面变化时推帧，所以"没帧"时提示用户滑一下手机；
  安卓不需要这个提示（没帧只是画面没变化）。文案由 provider 能力决定。
- 投屏本身是**变化驱动**的：画面静止时不推帧，帧计数/字节数不会增长 —— 这是正常现象。
- **键盘**：安卓侧**已实现真外接键盘**（UHID）—— 鼠标点一下画面，PC 按键就直输给设备，
  **平板自己的输入法会接管**（拼音组词 + 候选词，2026-09-26 真机实测通过：
  打 `ce'shi` 出「1测试 2侧石 3侧视 …」）。另外「输入」按钮是"直接塞字"（走 `INJECT_TEXT`，
  任意中文都行、但不出候选词）。鸿蒙侧目前是 `uinput`，能否喂给输入法**未实测**。
- 菜单观感仍在调整。

---

## 开发者

契约（provider 怎么登记、动作接口、投屏流协议、版本判定）：见 **[CONTRACT.md](./CONTRACT.md)**。

```
dsh-scrcpy-core/
├── package.json          # dsh.bundle（本包是 bundle 层）+ dsh.client
├── cordis.patch.yml      # 【只插 core 自己那一行】—— 两个 provider 各插自己的行，谁都不许碰 core 行
├── lib/                  # Host 半区：注册表 / 设备与聚焦状态 / 命令路由 / 工具 / 提示词 / RPC
├── client/               # 浏览器半区：全部 UI
├── resources/            # jmuxer.min.js（解码库，随包发）
├── CONTRACT.md           # core ↔ provider 契约
└── README.md
```

**为什么每一行只有一个 owner**：`applyEntryPatches` 不按 id 去重 —— 两个 bundle 层各插一条同 id 条目，
组合结果里就会留下两条，挂载时被 `EntryGroup.update` 以 `duplicate loader entry id` 拒绝、**启动直接失败**。
