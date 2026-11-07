# 写一个 provider

core 负责全部 UI、AI 工具、提示词、设备与焦点、路由和权限；provider 只回答一件事：**这台设备怎么连、怎么点、怎么出画面。**

本文写的是 core 真正会调用的接口。与代码不一致时，以 `core/lib/index.js` 为准。

---

## 1. 最小骨架

```js
export const name = 'dsh-xxx-scrcpy'        // 插件名
export const inject = ['scrcpyProviders']   // 没装 core 时静默不激活（设计如此）
export const apply = (ctx) => {
  ctx.scrcpyProviders.register({ /* 见下 */ })
}
```

provider **没有浏览器半区**，不注册工具、不写提示词、不接收语言参数。

## 2. 注册字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 稳定标识，core 用它路由 |
| `label` | 是 | 显示名，`{ zh, en }` |
| `transport` | 是 | `'adb'` / `'hdc'` 之类的字符串，仅用于诊断 |
| `abi` | 是 | 整数，当前是 `1`。和 core 的 `ABI` **等号比较**；不等或没写会被标成「不兼容」并停用 |
| `build` | 否 | 构建戳 `YYYY-MM-DD.B<N>`，显示在「连接设置」按钮行左边 |
| `available` | 是 | 环境是否齐备（adb/hdc/java 在不在）；为 false 时用 `note` 说明原因 |
| `note` | 否 | 不可用原因，`{ zh, en }` |
| `capabilities` | 是 | 见 §4 |
| `actions` | 是 | 见 §3 |

**ABI 只做等号比较。** 只有破坏性变更（注册字段、动作名/参数/返回值、capabilities 语义）才 +1；改文案、加可选字段、修 bug 都不动。

## 3. core 会调的动作

| 动作 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `listDevices` | — | 设备行数组 | 要快；慢会拖住 core 的刷新 |
| `startStream` | — | `{ ok, port? }` | 起流；中途不允许改缩放/帧率 |
| `stopStream` | — | `{ ok }` | 必须幂等 |
| `snapshot` | — | `{ ok, bytes, mediaType }` | PNG/JPEG |
| `dumpLayout` | — | `{ ok, items, realW, realH }` | 控件清单，见下 |
| `input` | `{ text }` | `{ ok }` | 文本注入 |
| `key` | `{ key }` | `{ ok }` | `Backspace` / `Delete` / `Enter` / `Tab` / `ArrowLeft` / `ArrowRight` / `ArrowUp` / `ArrowDown` / `Home` / `End` |
| `clipboardText` | — | `{ ok, text }` 或 `{ ok:false, unsupported:true }` | 读设备剪贴板；不支持就返回 unsupported，core 静默 |

`dumpLayout` 的 `items` 每项：

```
{ type, text, id, clickable, fx, fy, w, h }
```

`fx/fy` 是 **0..1 比例**，`realW/realH` 是你算比例时用的**分母**。

**`realW/realH` 必须是当前方向的屏幕尺寸。** 实测坑：鸿蒙的 `activeModes` 给的是出厂竖屏尺寸（横屏下仍是 `1320x2856`），要按同一块的 `Rotation` 枚举（0/1/2/3，1=90°、3=270°）自己换。换了之后，横屏的分母才是对的。

拿不到屏幕尺寸时，可以退回控件树的最大边界，但要清楚它在「页面只画了状态栏」时会算出 `1320x137` 这种值。

## 4. capabilities

| 字段 | 含义 |
|---|---|
| `picture` | 声明你会读画面四件套（见 §5）。不声明 → core 显示「未声明画面选项」 |
| `keys` | 界面上的按键按钮，数组顺序即显示顺序 |
| `keyLabels` | 每个键的双语显示名 `{ 键: { zh, en } }` |
| `aiKeys` | 允许 AI 调的键；不写则退回 `keys`；都没有 → 工具直接报错 |
| `streams` | 有投屏流（默认 true） |
| `log` | 支持 `{ type:'log' }` 开关（设备日志），默认 false |
| `hintSwipe` | 只在画面变化时推帧的平台（鸿蒙），core 会把等待文案换成「滑一下设备」 |
| `inputMode` | 键盘输入模型，见下 |

界面上能按的键和 AI 能按的键是两件事：音量/电源默认不交给 AI。

**`inputMode`**：决定开关打开后，电脑键盘怎么进设备。

| 取值 | 焦点 | Shift | 文字怎么到设备 | 谁用 |
|---|---|---|---|---|
| `'ime'`（默认） | 隐藏的 1px 输入框 | 归电脑（切输入法语言） | 只送确认后的文字 | 鸿蒙 |
| `'keys'` | 投屏画面 | 也发给设备 | 按键直通 HID，电脑输入法不参与 | 安卓 |

两种模式下面板是同一个开关；组合键（Ctrl/Alt/Meta）都不发给设备，`Ctrl+C` / `Ctrl+V` 固定归电脑
（取设备剪贴板 / 把电脑剪贴板送进设备）。

## 5. 画面四件套

key 由 core 定，provider 只读、改名无效：

```
wiredScale / wiredFps / wirelessScale / wirelessFps
```

默认：有线 `1/2`·60fps，无线 `1/4`·30fps；两端都能到原画（`'1'`），帧率 120 封顶。
你必须让它们生效、在 `cfg:get`/`cfg:save` 里原样持久化，并用 `capabilities.picture` 声明。连接中途不允许换档。

## 6. 投屏流协议

provider 在本机开一个 WS 端点，**浏览器半区直连**，不经过 core。

| 方向 | 内容 |
|---|---|
| provider → 浏览器 | 二进制帧 = H.264（annex-B，含 SPS/PPS 和关键帧）；文本帧 = `{"msg":"size","data":"宽x高"}`、`{"msg":"log","data":"..."}`、`{"msg":"hid","ok":true}` |
| 浏览器 → provider | `{"type":"size"}`、`{"type":"screen","mode":"video"\|"pause"\|"resume"}`、`{"type":"touch","event":"down"\|"move"\|"up","x":..,"y":..}`（帧坐标）、`{"type":"key","name":"back"\|"home"\|...}`、`{"type":"hid","usage":n,"mods":n,"down":true}` |

- 新观众接入必须能立刻解码：补发 config(SPS/PPS) + 最近一个关键帧。
- 暂停 = 停推帧、会话留着。
- 分辨率变化的处理在 core：喂帧前扫 SPS，尺寸变了先换解码器再喂。你只要保证配置帧不被自己吞掉。

## 7. provider 自己的 RPC

core 不认识「java 路径」「adb 路径」这类东西，一律走 `provider:call` 转发：

| 方法 | 返回 | 用途 |
|---|---|---|
| `env:detect` | `{ ok, items: [{ key, label, ok, version, path, source, error, info? }] }` | 环境行 |
| `cfg:describe` | `{ ok, fields: [{ key, label, type, group, placeholder, help, options, build }] }` | 连接设置表单 |
| `cfg:get` / `cfg:save` | `{ ok, config }` | 读写配置（必须原样持久化画面四件套） |

字段的 `label` / `help` / `placeholder` / `options[].label` 都可以写 `{ zh, en }`，core 按当前语言挑。

## 8. 文案规则

- 用户可见的文案写成 `{ zh, en }`，core 挑；不要把语言传进 provider。
- 面向 AI 的文案（工具描述、提示词）恒定英文。
- `{ zh, en }` 不能当普通对象塞进 React 子节点，会炸掉整块 UI。core 有兜底，但别依赖。
- 失败要给一句能显示的原因，不要静默返回空串。

## 9. 构建戳

`PROVIDER_BUILD = 'YYYY-MM-DD.B<N>'`（当天第 N 次构建），经 `cfg:describe.build` 显示。
只有真的进了包才 +1；纯注释不改戳。装完宿主半区要完全退出 DSH 再打开。
