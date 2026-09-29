# 基于 core 开发一个 provider（dsh-scrcpy）

> 本文件是 core 写给 provider 作者的**导读与 checklist**。
> 逐字段的契约细节以 [`core/CONTRACT.md`](../CONTRACT.md) 为准；DSH 插件本身的约定见 [`core/DSH-CONTRACTS.md`](../DSH-CONTRACTS.md)。
>
> 目标读者：要给 dsh-scrcpy 接一个新平台（安卓 / 鸿蒙之外）的人。

## 0. 分工（一句话）

| | 负责 |
|---|---|
| **core** | 全部 UI、全部 AI 工具与提示词、设备与焦点、路由、可用性门槛、provider 注册表 |
| **provider** | 这台设备**怎么连**（传输）、**怎么点/按键**（动作）、**怎么出画面**（sidecar + 流）、环境检测、自己的连接配置 |

provider **没有浏览器半区**（界面全在 core）、**不注册任何 AI 工具**、**不写提示词**、**不接收语言参数**。
【用户口述 2026-09-26】"provider 里必须包含这四个画面选项的实现，然后还能自定义别的参数设置" / "provider 自己的文案，直接在包里面写两套全传给 core，然后 core 再挑。"

## 1. 最小可用 provider 的骨架

```js
// lib/index.js
export const name = 'dsh-xxx-scrcpy'        // cordis 插件名
export const inject = ['scrcpyProviders']   // 没装 core 时因注入不满足而**静默不激活**（设计如此，不是 bug）
export const apply = (ctx) => { /* 注册 */ }
```

注册用 `ctx.scrcpyProviders.register({...})`，字段如下（细节见 `CONTRACT.md` §8）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 必填 | provider 标识（core 内部路由用，别改） |
| `label` | 必填 | 显示名，**`{zh,en}`** |
| `transport` | 必填 | `wired` / `wireless` / 两者（core 用它分组、选画面档位） |
| `coreCompat` | 必填 | 支持的 core 版本，如 `^1.0.0`；**判定权在 core**，不通过就把你标停用（设备不进列表、动作不路由），**你不要 throw** |
| `available` | 必填 | 当前环境能不能用（adb/hdc/java 在不在）；不可用时要给 `note`（**`{zh,en}`**）说明原因 |
| `capabilities` | 必填 | 你支持什么：`picture` / `keys` / `keyLabels` / `aiKeys` / `streams` / `log` / `hintSwipe` / …（**声明了 core 才显示，不声明不静默失效而是给提示**） |
| `actions` | 必填 | 见 §2 |
| `handlers` | 必填 | 见 §3 |

设备列表由你推给 core：`ctx.scrcpyProviders.setDevices(id, rows)`。
core 每 3 秒会经 `devices:refresh {id}` 找你要一次，**你不需要自己定时推**。

## 2. core 会调你什么（`actions`）

| 动作 | 入参 | 返回 | 注意 |
|---|---|---|---|
| `listDevices` | — | 设备行数组（sn、型号、状态…） | 要快；慢会拖住 core 的刷新 |
| `startStream` | sn + 画面选项 | 起流所需信息（端口等），交给浏览器半区连 | 中途**不允许**改缩放（两端都不支持，见 §6） |
| `stopStream` | sn | — | 要幂等 |
| `snapshot` | sn | 图片 | 给 AI 看图 |
| `dumpLayout` | sn | 控件树 | 给 AI 定点 |
| `input` | sn + 文本/键 | — | 文本注入走这条；**坐标类不走这里**（见 §6） |

core 用 `requireAction(...)` 取你的动作；**缺失 = 该功能对这台设备不可用**（core 会降级显示，不崩）。

## 3. 你会被 core 问什么（`handlers`，经 `provider:call`）

| 名字 | 用途 |
|---|---|
| `env:detect` | 环境检测：返回 `{ ok, items: [{key,label,ok,version,path,source,error}] }`；core 拿它渲染"环境"那一段，并决定 `available` |
| `cfg:describe` | 你的连接配置长什么样（分组、字段类型、`build` = 你的构建戳） |
| `cfg:get` / `cfg:save` | 读写配置；**画面四件套必须原样持久化**（key 由 core 定） |

## 4. 文案与语言的铁律（最容易踩）

- **用户可见**文案写成 `{ zh, en }`，**由 core 挑**；core **绝不把语言传给你**（少一个传递点就少一个 bug 点）。
- **面向 AI** 的文案（工具描述、提示词）**恒定英文**，不跟随界面语言。
- `{ zh, en }` 对象**绝不能**当普通对象塞进 React 子节点 —— React 会抛 error #31，一炸就是**整块 UI**（连顶栏菜单）消失。core 有兜底（`h()`/`capText`），但**别依赖**：嵌套字典（如 `keyLabels`）尤其危险。
- **别把失败变成静默**：拿不到的值要给 core 一句能显示的原因，别返回空串。

## 5. 画面四件套（key 由 core 定）

```
wiredScale / wiredFps / wirelessScale / wirelessFps
```

- 你必须**读这四项并让它们生效**、**原样持久化**，并在 `capabilities.picture` 里声明；
  **不声明 → core 显示"未声明画面选项"，不静默失效**。
- 默认：有线 `1/2` · 60fps，无线 `1/4` · 30fps；两端都能到"原画"（`'1'`）；帧率 120 封顶。
- **中途不允许换缩放**：连接中改设置不生效（两个平台都不支持），要换就断开重连。

## 6. 坐标与画面尺寸（踩过坑的部分，照做能省几天）

- **坐标空间**：把"你的输入通道期望哪个网格"报给浏览器半区（鸿蒙报设备分辨率，安卓报帧尺寸），
  **客户端按你报的值原样换算，不会去乘缩放倍数** —— 实测乘倍数会算错（转屏期间 SDK 自己给过 3/4 的尺寸）。
- **画面尺寸变化**：设备端重新初始化时会重发 SPS/PPS/IDR，客户端**扫到 SPS 就先换解码器再喂**；
  你要保证新配置帧**别被你自己吞掉**（暂停/过滤时尤其小心）。
- **暂停期间的变化**：如果浏览器半区在暂停时错过了配置，恢复后它会等一个"补发的起点"；
  有能力就补发（安卓 provider 的 GOP 缓存 / 鸿蒙 sidecar 的缓存补发），没能力就让客户端在恢复时重开会话。

## 7. 构建戳与打包

- 包里必须有 `PROVIDER_BUILD = 'YYYY-MM-DD.B<N>'`（当天第 N 次构建），经 `cfg:describe.build` 显示在**「连接设置」按钮行左边**。
  规则与理由见仓库根 `AGENTS.md` §1；**改动真的进了 tgz 才 +1**，纯注释不算。
- 打包前自检（本仓库的约定）：语法检查 → 客户端半区 smoke（core 才有）→ 解包复核"改动真在包里"。
- **改完宿主半区要完全退出 App 再打开**（浏览器半区刷新即可）。

## 8. 许可与第三方

- 随包发布的第三方二进制/源码，必须在 `THIRD_PARTY_NOTICES.md` 里写清出处与许可。
- 能**不随包带**的就别带（例如需要额外授权的 SDK jar：让用户自己准备，包里只做检测与提示）。

## 9. 看两个现成实现（各有取舍）

| 实现 | 特点 | 值得学的地方 |
|---|---|---|
| `dsh-android-scrcpy` | **provider 在流路径里**：自己连 scrcpy 两路 socket、解包、GOP 缓存、给客户端推尺寸 | 流控与坐标都在自己手里；`replayGop` 是"补发起点"的范本 |
| `dsh-hos-scrcpy` | **provider 不在流路径里**：浏览器直连 Java sidecar 的 WS；provider 只负责起停与环境 | provider 可以很薄；sidecar 承担流与补发（`hos/Dev/doc.md` 有它的说明） |
