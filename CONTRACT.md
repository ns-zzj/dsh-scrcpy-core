# core ↔ provider 契约（草案 v0.1）

> **状态：草案**。core 与 android provider 按这份实现；hos provider 之后再对齐（它是 3.0.0）。
> **原则：【用户口述】core 决定"做什么"，provider 决定"怎么做到"。**
> provider **不注册 UI、不注册工具、不写 AI 提示词、不关心聚焦是谁**。
>
> 标记说明：**【提议】= AI 提的方案，还没经用户确认**；**【待定】= 明确还没定**。

## 1. 谁提供、谁消费

| 方向 | 内容 |
|---|---|
| **provider → core** | 登记自己（id / 名字 / 传输 / 是否可用）、上报设备列表与状态 |
| **core → provider** | 按设备号下发动作（截图 / 控件树 / 点 / 长按 / 按键 / 输入 / 起停流） |

core 在 host 半区暴露服务名 **`scrcpyProviders`**，provider 用 `inject` 依赖它。

**依赖形态（【用户口述 2026-09-25】：自由装）**：
- provider **不声明**对 core 的包依赖（**不写进 `dependencies`**）→ 装 provider **不会**自动把 core 拉下来；
- **没装 core** → provider 因 `inject` 不满足而**静默不激活**：不报错，但也用不了（**这是设计如此**）；
- **装了 core 但版本不配套** → **判定权在 core**：provider 只声明 `coreCompat`（一段"匹配 core"的文字），
  core 拿自己的版本比对；不通过就把该 provider 标成**停用**（设备不进合并列表、动作不路由 = 不让用），
  菜单显示一句原因。**provider 不 throw**（坏的那个不拖垮别人），也**不需要读 core 的版本**。

> ⚠️ **作废**：早先"provider 精确 pin core + 在模块顶层校验版本"的写法 ——
> 模块顶层一旦 `require('dsh-scrcpy-core/package.json')`，**没装 core 就会报错**，与"自由装"冲突。

## 2. 登记（provider → core）【提议】

```js
ctx.scrcpyProviders.register({
  id: 'android',            // 稳定 id：UI 与配置里用它
  label: '安卓',             // 界面显示名
  transport: 'adb',         // 传输方式（诊断用）
  available: true,          // 环境检测结果（adb / jar 在不在）
  note: '',                 // 不可用原因（可选）
  actions: { snapshot, dumpLayout, tap, longpress, key, input, startStream, stopStream },
})
```

## 3. 设备列表（provider → core）【提议】

provider 主动上报（首次 + 变化时）：

```js
ctx.scrcpyProviders.setDevices('android', [
  { sn, name, model, online: true, streaming: false },
])
```

**core 负责合并多个 provider 的设备列表**，并维护"当前聚焦设备"（= UI 上正看的那台）。
聚焦设备是 **core 记一份**，所属 provider 只是它的一个属性 —— **provider 不需要知道聚焦是谁**。

## 4. 动作接口（core → provider）【提议】

工具被调用时：core 查聚焦设备 → 找它的 provider → 调对应动作。**全部按 `sn` 定位；坐标一律用 0..1 比例。**

| 方法 | 用途 | 返回 |
|---|---|---|
| `snapshot(sn)` | 取一帧画面 | `{ bytes, mediaType }` |
| `dumpLayout(sn)` | 控件树，**由 provider 压成统一清单** | `{ items: [...] }`（字段见下） |
| `tap(sn, fx, fy)` | 点击 | `{ ok }` |
| `longpress(sn, fx, fy, ms)` | 长按 | `{ ok }` |
| `key(sn, key)` | `back` / `home` | `{ ok }` |
| `input(sn, text)` | 文本输入（支持中文） | `{ ok }` |
| `startStream(sn)` / `stopStream(sn)` | 投屏流起停 | `{ endpoint }` / `{ ok }` |

**控件清单的统一字段**（照 2.1.1 的既有格式，两端都压成这个形状）：

```
{ type, text, id, clickable, fx, fy, w, h }
```

> ⚠️ **【待定】**：hos 用 `uitest dumpLayout` 的 JSON、android 用 `uiautomator dump` 的 XML，
> 字段语义不完全对应（比如"组件名"在两边叫法不同）。压平规则要等 android 侧实做时按真实数据定。

## 5. 投屏流怎么走（**已定：core 定义协议，provider 实现端点**）

- **(A) provider 开一个本机端点，core 的浏览器半区直接连** —— 沿用 2.1.1 鸿蒙**已发布并跑通**的形态。
- **端点上的协议由 core 定义**（它是契约的一部分），provider 必须实现**同一套**，
  否则"一套 UI 两种平台"不成立。协议就用 2.1.1 鸿蒙那套（已验证）：

| 方向 | 内容 |
|---|---|
| provider → 浏览器 | **二进制帧** = H.264（annexb，含 SPS/PPS 与关键帧）；**文本帧** = `{"msg":"size","data":"宽x高"}`、`{"msg":"log","data":"一行日志"}` |
| 浏览器 → provider | `{"type":"size"}`、`{"type":"screen","mode":"video"\|"pause"\|"resume"}`、`{"type":"touch","event":"down\|move\|up","x":..,"y":..}`（**帧坐标**）、`{"type":"key","name":"back\|home\|volumeUp\|volumeDown\|power"}`、`{"type":"hid","usage":<USB HID usage>,"mods":<修饰键位图>,"down":true\|false}`（PC 键盘直输）、`{"type":"log","on":true\|false}` |

### 5.1 PC 键盘直输（真外接键盘）—— **2026-09-26 真机打通 ✅**

provider 连上 control 后发 `UHID_CREATE` 建一个**虚拟外接键盘**，之后每个键发一帧 8 字节 HID 报告。
设备侧是**真 HID 设备**，所以**系统输入法会接管**（实测：拼音 `ce'shi` → 候选条 `1测试 2侧石 3侧视 …` ✅）。

| 消息（照抄官方 scrcpy 4.1，**勿改**） | 布局 |
|---|---|
| `12 UHID_CREATE` | `[12][id u16][vendor u16][product u16][名字长 u8][名字][描述符长 u16][描述符]` |
| `13 UHID_INPUT` | `[13][id u16][size u16][data…]` |
| `14 UHID_DESTROY` | `[14][id u16]` |

- 键盘 `id = 1`；报告描述符 **63 字节**（官方 `app/src/hid/hid_keyboard.c` 那张表，逐字节抄）；
  一份报告 = `[修饰键][0][最多 6 个按下的 usage]`（LCtrl 0x01 / LShift 0x02 / LAlt 0x04 / LGui 0x08 …）。
- **不需要改 server 启动参数**：服务端收到 `UHID_CREATE` 才按需建 `UhidManager`（`Controller.java:183-212`），UHID 全走 control 通道。
- 浏览器侧用 **`event.code`（物理键位）**查 HID usage 表（不能用 `event.key`：IME 激活时它是 `'Process'`）；
  修饰键只改报告第 0 字节；**重复键交给设备侧**（HID 规范）；`F5/F11/F12`、`Ctrl+R` 留给宿主。
- ⚠️ **`scid` 是十六进制解析**（`Options.java:346` `parseInt(value, 0x10)`）：传 `scid=1234` → socket `scrcpy_00001234`。
  自测脚本见 `Temp/uhid-probe.mjs`。

- **新观众接入必须能立刻解码**：provider 负责**补发 config(SPS/PPS) + 最近一个关键帧（GOP 回放）**。
  鸿蒙靠重开编码会话做到（整条流只有一个 IDR，见 `Dev/doc.md` §2.4-16）；安卓 demo 已有 GOP 缓存，**更干净**。
- **暂停广播**语义：会话留着、只是不推帧（鸿蒙实测：恢复时 `requestIDRFrame()` 约 117ms 出新的 IDR）。
- ⚠️ **设备日志流【不做】**（2026-09-26【用户口述】）：面板的「日志」是**插件日志** ——
  显示浏览器侧诊断 + provider 经 `{"msg":"log"}` 推的**插件诊断行**，不是设备日志（鸿蒙 hilog 一类也不做）。
  `{"msg":"log"}` 的语义现在就等于"插件日志的一行"，所有 provider 都可以推。
- ⚠️ **demo 里有一处不许照搬**：`startDevice` 清残留时 `pidof app_process` 会把设备上**所有** app_process 都杀掉
  （demo 注释自己写了"demo 图方便；真实现里只清自己起的那个"）→ provider 必须**只清自己那台设备的那个**。

## 6. 权限与二次确认

- provider 只报**事实**（设备在不在线、命令成没成功）；
- **开不开允许、要不要弹二次确认**由 core 判定（弹层是 UI，UI 在 core）；
- ⚠️ **【待定】**：provider 要不要保留"最后一道校验"（即使 core 说可以，provider 再确认一次设备在线/已授权）。
- ⚠️ **【待定】**："授权"指哪个：2.1.1 里是**插件自己的开关**；`adb`/`hdc` 还有一层**系统授权**
  （设备端弹"允许调试"）。两者不是一回事，要不要分开报给 AI。

## 7. 版本

- provider **不在 `package.json` 里声明 core**（见 §1）→ 两个包各自独立发版、各自独立安装；
- 一致性靠**运行时**校验，且**判定权在 core**：provider 在 `register()` 里声明 `coreCompat`，core 拿自己的版本比对。
  支持四种写法：

  | 写法 | 含义 |
  |---|---|
  | `"1.0.0"` | 精确等于 |
  | `"~1.0.0"` | 同 major 且同 minor —— **只允许最后一位变**（1.0.1、1.0.9 通过；1.1.0、2.0.0 不通过） |
  | `"^1.0.0"` | 同 major（1.x 都通过） |
  | `">=1.0.0"` | 下限 |

  空字符串 = 不声明（不校验，放行）。**两个 provider 目前都用 `~1.0.0`**：core 加了功能升到 1.1.0 时它们会被自动停用，
  必须**有意识地把声明抬到 `~1.1.0`** 才重新启用。
- 不通过 → 该 provider 被标成**停用**（设备不进列表、动作不路由），菜单显示 `blockReason`；
- ⚠️ **作废两条**：①"provider 精确 pin core"（会导致装 provider 时自动拉 core）；
  ②"版本检查放模块顶层 + `throw`"（没装 core 时会直接报错，与"自由装"冲突；现在 provider 不 throw）。

## 8. provider 自己的 RPC（core 不认识的形状，用 `provider:call` 转发）

core **不认识**"Java 路径""hdc 路径""adb 路径"这类东西，所以这些一律归 provider，
并约定三个标准方法（UI 用 `rpc('provider:call', { id, method, args })` 调用）：

| 方法 | 返回 | 用途 |
|---|---|---|
| `env:detect` | `{ ok, items: [ { key, label, ok, version, path, source, error, info? } ] }` | core 菜单里**按 provider 分组**渲染环境行：hos 报 `Java` + `hdc`，android 报 `adb`。`info: true` = 纯信息行（没有路径，core 不显示"未配置"占位符） |
| `cfg:describe` | `{ ok, fields: [ { key, label, type: 'text'\|'number'\|'select', group?: 'env'\|'param', placeholder, help, options? } ] }` | core 照这个渲染「连接设置」表单 → **UI 完全平台无关** |
| `cfg:get` / `cfg:save` | `{ ok, config }` / `{ ok, config, error }` | 读写 provider 自己的配置（**必须原样持久化 §8.1 的四个 key**） |

**字段约定**（【用户口述 2026-09-26】：环境设置 = 状态点 + 路径；参数设置 = 其余）：

- `group: 'env'` → 渲染在**「环境设置」**分区（状态小绿点行下面、路径输入框）；留空视作 `'param'`；
- 所有 `label` / `help` / `placeholder` / `options[].label` 都可以写成 **`{ zh, en }`**（core 按当前语言挑 —— 语言由客户端经 `locale:set` 告知 core）；
- `type: 'select'` + `options: [ { value, label } ]` → 渲染成下拉框。

### 8.1 画面四件套（**core 固定渲染，provider 必须实现**）

【用户口述 2026-09-26】"provider 里必须包含这四个画面选项的实现，然后还能自定义别的参数设置"。

core 在「参数设置」分区**固定**渲染这四项，**key 由 core 定**（provider 只读，不改名）：

| key | 含义 | 默认 | 选项 |
|---|---|---|---|
| `wiredScale` | 有线缩放 | `1/2` | `1`(原画) / `1/2` / `1/3` / `1/4` |
| `wiredFps` | 有线最低帧率 | `60` | `120` / `60` / `30` / `15`（**120 封顶**） |
| `wirelessScale` | 无线缩放 | `1/4` | 同上 |
| `wirelessFps` | 无线最低帧率 | `30` | `60` / `30` / `15` |

- **provider 必须**：① 读这四个 key 并让它们**真的生效**（scrcpy 系即 `--max-size` / `--max-fps`，
  缩放按设备长边折算像素）；② 在 `cfg:get`/`cfg:save` 里**原样持久化**它们；
  ③ 用 `capabilities.picture` **声明**自己会读（结构见下），否则 core 会在那一行显示
  **"这个 provider 未声明画面选项，下面四项可能不生效"**（**不静默失效**）；
- `capabilities.picture` 可只写要覆盖的部分；缺省用 core 的默认档位：
  ```js
  picture: {
    wired:    { scale: ['1','1/2','1/3','1/4'], fps: [120,60,30,15], defaultScale: '1/2', defaultFps: 60 },
    wireless: { scale: ['1','1/2','1/3','1/4'], fps: [60,30,15],     defaultScale: '1/4', defaultFps: 30 },
  }
  ```
- 有线/无线怎么判：**provider 自己判**（安卓侧 = adb 目标形如 `192.168.x.x:5555` 带端口即无线）；
  core 不参与判断，只把两组值都存下来。

### 8.1.1 键盘接管的三态声明（`capabilities.keyboard`）——【用户口述 2026-09-27】

投屏面板上那句键盘状态由 provider 决定，**三种写法含义不同**：

| 声明 | 面板显示 |
|---|---|
| `{ on: {zh,en}, off: {zh,en}, notReady?: {zh,en} }` | 有键盘接管：未接管 / 已接管 / 未就绪（按状态 + 是否真的挂上） |
| `false` | 「此平台不支持键盘接管」（明确表态：不是没做，是这个平台做不到） |
| 不声明 | **留白** —— 兼容老 provider / 未知情况，core 不替它下结论 |

⚠️ core 里判断时**不能**写 `caps.keyboard || null`：`false` 会被 `||` 吃掉，退化成"没声明"。

【实测 2026-09-27】鸿蒙侧只能通过 hdc 调设备上的 `uinput` CLI：单键一次往返约 **280–330 ms**
（`uinput -K -d <码> -u <码>`，键码以 SDK `oh_key_code.h` 为准：HOME=1 BACK=2 VOLUME_UP=16
VOLUME_DOWN=17 POWER=18 A=2017），而且 shell（`u:r:sh:s0`）**连 `/dev/input`、`/dev/uhid` 都打不开**
（Permission denied）→ 既做不到常驻控制通道，也挂不了虚拟键盘，故鸿蒙声明 `keyboard: false`。
（安卓可行是因为 scrcpy-server 跑在设备上持有 `/dev/uhid`，键走常驻 control socket，毫秒级。）

### 8.1.2 坐标空间声明（`capabilities.inputSpace`）——【用户口述 2026-09-28】

provider 的 `input` 动作**期望坐标落在哪个网格里**，由它自己声明：

| 取值 | 含义 | 谁用 |
|---|---|---|
| `'frame'`（**缺省**） | 解码出来的帧网格 | 安卓（scrcpy 控制协议要的就是帧坐标）|
| `'device'` | 设备屏幕网格 = 帧尺寸 × 生效缩放倍数 | 鸿蒙（SDK 的 `onTouchDown/Move/Up` 要设备坐标）|

core 的规则：声明 `'device'` 时，用 provider 报的原始值当坐标空间，**当前画面方向与它相反时对调 W/H**；
没声明则直接用帧尺寸（安卓）。

⚠️ 【2026-09-28 实测修正】**不要用"帧尺寸 × 生效缩放倍数"去算**：鸿蒙的编码尺寸并不总等于我们请求的档位
（转屏期间实测出现过 3/4 的 2160x1440），乘法会算出 4320x2880 这种错值。稳定可靠的关系只有**方向**
（哪边宽哪边高）。也不要读配置里的档位 —— 中途在设置里改档位但没重启投屏时，配置与生效值会分叉。

转屏后 sidecar 不会重发 `{msg:'size'}`，所以 core 存的是原值、由每次心跳按方向推导出实际用的坐标空间。

### 8.1.3 尺寸变化时要不要重建解码器（`capabilities.rebuildOnResize`）——【用户口述 2026-09-28】

| 声明 | 含义 | 谁用 |
|---|---|---|
| `true`（**缺省**） | 分辨率/方向变化后，provider 的流会重发**配置 + 关键帧** → core 重建解码器（并 `resume` 求一次起点）| 安卓（scrcpy-server 旋转后会重发，验证过的老路径）|
| `false` | 本 provider 的流**不会**重发配置+关键帧 → core **不要重建**，交给解码器自己按流里的新 SPS 换配置 | 鸿蒙 |

【实测依据】鸿蒙：重建后几百帧持续到达但 `buffered=[]`、`readyState=0`，一帧都解不出来；而重建前
`readyState=4`、正常播放 —— 即"中途重建 = 拿不到起点 = 永久黑屏"，只有等编码器下次重新初始化才短暂恢复。

### 8.2 按键声明（界面按钮 / AI 可用键）——【用户口述 2026-09-27】

按键**完全由 provider 声明**，core 不再内置默认表：

| 字段 | 含义 | 缺省 |
|---|---|---|
| `capabilities.keys` | **界面上的按键按钮**，数组顺序即显示顺序 | 无（= 一个按钮都不显示） |
| `capabilities.keyLabels` | 每个键的**双语显示名** `{ 键: { zh, en } }` | core 少量内置名（back/home/音量±/power），再缺就显示键名本身 |
| `capabilities.aiKeys` | **允许 AI 调用的键**（`scrcpy_key` 只放行这些） | 退回 `keys`；两者都没有 → 工具明确报错，不再默默放行 back/home |

```js
keys: ['back','home','volumeUp','volumeDown','power','enter','menu'],   // 界面按钮（7 个）
keyLabels: { back: { zh: '返回', en: 'Back' } /* … */ },
aiKeys: ['back','home'],                                                // AI 只允许这两个
```

界面上能按的和 AI 能按的**是两件事**：音量/电源会改变设备状态，默认不交给 AI。
`scrcpy_key` 的 schema **不写死合法值**（以前写死了 `enum: ['back','home']`，与 provider 声明冲突），
一律由运行时按 `aiKeys` 校验，报错里带上"支持哪些键"。

### 8.3 固定的一条诊断日志

provider 在起流时算出的关键参数（缩放/`max_size`/帧率/有线无线）应通过**插件日志面板**给用户看到，
而不只是 `console.log`。注意起流时网页客户端还没连上，消息会丢 —— 先存在会话上，
等 `ws.onOpen` 那一刻补发（参考 `android/lib/index.js` 的 `logPanel` / `flushLogPanel`）。

**【用户口述 2026-09-25】**：`env:detect` 就是"装了 hos 就显示 jdk & hdc，装了安卓就显示 adb"；
没装任何 provider 时 UI 要给一句明确提示（见 §9）。

## 9. 没有 provider 时（UI 行为）

`providers` 为空 → core 的菜单显示一段提示，讲清**三种可能**：
"要么 provider 全崩了、要么没装、要么你就是想看看不装会怎样"，
并给出装法 —— ⚠️ **桌面端（0.1.7，当前唯一目标）走应用内「插件面板」，不是命令行**
（`dsh plugin --profile desktop …` 被 CLI 拒绝；面板接受本地 tgz 路径 / npm 包名 / github 规格）。
core 自己**不假装能用**：设备列表、权限设置、AI 工具全部保持"没有设备"的真实状态。
