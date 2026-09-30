// ============================================================
// dsh-scrcpy-core —— Client 半区（浏览器）
//
// 唯一 UI owner：核心 UI 全在这里，provider 一行 UI 都不注册。
// 页面结构：
//   · 会话右上角「scrcpy 菜单」按钮 → 弹出设备列表（**按 provider 分组的**环境 + 设备）
//   · 每台设备一张右侧栏标签页；投屏画面挂在常驻面板里（切页不卸载、继续收流）
//   · 二次确认期间在画面上叠闪烁绿点（落点预览）
//   · AI 控制设置：四个权限三态 + 识别模型 + **各 provider 自己的连接设置（平台无关渲染）**
//
// 与 2.1.1 的差异：
//   1. 类名 .dshhos-* → .dshscrcpy-*，RPC 走 /dsh-scrcpy/rpc；
//   2. 设备列表**按平台分组**（用 provider 登记的 label 当组标题：鸿蒙设备 / 安卓设备）；
//   3. 环境检测与连接设置**不写死平台**：走 provider:call 的 env:detect / cfg:describe / cfg:get / cfg:save；
//   4. 菜单底色改成**不透明**（--dsw-alias-bg-layer-3）—— 修掉 2.1.1 在 DSH 0.1.7 下菜单半透明的问题；
//   5. 没装任何 provider 时给明确提示（不再是一片空白）。
// ============================================================

if (window.__dshScrcpyCoreRegistered) {
  try { console.warn('[dsh-scrcpy-core] bundle already registered - skip duplicate execution') } catch (e) {}
} else {
  window.__dshScrcpyCoreRegistered = true
  window.__ModuleLoader__.load({
  id: '@nszzj/dsh-scrcpy-core',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    /**
     * 所有元素都从这里造（原来是 React.createElement 的别名）。
     * 为什么包一层：React 只接受字符串/数字/数组/null/元素作为子节点，给它一个普通对象会抛 error #31
     * （"Objects are not valid as a React child"），而组件边界捕获之后会把**整块 UI**卸掉
     * （2026-09-27 实测：一点"启动"，投屏画面连同顶栏菜单按钮一起消失，因为面板挂在 header 组件里）。
     * provider 的文案可能是 {zh,en}（core 通常会挑好语言，但漏一处就会走到这儿），所以在这一层兜住：
     *   数组 → 逐个看；对象 → 有 $$typeof 才算真 React 元素（元素/Fragment/portal/memo/lazy 都带它），
     *   没有就按当前语言转成字符串。
     * 注意：React.createElement **本身不校验子节点**，错误要等渲染时才炸，所以必须在这之前兜。
     */
    const h = function (type, props) {
      const kids = []
      for (let i = 2; i < arguments.length; i++) {
        const c = arguments[i]
        kids.push(Array.isArray(c) ? c.map(fixChild) : fixChild(c))
      }
      return React.createElement.apply(null, [type, props].concat(kids))
    }
    function fixChild(c) {
      if (c === null || c === undefined) return c
      const t = typeof c
      if (t === 'string' || t === 'number') return c
      if (Array.isArray(c)) return c.map(fixChild)
      if (t === 'object') return c.$$typeof ? c : capText(c)
      return c
    }

    const RPC_PATH = '/dsh-scrcpy/rpc'
    const CSS_PREFIX = 'dshscrcpy'

    const CSS = `
.${CSS_PREFIX}-trigger { position: relative; display: inline-flex; }
.${CSS_PREFIX}-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 28px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #81858c);
  border: 0; background: transparent;
  font-size: 12px; line-height: 18px; gap: 4px;
  transition: background .15s ease, color .15s ease;
}
.${CSS_PREFIX}-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color: var(--dsw-alias-label-secondary, #61666b); }
.${CSS_PREFIX}-btn svg { width: 13px; height: 13px; display: block; }
.${CSS_PREFIX}-mask { position: fixed; inset: 0; z-index: 9980; background: transparent; }
/* 菜单底色用【不透明】的 layer-3：2.1.1 用的 --dsw-specific-menu 在 DSH 0.1.7 是 45% alpha，会透 */
.${CSS_PREFIX}-panel {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 9981;
  width: 380px; max-width: min(460px, calc(100vw - 32px));
  max-height: min(620px, calc(100vh - 140px)); overflow-y: auto;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-3, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.08));
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 13px; line-height: 20px; padding: 4px;
}
.${CSS_PREFIX}-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #0f1115); }
.${CSS_PREFIX}-panel-sec { padding: 8px 10px; }
.${CSS_PREFIX}-panel-sec + .${CSS_PREFIX}-panel-sec { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
/* provider 分组标题（鸿蒙设备 / 安卓设备） */
.${CSS_PREFIX}-group-title { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #61666b); margin: 10px 0 6px; }
.${CSS_PREFIX}-group-title:first-child { margin-top: 2px; }
.${CSS_PREFIX}-sec-title { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #81858c); letter-spacing: .04em; margin-bottom: 8px; }
.${CSS_PREFIX}-env-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color: var(--dsw-alias-label-secondary, #61666b); }
.${CSS_PREFIX}-env-badge.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.${CSS_PREFIX}-env-badge.bad { color: var(--dsw-alias-state-error-primary, #ec1313); }
.${CSS_PREFIX}-env-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #61666b); }
.${CSS_PREFIX}-env-row b { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; min-width: 52px; flex: none; }
.${CSS_PREFIX}-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); }
.${CSS_PREFIX}-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-border-l2, rgba(0,0,0,.1)); flex: none; }
.${CSS_PREFIX}-dot.ok { background: var(--dsw-alias-state-success-primary, #22c55e); }
.${CSS_PREFIX}-dot.bad { background: var(--dsw-alias-state-error-primary, #ec1313); }
.${CSS_PREFIX}-dot.warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.${CSS_PREFIX}-dot.idle { background: var(--dsw-alias-label-caption, #adb2ba); opacity: .55; }
.${CSS_PREFIX}-item-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 10px; flex: none; }
.${CSS_PREFIX}-list { display: flex; flex-direction: column; gap: 2px; }
.${CSS_PREFIX}-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px;
  font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
  transition: background .12s ease; border: 0; background: transparent; width: 100%; text-align: left; box-sizing: border-box;
}
.${CSS_PREFIX}-item-sn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${CSS_PREFIX}-item-sub { font-family: inherit; font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); margin-left: 6px; }
.${CSS_PREFIX}-connect { border: 0; background: transparent; cursor: pointer; padding: 0; font-size: 11px; color: var(--dsw-alias-state-business-primary, #4176e6); font-family: inherit; }
.${CSS_PREFIX}-connect:hover { text-decoration: underline; }
.${CSS_PREFIX}-connect:disabled { opacity: .5; cursor: default; }
.${CSS_PREFIX}-connecting { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-caption, #adb2ba); font-family: inherit; }
.${CSS_PREFIX}-select {
  height: 30px; padding: 0 6px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 12px; font-family: inherit; outline: none; flex: none;
}
.${CSS_PREFIX}-select:disabled { opacity: .45; cursor: not-allowed; }
.${CSS_PREFIX}-empty { padding: 10px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); white-space: pre-line; }
/* 没装任何 provider 时的提示块 */
.${CSS_PREFIX}-note { padding: 10px; margin: 4px 0; border-radius: 8px; font-size: 12px; line-height: 19px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color: var(--dsw-alias-label-secondary, #61666b); white-space: pre-line; }
.${CSS_PREFIX}-note code { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); color: var(--dsw-alias-label-primary, #0f1115); }
.${CSS_PREFIX}-hint { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-caption, #adb2ba); margin-top: 4px; }
/* 连接设置的分区标题 + 四件套那一行（有线/无线 各一行，里面塞两个下拉） */
.${CSS_PREFIX}-sec-head { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8b949e); }
.${CSS_PREFIX}-row2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${CSS_PREFIX}-mini { font-size: 11px; color: var(--dsw-alias-label-caption, #adb2ba); }
.${CSS_PREFIX}-ctl { background: var(--dsw-alias-bg-module-platform, #21262d); color: var(--dsw-alias-label-primary, #e6edf3); border: 0.5px solid var(--dsw-alias-border-l2, #30363d); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 13px; }
.${CSS_PREFIX}-panel-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.${CSS_PREFIX}-btn-sm {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  font-size: 13px; line-height: 20px; font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115); transition: background .12s ease;
}
.${CSS_PREFIX}-btn-sm:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.${CSS_PREFIX}-btn-primary { background: var(--dsw-alias-button-info-fill, #4176e6); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.${CSS_PREFIX}-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover, #679efe); }
.${CSS_PREFIX}-btn:disabled, .${CSS_PREFIX}-btn-sm:disabled { opacity: .55; cursor: default; }
.${CSS_PREFIX}-dialog-mask { position: fixed; inset: 0; z-index: 9990; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24)); display: flex; align-items: flex-start; justify-content: center; padding-top: 10vh; }
.${CSS_PREFIX}-dialog { width: 470px; max-width: calc(100vw - 40px); max-height: 80vh; overflow-y: auto; box-sizing: border-box; background: var(--dsw-alias-bg-layer-3, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 14px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.08)); color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; line-height: 20px; }
.${CSS_PREFIX}-dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); font-weight: 600; font-size: 14px; line-height: 22px; }
.${CSS_PREFIX}-dialog-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.${CSS_PREFIX}-dialog-sub { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #61666b); margin-top: 4px; }
.${CSS_PREFIX}-field { display: flex; flex-direction: column; gap: 5px; }
.${CSS_PREFIX}-field label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary, #61666b); }
.${CSS_PREFIX}-field input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px; border-radius: 8px; font-size: 12px; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); outline: none; transition: border-color .12s ease; }
.${CSS_PREFIX}-field input:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.${CSS_PREFIX}-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.${CSS_PREFIX}-close { border: none; background: transparent; cursor: pointer; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 15px; line-height: 1; width: 24px; height: 24px; border-radius: 6px; }
.${CSS_PREFIX}-close:hover { color: var(--dsw-alias-label-primary, #0f1115); background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.${CSS_PREFIX}-spin { width: 11px; height: 11px; border-radius: 50%; flex: none; border: 2px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-top-color: var(--dsw-alias-state-business-primary, #4176e6); animation: ${CSS_PREFIX}-rotate .7s linear infinite; }
@keyframes ${CSS_PREFIX}-rotate { to { transform: rotate(360deg); } }
.${CSS_PREFIX}-notice { font-size: 12px; color: var(--dsw-alias-state-success-primary, #22c55e); }
.${CSS_PREFIX}-setting-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; }
.${CSS_PREFIX}-setting-info { flex: 1; min-width: 0; }
.${CSS_PREFIX}-setting-label { font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary, #0f1115); }
.${CSS_PREFIX}-control {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 9995;
  width: 360px; box-sizing: border-box;
  background: var(--dsw-alias-bg-base, #f9fafb);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  display: flex; flex-direction: column;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 12px;
  transition: width .2s ease;
}
.${CSS_PREFIX}-control-overlay { position: fixed; border-left: 0; transition: none; contain: layout paint; }
.${CSS_PREFIX}-control-hidden { display: none; }
.${CSS_PREFIX}-tab-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; padding: 24px; box-sizing: border-box; text-align: center; }
.${CSS_PREFIX}-control-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); flex: none; }
.${CSS_PREFIX}-csn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b); }
.${CSS_PREFIX}-control-head .${CSS_PREFIX}-btn-sm { flex: none; white-space: nowrap; }
.${CSS_PREFIX}-quality { flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); color: var(--dsw-alias-label-tertiary, #81858c); white-space: nowrap; }
.${CSS_PREFIX}-shot-btn { font-size: 11px; padding: 0 8px; height: 24px; }
.${CSS_PREFIX}-control-status { padding: 6px 12px; font-size: 12px; line-height: 18px; flex: none; }
.${CSS_PREFIX}-control-status.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.${CSS_PREFIX}-control-status.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.${CSS_PREFIX}-control-status.bad { color: var(--dsw-alias-state-error-primary, #ec1313); }
.${CSS_PREFIX}-status-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; flex: none; }
.${CSS_PREFIX}-status-bar .${CSS_PREFIX}-control-status { padding: 0; flex: 1; min-width: 0; }
.${CSS_PREFIX}-input-wrap { position: relative; flex: none; }
.${CSS_PREFIX}-input-btn { font-size: 11px; padding: 0 8px; height: 24px; }
.${CSS_PREFIX}-input-pop {
  position: absolute; top: calc(100% + 6px); right: 6px; z-index: 9996;
  display: flex; align-items: center; gap: 6px;
  padding: 8px; border-radius: 10px; width: 240px; box-sizing: border-box;
  background: var(--dsw-alias-bg-layer-3, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.08));
}
.${CSS_PREFIX}-input-field {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-size: 12px; font-family: inherit; outline: none;
}
.${CSS_PREFIX}-input-field:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.${CSS_PREFIX}-screen { flex: 1; min-height: 0; background: #000; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
.${CSS_PREFIX}-screen video { width: 100%; height: 100%; object-fit: contain; display: block; cursor: crosshair; }
.${CSS_PREFIX}-log {
  flex: 1; min-height: 40px; max-height: 160px; overflow-y: auto;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
  padding: 6px 12px;
  font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
  font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: pre-wrap; word-break: break-all;
}
.${CSS_PREFIX}-control-keys { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); flex: none; }
.${CSS_PREFIX}-control-keys > button { flex: 1 1 auto; white-space: nowrap; }
.${CSS_PREFIX}-key { height: 34px; padding: 0 12px; border-radius: 8px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #0f1115); font-size: 12px; font-weight: 500; white-space: nowrap; transition: background .12s ease; }
.${CSS_PREFIX}-key:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.${CSS_PREFIX}-key:disabled { opacity: .5; cursor: default; }
.${CSS_PREFIX}-key-log { color: var(--dsw-alias-state-business-primary, #4176e6); }
[class$="centerCol"] { margin-right: var(--${CSS_PREFIX}-panel-w, 0px); transition: margin-right .2s ease; }
.${CSS_PREFIX}-tapdot {
  position: absolute; width: 28px; height: 28px; border-radius: 50%;
  background: rgba(34,197,94,.25); border: 3px solid rgba(34,197,94,.7);
  box-shadow: 0 0 14px rgba(34,197,94,.55);
  transform: translate(-50%, -50%);
  pointer-events: none; z-index: 9999;
  animation: ${CSS_PREFIX}-blink .8s ease-in-out infinite;
}
@keyframes ${CSS_PREFIX}-blink { 0%, 100% { opacity: .9; } 50% { opacity: .25; } }
.${CSS_PREFIX}-tapdot.slow { animation-duration: 1.8s; }
`

    const GUIDE_CSS = `
.${CSS_PREFIX}-guide{box-sizing:border-box;flex-direction:column;justify-content:center;align-items:center;gap:14px;min-height:100%;padding:0 24px;display:flex}
.${CSS_PREFIX}-guide:after{content:"";flex:0 10%}
.${CSS_PREFIX}-guide-hero{color:var(--dsw-static-neutral-200,#c7c7cc);margin-bottom:16px;display:flex}
body[data-ds-dark-theme] .${CSS_PREFIX}-guide-hero{color:var(--dsw-static-neutral-700,#3a3a3c)}
.${CSS_PREFIX}-guide-entry{box-sizing:border-box;width:380px;max-width:100%;min-height:56px;color:var(--dsw-alias-label-primary,inherit);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1,transparent);border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.25));cursor:pointer;border-radius:24px;align-items:center;gap:14px;padding:14px 20px;display:flex}
.${CSS_PREFIX}-guide-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.${CSS_PREFIX}-guide-entryIcon{width:26px;height:26px;color:var(--dsw-alias-label-secondary,inherit);flex:none;justify-content:center;align-items:center;display:flex}
.${CSS_PREFIX}-guide-placeholderInk{color:var(--dsw-alias-label-tertiary,inherit)}
.${CSS_PREFIX}-guide-entryText{flex-direction:column;gap:3px;min-width:0;display:flex}
.${CSS_PREFIX}-guide-entryTitle{white-space:nowrap;text-overflow:ellipsis;font-size:15px;line-height:1.4;overflow:hidden}
.${CSS_PREFIX}-guide-entryDescription{color:var(--dsw-alias-label-caption,inherit);white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:1.4;overflow:hidden}
`

    // ------------------------------------------------------------
    // 基础设施
    // ------------------------------------------------------------
    function rpc(method, args) {
      return fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args || {} }),
      }).then(function (resp) { return resp.json() }).then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || ('RPC failed: ' + method))
        return res.result
      })
    }

    /** 调某个 provider 自己的方法（环境检测 / 配置读写），core 不认识它们的形状 */
    function providerCall(id, method, args) {
      return rpc('provider:call', { id: id, method: method, args: args || {} })
    }

    function insertStyles(css) {
      try {
        const el = document.createElement('style')
        el.setAttribute('data-plugin', '@nszzj/dsh-scrcpy-core')
        el.textContent = css
        document.head.appendChild(el)
      } catch (e) {}
    }

    function interval(fn, ms) { const id = window.setInterval(fn, ms); return function () { try { window.clearInterval(id) } catch (e) {} } }
    function timeout(fn, ms) { const id = window.setTimeout(fn, ms); return function () { try { window.clearTimeout(id) } catch (e) {} } }

    function base64ToBytes(b64) {
      const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      const lookup = {}
      for (let i = 0; i < CH.length; i++) lookup[CH[i]] = i
      const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '')
      const bytes = []
      let i = 0
      while (i < clean.length) {
        const e1 = lookup[clean[i++]]
        const e2 = lookup[clean[i++]]
        const e3 = clean[i] !== undefined && clean[i] !== '=' ? lookup[clean[i++]] : undefined
        const e4 = clean[i] !== undefined && clean[i] !== '=' ? lookup[clean[i++]] : undefined
        bytes.push((e1 << 2) | (e2 >> 4))
        if (e3 !== undefined) bytes.push(((e2 & 15) << 4) | (e3 >> 2))
        if (e4 !== undefined) bytes.push(((e3 & 3) << 6) | e4)
      }
      return new Uint8Array(bytes)
    }

    function apply(ctx) {
      insertStyles(CSS)
      insertStyles(GUIDE_CSS)

      const slots = ctx.get('slots')
      if (slots === undefined) return
      const conversationService = ctx.get('conversation')

      // 跨组件唤起菜单（header 按钮与「开始」页入口共用同一个弹层）
      const menuOpenListeners = new Set()
      function openScrcpyMenu() { menuOpenListeners.forEach(function (fn) { try { fn() } catch (e) {} }) }
      function onScrcpyMenuOpen(fn) { menuOpenListeners.add(fn); return function () { menuOpenListeners.delete(fn) } }

      // ------------------------------------------------------------
      // 共享状态：菜单在 header 槽、投屏面板在右侧栏标签页，是两棵组件树，
      // 用模块级 store + 订阅同步（连了哪台设备 / 四个权限模式 / 聊天输入框动作）
      // ------------------------------------------------------------
      const sessionStore = (function () {
        // sessions: { sn -> {sn,port,wireless,scale,frameRate,...} }（可多台同时投屏）
        // docks:    { sn -> {left,top,width,height,fullscreen} } 各设备标签页上报的矩形
        let state = { sessions: {}, focusedSn: '', docks: {}, shotMode: {}, ctlMode: {}, keyMode: {}, inputMode: {}, inputActions: null, openError: '' }
        const listeners = new Set()
        function get() { return state }
        function set(patch) { state = Object.assign({}, state, patch); listeners.forEach(function (fn) { try { fn() } catch (e) {} }) }
        function update(key, mutate) { const copy = Object.assign({}, state[key]); mutate(copy); const patch = {}; patch[key] = copy; set(patch) }
        function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
        function setSession(info) { const next = Object.assign({}, state.sessions); next[info.sn] = info; set({ sessions: next }) }
        function removeSession(sn) { const next = Object.assign({}, state.sessions); delete next[sn]; const docks = Object.assign({}, state.docks); delete docks[sn]; set({ sessions: next, docks: docks }) }
        function setDock(sn, rect) { const docks = Object.assign({}, state.docks); if (rect) docks[sn] = rect; else delete docks[sn]; set({ docks: docks }) }
        return { get: get, set: set, update: update, subscribe: subscribe, setSession: setSession, removeSession: removeSession, setDock: setDock }
      })()

      function useSessionStore() {
        const [state, setState] = React.useState(sessionStore.get())
        React.useEffect(function () { return sessionStore.subscribe(function () { setState(sessionStore.get()) }) }, [])
        return state
      }

      // 截图并像粘贴图片一样塞进聊天输入框（菜单里的面板与标签页面板共用）
      async function addShotToChat(sn, inputActions) {
        if (!inputActions || !inputActions.addImages) return { ok: false, error: T('shot.noInput') }
        if (!conversationService) return { ok: false, error: T('shot.noConversation') }
        const r = await rpc('shot:capture', { sn: sn })
        if (!r || !r.ok || !r.base64) return { ok: false, error: T('shot.captureFailed', { msg: (r && r.error) || T('common.unknown') }) }
        const mediaType = r.mediaType || 'image/jpeg'
        const ext = mediaType === 'image/png' ? 'png' : 'jpeg'
        const file = new File([base64ToBytes(r.base64)], 'dsh-scrcpy-shot.' + ext, { type: mediaType })
        const images = conversationService.createDraftImages([file])
        if (!images || !images.length) return { ok: false, error: T('shot.addFailed') }
        if (!inputActions.addImages(images.map(function (img) { return img.id }))) {
          try { conversationService.releaseDraftImages(images) } catch (e) {}
          return { ok: false, error: T('shot.busy') }
        }
        return { ok: true }
      }

      // ── i18n ──────────────────────────────────────────────────────────────
      // 跟随 DSH 的语言（`dsh-client-locale` 提供的 `ctx.locale` 服务）：
      //   locale.register(ns, { zh, en }) 注册双语字典（英文是 DSH 的兜底语言）
      //   locale.bind(ns) → t('key', { 占位 })；**读的是调用时的活动语言**，所以只要重渲染就切过来了
      // 拿不到 locale 服务（老版本 DSH / 独立跑）时 T() 直接返回中文模板 —— 功能不受影响。
      // 构建戳现在由**宿主**提供（devices:list / core:info 的 build）→ 显示在菜单标题栏最右；
      //   客户端不再自带一份（同一个包里重复没有信息量）
      const ZH = {
        'menu.title': 'scrcpy 菜单', 'menu.describe': '打开设备列表',
        'menu.refresh': '刷新', 'menu.refreshing': '刷新中',
        'menu.group': '{label}设备', 'menu.envReady': '环境就绪', 'menu.envPending': '待配置',
        'menu.unavailable': '不可用', 'menu.blocked': '已停用', 'menu.blockReason': '与当前 core 版本不配套，已停用',
        'menu.connSettings': '连接设置', 'menu.start': '启动', 'menu.mirror': '投屏', 'menu.disconnect': '断开',
        'menu.connecting': '连接中…', 'menu.detecting': '正在检测…', 'menu.detectingDevices': '正在检测设备…',
        'menu.noDevices': '没检测到设备\n请确认设备已开调试并连上（USB 或无线）',
        'menu.providerUnavailable': '这个 provider 当前不可用',
        'menu.notConfigured': '未配置', 'menu.runFailed': '运行失败',
        'menu.running': '正在运行（sidecar 已启动）', 'menu.notRunning': '未启动',
        'menu.permHint': 'AI 权限在每台设备的投屏面板「设置」里',
        'menu.noProvider.title': '没有检测到任何 provider（设备支持包）',
        'menu.noProvider.three': '三种可能：',
        'menu.noProvider.a': '① provider 崩了 —— 看 DSH 日志里有没有它抛的错；',
        'menu.noProvider.b': '② 还没装 —— 在插件面板里装上兼容的 provider；',
        'menu.noProvider.c': '③ 你就是想看看不装会怎样 —— 那现在就是正确答案：菜单在、但一台设备也没有，AI 调工具会明确告诉你「没有聚焦设备」。',
        'panel.tab': '投屏', 'panel.tabTitle': '投屏 · {sn}', 'panel.goneTitle': '已断开 · {sn}',
        'panel.notConnected': '这台设备还没连接。', 'panel.openMenu': '打开「scrcpy 菜单」',
        'panel.waitFirst': '已连接，正在等待第一帧…', 'panel.waitSwipe': '已连接，等待首帧……（请持续滑动设备画面以更新）',
        'panel.status': '已连接 · {n} 帧 / {mb} MB', 'panel.noChange': '画面无变化 {n} 秒',
        'panel.stillSwipe': '画面静止 {n} 秒 · 请操作设备更新画面',
        'panel.closed': '连接已断开', 'panel.wsError': 'WebSocket 错误', 'panel.errorPrefix': '错误: {msg}',
        'panel.shot': '添加截图至聊天框', 'panel.settings': '设置', 'panel.disconnect': '断开',
        'panel.wireless': '无线（TCP）连接：视频流已固定降到 1/4 画质以减轻卡顿', 'panel.wired': '有线（USB）连接',
        'panel.log': '日志', 'panel.logEmpty': '（插件日志为空）',
        'panel.kbdOff': '键盘未接管', 'panel.kbdOn': 'UHID已启用·键盘已接管',
        'panel.kbdNotReady': '键盘未接管（UHID 未就绪）',
        'panel.kbdTitle': '点一下画面接管键盘，点画面外放开',
        'panel.kbdUnsupported': '此平台不支持键盘接管',
        'key.back': '返回', 'key.home': '主页', 'key.volumeUp': '音量+', 'key.volumeDown': '音量-', 'key.power': '电源',
        'settings.title': 'AI 控制设置', 'settings.done': '完成',
        'settings.perm.shot': '允许截图', 'settings.perm.ctl': '允许读取控件&点击/长按',
        'settings.perm.key': '允许按键', 'settings.perm.keyDyn': '允许按键（{keys}）', 'settings.perm.input': '允许输入文字',
        'settings.mode.off': '禁止使用', 'settings.mode.confirm': '需要确认', 'settings.mode.trust': '无需确认',
        'settings.depHint': '读取控件 / 点击长按 / 按键 / 输入 都依赖「允许截图」',
        'settings.model': '识别模型', 'settings.modelLoading': '加载中…',
        'settings.modelNone': '没有任何提供方提供可用模型',
        'settings.notice.off': '已禁止 {sn} 的{label}',
        'settings.notice.set': '已设置 {sn} {label}为{mode}',
        'settings.err.load': '读取设置失败: {msg}', 'settings.err.save': '设置失败: {msg}',
        'cfg.title': '{label} · 连接设置', 'cfg.auto': '自动检测', 'cfg.cancel': '取消', 'cfg.save': '保存',
        'cfg.busy': '处理中…', 'cfg.reading': '读取中…', 'cfg.saved': '已保存',
        'cfg.detected': '已自动检测（还没保存）', 'cfg.detectFailed': '检测失败: {msg}',
        'cfg.saveFailed': '保存失败: {msg}', 'cfg.envFailed': '环境检测失败',
        'notice.streamEnded': '设备 {sn} 的投屏已结束（进程不在了）', 'notice.disconnected': '已断开 {sn}',
        'notice.shotAdded': '已添加截图到聊天框（可继续输入文字后发送）',
        'notice.connectFailed': '连接失败: {msg}', 'notice.tabFailed': '打开投屏标签页失败：{msg}',
        'notice.shotFailed': '添加截图失败', 'notice.disconnectFailed': '断开失败: {msg}',
        'notice.deviceInfoFailed': '获取设备信息失败: {msg}', 'notice.tabRegisterFailed': '注册设备标签页失败：{msg}',
        'notice.sidebarUnavailable': '侧栏服务不可用（slots={slots}, sidebarRightTabs={tabs}, sidebarRight={side}）',
        'shot.noInput': '聊天输入框不可用', 'shot.noConversation': '会话服务不可用',
        'shot.captureFailed': '截图失败: {msg}', 'shot.addFailed': '添加图片失败',
        'shot.busy': '输入框忙，未能添加图片',
        'common.unknown': '未知错误', 'common.unknownReason': '未知原因',
        // 连接设置的两个分区 + 画面四件套（【用户口述 2026-09-26】：环境设置 = 状态点 + 路径；参数设置 = 有线/无线 × 缩放/最高帧率）
        'cfg.secEnv': '环境设置', 'cfg.secParam': '参数设置', 'cfg.build': 'provider 构建',
        'cfg.wired': '有线', 'cfg.wireless': '无线',
        'cfg.scale': '缩放', 'cfg.fps': '最高帧率', 'cfg.scaleFull': '原画',
        'cfg.picHint': '这个 provider 未声明画面选项，下面四项可能不生效',
        'cfg.extraHint': '由 provider 提供的额外参数',
        'panel.wirelessShort': '无线 · {s}', 'panel.wiredShort': '有线 · {s}',
        'panel.initFailed': '初始化失败', 'panel.providerError': 'provider 报错',
        'panel.shotTitle': '截取当前屏幕并像粘贴图片一样添加到聊天输入框',
        'panel.settingsTitle': 'AI 截图/控制设置',
      }
      const EN = {
        'menu.title': 'scrcpy menu', 'menu.describe': 'Open the device list',
        'menu.refresh': 'Refresh', 'menu.refreshing': 'Refreshing…',
        'menu.group': '{label} devices', 'menu.envReady': 'Ready', 'menu.envPending': 'Needs setup',
        'menu.unavailable': 'Unavailable', 'menu.blocked': 'Disabled', 'menu.blockReason': 'not compatible with this core version — disabled',
        'menu.connSettings': 'Connection settings', 'menu.start': 'Start', 'menu.mirror': 'Open', 'menu.disconnect': 'Disconnect',
        'menu.connecting': 'Connecting…', 'menu.detecting': 'Detecting…', 'menu.detectingDevices': 'Detecting devices…',
        'menu.noDevices': 'No device detected.\nMake sure the device has debugging enabled and is connected (USB or wireless).',
        'menu.providerUnavailable': 'This provider is currently unavailable',
        'menu.notConfigured': 'Not configured', 'menu.runFailed': 'Failed to run',
        'menu.running': 'Running (sidecar started)', 'menu.notRunning': 'Not running',
        'menu.permHint': 'AI permissions live in each device panel’s Settings',
        'menu.noProvider.title': 'No provider (device support package) detected',
        'menu.noProvider.three': 'Three possibilities:',
        'menu.noProvider.a': '① The provider crashed — check the DSH log for the error it threw;',
        'menu.noProvider.b': '② Not installed yet — install a compatible provider from the plugin panel;',
        'menu.noProvider.c': '③ You just wanted to see what happens without it — this is the answer: the menu is here, there is no device, and the AI tools will plainly say “no focused device”.',
        'panel.tab': 'Mirror', 'panel.tabTitle': 'Mirroring · {sn}', 'panel.goneTitle': 'Disconnected · {sn}',
        'panel.notConnected': 'This device is not connected yet.', 'panel.openMenu': 'Open the scrcpy menu',
        'panel.waitFirst': 'Connected, waiting for the first frame…', 'panel.waitSwipe': 'Connected, waiting for the first frame — keep swiping the device screen to update it',
        'panel.status': 'Connected · {n} frames / {mb} MB', 'panel.noChange': 'No change for {n}s',
        'panel.stillSwipe': 'Static for {n}s · touch the device to refresh',
        'panel.closed': 'Disconnected', 'panel.wsError': 'WebSocket error', 'panel.errorPrefix': 'Error: {msg}',
        'panel.shot': 'Add screenshot to chat', 'panel.settings': 'Settings', 'panel.disconnect': 'Disconnect',
        'panel.wireless': 'Wireless (TCP): video is fixed at 1/4 quality to reduce stutter', 'panel.wired': 'Wired (USB)',
        'panel.log': 'Log', 'panel.logEmpty': '(plugin log is empty)',
        'panel.kbdOff': 'Keyboard not captured', 'panel.kbdOn': 'UHID on · keyboard captured',
        'panel.kbdNotReady': 'Keyboard not captured (UHID not ready)',
        'panel.kbdTitle': 'Click the picture to capture the keyboard; click outside to release it',
        'panel.kbdUnsupported': 'Keyboard capture is not supported on this platform',
        'key.back': 'Back', 'key.home': 'Home', 'key.volumeUp': 'Vol+', 'key.volumeDown': 'Vol−', 'key.power': 'Power',
        'settings.title': 'AI control settings', 'settings.done': 'Done',
        'settings.perm.shot': 'Allow screenshots', 'settings.perm.ctl': 'Allow reading controls & tap/long-press',
        'settings.perm.key': 'Allow keys', 'settings.perm.keyDyn': 'Allow keys ({keys})', 'settings.perm.input': 'Allow text input',
        'settings.mode.off': 'Blocked', 'settings.mode.confirm': 'Ask each time', 'settings.mode.trust': 'Always allow',
        'settings.depHint': 'Controls / tap / keys / typing all depend on “Allow screenshots”',
        'settings.model': 'Vision model', 'settings.modelLoading': 'Loading…',
        'settings.modelNone': 'No provider offers a usable model',
        'settings.notice.off': 'Blocked {label} for {sn}',
        'settings.notice.set': 'Set {label} for {sn} to {mode}',
        'settings.err.load': 'Failed to load settings: {msg}', 'settings.err.save': 'Failed to save: {msg}',
        'cfg.title': '{label} · Connection settings', 'cfg.auto': 'Auto-detect', 'cfg.cancel': 'Cancel', 'cfg.save': 'Save',
        'cfg.busy': 'Working…', 'cfg.reading': 'Loading…', 'cfg.saved': 'Saved',
        'cfg.detected': 'Auto-detected (not saved yet)', 'cfg.detectFailed': 'Detection failed: {msg}',
        'cfg.saveFailed': 'Save failed: {msg}', 'cfg.envFailed': 'Environment check failed',
        'notice.streamEnded': 'Mirroring for {sn} ended (the process is gone)', 'notice.disconnected': 'Disconnected {sn}',
        'notice.shotAdded': 'Screenshot added to the chat box (keep typing if you like, then send)',
        'notice.connectFailed': 'Connection failed: {msg}', 'notice.tabFailed': 'Failed to open the mirroring tab: {msg}',
        'notice.shotFailed': 'Failed to add the screenshot', 'notice.disconnectFailed': 'Failed to disconnect: {msg}',
        'notice.deviceInfoFailed': 'Failed to read device info: {msg}', 'notice.tabRegisterFailed': 'Failed to register the device tab: {msg}',
        'notice.sidebarUnavailable': 'Sidebar service unavailable (slots={slots}, sidebarRightTabs={tabs}, sidebarRight={side})',
        'shot.noInput': 'The chat input is unavailable', 'shot.noConversation': 'The conversation service is unavailable',
        'shot.captureFailed': 'Screenshot failed: {msg}', 'shot.addFailed': 'Failed to add the image',
        'shot.busy': 'The input box is busy; the image was not added',
        'common.unknown': 'Unknown error', 'common.unknownReason': 'Unknown reason',
        // Connection-settings sections + the four picture options (see the zh dict for the rationale)
        'cfg.secEnv': 'Environment', 'cfg.secParam': 'Parameters', 'cfg.build': 'provider build',
        'cfg.wired': 'Wired', 'cfg.wireless': 'Wireless',
        'cfg.scale': 'Scale', 'cfg.fps': 'Max frame rate', 'cfg.scaleFull': 'Native',
        'cfg.picHint': 'This provider did not declare picture options; the four below may have no effect',
        'cfg.extraHint': 'Extra parameters from the provider',
        'panel.wirelessShort': 'Wi-Fi · {s}', 'panel.wiredShort': 'USB · {s}',
        'panel.initFailed': 'Initialization failed', 'panel.providerError': 'provider error',
        'panel.shotTitle': 'Capture the current screen and add it to the chat box like a pasted image',
        'panel.settingsTitle': 'AI screenshot / control settings',
      }
      /** 占位替换：{name} 用 params 里的值；缺参数就原样留着（便于发现漏传） */
      function tmpl(s, params) {
        if (!params) return s
        return String(s).replace(/\{(\w+)\}/g, function (m, k) {
          return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
        })
      }
      let localeSvc = null
      /**
       * 读 DSH 当前语言。⚠️ 必须用 `getSnapshot().active`：
       *   `getLocale()` 返回的是**语言定义对象**（有 id/label/fallback），**没有 active 字段**。
       *   证据：dsh-client-locale/lib/client.js:1119 getSnapshot() / :1111 getLocale()，快照字段见 :1314。
       */
      function readActiveLocale() {
        try { const s = localeSvc && localeSvc.getSnapshot ? localeSvc.getSnapshot() : null; if (s && s.active) return String(s.active) } catch (e) {}
        try { const d = localeSvc && localeSvc.getLocale ? localeSvc.getLocale() : null; if (d && d.id) return String(d.id) } catch (e) {}
        return null
      }
      /**
       * 取文案：**自己挑字典**，不用 locale 服务的 register/bind。
       * 为什么（2026-09-26 实测）：
       *   ① 热重载后 register 会报 `locale namespace "dsh-scrcpy" already has locale "zh"`；
       *   ② 为躲它而"跳过注册"更糟 —— T 永远查**旧字典**，新加的键全部显示成 key 本身（比如 cfg.secEnv）；
       *   ③ 旧实例的 disposer 拿不回来，命名空间根本清不掉。
       * 我们只需要知道"现在是哪种语言"，字典就在手边 —— 每次调用现读，没有陈旧状态。
       */
      function T(key, params) {
        const dict = (readActiveLocale() === 'en') ? EN : ZH
        const s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key]
          : (Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key)
        return tmpl(s, params)
      }
      /** 语言切换后要重渲染：组件里调一次这个 hook 即可（拿不到 subscribe 就退化成不响应） */
      function useLocaleRev() {
        const [rev, setRev] = React.useState(0)
        React.useEffect(function () {
          if (!localeSvc || typeof localeSvc.subscribe !== 'function') return undefined
          let dispose = null
          try { dispose = localeSvc.subscribe(function () { setRev(function (n) { return n + 1 }) }) } catch (e) {}
          return function () { try { if (typeof dispose === 'function') dispose() } catch (e) {} }
        }, [])
        return rev
      }
      /**
       * 工厂作用域里的告警。⚠️ 别在这里用组件内的 `logDiag`（它定义在 ControlPanel 里、这里拿不到）：
       * 2026-09-26 我这么写过一次 —— ReferenceError 直接穿出 apply，**整个客户端半区没注册、菜单都消失**。
       * 教训：在 apply 路径上调用的函数，必须是工厂作用域里存在的（组件内的东西拿不到）。
       */
      function warnPlugin(msg) {
        try { console.warn('[dsh-scrcpy-core] ' + String(msg)) } catch (e) {}
      }
      /** 接上 DSH 的 locale 服务（由 apply(ctx) 调用一次） */
      function bindLocale(ctx) {
        try {
          const svc = ctx.get('locale')
          if (!svc || (typeof svc.getSnapshot !== 'function' && typeof svc.getLocale !== 'function')) {
            warnPlugin('locale 服务不可用（没有 getSnapshot/getLocale），界面用中文')
            return
          }
          localeSvc = svc
          /** 把当前语言告诉宿主：DSH 的 locale 是**客户端**服务，宿主读不到 —— 它靠这条 RPC 才知道说中文还是英文 */
          let tries = 0
          function pushLocale() {
            const active = readActiveLocale()
            if (!active) { warnPlugin('读不到活动语言（getSnapshot/getLocale 都没给），这次不推给宿主'); return }
            const settle = function (r) {
              if (r && r.ok && r.locale === active) return            // 宿主已确认
              if (++tries > 6) return
              setTimeout(pushLocale, 600 * tries)                     // 宿主半区可能还没起来 → 退避重试
            }
            try { rpc('locale:set', { locale: active }).then(settle).catch(function () { settle(null) }) } catch (e) {}
          }
          pushLocale()
          try { if (typeof svc.subscribe === 'function') svc.subscribe(function () { pushLocale() }) } catch (e) {}
        } catch (e) {
          warnPlugin('locale 服务接不上，退回中文：' + String((e && e.message) || e))
        }
      }

      /**
       * provider 给的文案可能是字符串，也可能是 {zh,en} —— 宿主通常已经挑好了，但**不能依赖这一点**。
       * 这里再兜一次：**绝不能把对象当 React 子节点**，那会抛 "Objects are not valid as a React child"，
       * 未捕获的渲染错误会把**整棵 UI 树**卸掉（2026-09-27 实测：一点"启动"，画面连菜单按钮一起消失）。
       */
      function capText(v) {
        if (v == null) return ''
        if (typeof v === 'string') return v
        if (typeof v === 'object') {
          const loc = readActiveLocale() || 'zh'
          if (v[loc] || v.zh || v.en) return String(v[loc] || v.zh || v.en)
          // 既不是字符串、也不是 {zh,en}：把内容**显示出来**（别静默变空串 —— 那样等于把 bug 藏起来）
          try { return JSON.stringify(v) } catch (e) { return '[object]' }
        }
        return String(v)
      }
      /**
       * 量一批文案在按钮里的最大宽度：用一个离屏元素挂上**真的 class**，字体/padding/边框都是实的 —— 不猜字体。
       * 只用来给整排按钮定统一最小宽度；量不到就返回 0（退回 CSS 的自然宽度）。按 class+文案缓存。
       */
      const measureCache = {}
      function maxLabelWidth(cls, labels) {
        const ck = cls + '|' + labels.join('\u0001')
        if (measureCache[ck] !== undefined) return measureCache[ck]
        let w = 0
        try {
          const el = document.createElement('span')
          el.className = cls
          el.style.position = 'absolute'; el.style.left = '-9999px'; el.style.top = '0'
          el.style.visibility = 'hidden'; el.style.whiteSpace = 'nowrap'; el.style.display = 'inline-block'
          document.body.appendChild(el)
          for (const t of labels) { el.textContent = String(t); w = Math.max(w, el.getBoundingClientRect().width) }
          document.body.removeChild(el)
        } catch (e) { w = 0 }
        measureCache[ck] = w
        return w
      }
      /** 某 provider 允许 AI 用的键拼成一串（它的 keyLabels 已被 core 挑成当前语言的字符串） */
      function aiKeyList(caps) {
        const c = caps || {}
        const keys = Array.isArray(c.aiKeys) ? c.aiKeys : (Array.isArray(c.keys) ? c.keys : [])
        const labels = c.keyLabels || {}
        return keys.map(function (k) { return capText(labels[k]) || String(k) }).join(' / ')
      }
      /** 按键那一项的标题：**按 provider 的声明现算**（【用户口述 2026-09-27】）；没有就退回不带括号的 */
      function keyPermLabel(caps) {
        const list = aiKeyList(caps)
        return list ? T('settings.perm.keyDyn', { keys: list }) : T('settings.perm.key')
      }
      // ⚠️ 这些**必须在渲染/调用时求值**，不能在模块加载时快照 —— 否则 DSH 换语言后还留着旧语言
      function permRows(caps) {
        return [
          { key: 'shot', label: T('settings.perm.shot'), rpcKey: 'shotMode' },
          { key: 'ctl', label: T('settings.perm.ctl'), rpcKey: 'ctlMode' },
          { key: 'key', label: keyPermLabel(caps), rpcKey: 'keyMode' },
          { key: 'input', label: T('settings.perm.input'), rpcKey: 'inputMode' },
        ]
      }
      /** 三态显示名（先前我漏定义了它 —— 改权限时那句 notice 会直接 ReferenceError） */
      function modeLabel(mode) {
        if (mode === 'off') return T('settings.mode.off')
        if (mode === 'confirm') return T('settings.mode.confirm')
        if (mode === 'trust') return T('settings.mode.trust')
        return String(mode)
      }

      /** 设置某个权限模式（RPC + 共享 store 同步）；shot 关掉时连带清掉另外三个 */
      async function setMode(perm, sn, mode) {
        // 从会话里取这台设备的 provider 能力，好让"允许按键（…）"这行标题跟声明一致
        const sessRow = (sessionStore.get().sessions || {})[sn]
        const rows = permRows(sessRow && sessRow.caps)
        try {
          const r = await rpc('mode:set', { perm: perm, sn: sn, mode: mode })
          if (!r || !r.ok) return { error: T('settings.err.save', { msg: (r && r.error) || T('common.unknown') }) }
          const patch = {}
          patch[(rows.find(function (p) { return p.key === perm }) || {}).rpcKey] = (r.modes && r.modes[perm]) || {}
          if (perm === 'shot') {
            patch.ctlMode = (r.modes && r.modes.ctl) || {}
            patch.keyMode = (r.modes && r.modes.key) || {}
            patch.inputMode = (r.modes && r.modes.input) || {}
          }
          sessionStore.set(patch)
          const label = (rows.find(function (p) { return p.key === perm }) || {}).label || perm
          return { notice: mode === 'off' ? T('settings.notice.off', { sn: sn, label: label }) : T('settings.notice.set', { sn: sn, label: label, mode: modeLabel(mode) }) }
        } catch (err) { return { error: T('settings.err.save', { msg: String((err && err.message) || err) }) } }
      }

      // ------------------------------------------------------------
      // 投屏面板（每台设备一个）
      //   placement：
      //     floating — 侧栏服务不可用时的降级浮层（贴右边缘并给聊天区让位）
      //     overlay  — 贴到右侧栏标签页上报的矩形上
      //     hidden   — 标签页不在最前 / 侧栏收起：留在 DOM 里继续收流解码，只是不显示
      //   面板常驻在 header 组件里：切标签页/收侧栏都不会卸载它，所以 WS 与解码器活着，
      //   切回来是接着放的画面（整条流只有一个关键帧，重开解码器必黑屏 —— 见 Dev/doc.md §2.4-16）
      // ------------------------------------------------------------
      function ControlPanel(props) {
        const sn = props.sn
        const port = props.port
        const onClose = props.onClose
        const onModeChange = props.onModeChange
        const onAddShotToChat = props.onAddShotToChat
        const shotMode = props.shotMode
        const ctlMode = props.ctlMode
        const keyMode = props.keyMode
        const inputMode = props.inputMode
        const caps = props.caps || {}
        const placement = props.placement || 'floating'
        const rect = props.rect || null

        const videoRef = React.useRef(null)
        const screenRef = React.useRef(null)
        const headRef = React.useRef(null)
        const statusRef = React.useRef(null)
        const keysRef = React.useRef(null)
        const logRef = React.useRef(null)
        const [status, setStatus] = React.useState('connecting')
        // 提示文案按 provider 能力走（2026-09-25 用户指出）：
        //   鸿蒙 SDK 只在画面变化时推帧，所以"没帧"时提示用户滑一下手机才有用；
        //   安卓不需要这个提示 —— 没帧就只是画面没变化。
        const HINT_SWIPE = caps.hintSwipe === true
        const WAIT_TEXT = HINT_SWIPE ? T('panel.waitSwipe') : T('panel.waitFirst')
        // 状态行【不再整行替换】：帧计数永远是底，未出画面 / 画面无变化只是后面的附注。
        // 原因：安卓 scrcpy 是"变化驱动"（画面不动就不推帧），若把计数整行换成"等待画面"，
        //      静止时就再也看不到 x 帧 / x MB 了（2026-09-25 用户实测指出）。
        const [note, setNote] = React.useState(WAIT_TEXT)
        const [frames, setFrames] = React.useState(0)
        const [bytes, setBytes] = React.useState(0)
        const [error, setError] = React.useState('')
        const [diag, setDiag] = React.useState([])
        const [logOpen, setLogOpen] = React.useState(false)
        const [kbdOn, setKbdOn] = React.useState(false)   // 画面是否已接管 PC 键盘
        const [hidReady, setHidReady] = React.useState(null)  // provider 报的 UHID 状态：true/false/null(未知)
        const [hidConfirmed, setHidConfirmed] = React.useState(false)  // 设备侧回 UHID 输出 = 键盘确实挂上了
        const [logLines, setLogLines] = React.useState([])
        const [panelW, setPanelW] = React.useState(360)
        const [settingsOpen, setSettingsOpen] = React.useState(false)
        const [preview, setPreview] = React.useState(null)
        const [modelInfo, setModelInfo] = React.useState(null)
        const wsRef = React.useRef(null)
        const jmuxerRef = React.useRef(null)
        const deviceSizeRef = React.useRef(null)
        // provider 报来的"原始"坐标空间值（鸿蒙=设备尺寸、安卓=帧尺寸）。
        //   deviceSizeRef 是**按当前画面方向纠正过**的值，触控用它；这个存原值，供每跳重新推导。
        const reportedSizeRef = React.useRef(null)
        // 当前 jmuxer 轨道认的**编码尺寸**（由流里的 SPS 决定，不用 videoWidth —— 后者会被 jmuxer 算歪）
        const trackDimsRef = React.useRef('')
        // 【2026-09-29 实测】重建是**异步**的（要新起 MediaSource / 换 <video> 的 src）：重建后"紧接着喂"的那一帧会丢，
        //   而那一帧往往正是唯一一份"配置 + 关键帧" → 新 jmuxer 永远建不出轨道 → 一直黑（demo 与插件都能稳定复现：
        //   补发里明明有 SPS/PPS/IDR，重建后却 `video 尺寸 → 0x0`；下一次配置+关键帧来了碰巧就绪才活）。
        //   所以重建后先把帧攒进这里，延迟一小下（等 MediaSource 就绪）再按顺序一起喂。
        const pendingFramesRef = React.useRef(null)
        const flushTimerRef = React.useRef(null)
        function flushPendingFrames() {
          const q = pendingFramesRef.current
          pendingFramesRef.current = null
          if (!q || !q.length) return
          logDiag('补喂重建期间攒下的 ' + q.length + ' 帧')
          logDiagLong('补喂重建期间攒下的 ' + q.length + ' 帧')
          for (let i = 0; i < q.length; i++) {
            try { jmuxerRef.current.feed({ video: q[i] }) } catch (e) { logDiag('补喂错误: ' + String((e && e.message) || e)) }
          }
        }
        // 从一帧 Annex-B 数据里解出 SPS 的编码尺寸（"1280x720"）；没有 SPS 或解不出就返回 null。
        // 【2026-09-29 实测依据】见 hos/Dev/demo/browser-demo.mjs：靠 videoWidth 发现尺寸变化太晚，
        //   而"看到 SPS 就先换 jmuxer 再喂"能立刻跟过去。
        function spsDimsOf(u8) {
          try {
            let spsStart = -1, spsEnd = -1
            for (let i = 0; i + 3 < u8.length; i++) {
              let nalAt = -1
              if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) nalAt = i + 3
              else if (i + 4 < u8.length && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1) nalAt = i + 4
              if (nalAt < 0 || nalAt >= u8.length) continue
              if ((u8[nalAt] & 0x1f) === 7) { spsStart = nalAt; spsEnd = u8.length }
              else if (spsStart >= 0) { spsEnd = i; break }
            }
            if (spsStart < 0) return null
            // 去掉防竞争字节 0x000003，再按 exp-Golomb 读
            const raw = []
            for (let i = spsStart + 1; i < spsEnd; i++) {
              if (i + 2 < spsEnd && u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 3) { raw.push(0, 0); i += 2 }
              else raw.push(u8[i])
            }
            const b = Uint8Array.from(raw)
            let pos = 0
            const u = (n) => { let v = 0; for (let i = 0; i < n; i++) { const bit = (b[pos >> 3] >> (7 - (pos & 7))) & 1; v = (v << 1) | bit; pos++ } return v }
            const ue = () => { let z = 0; while (pos < b.length * 8 && u(1) === 0) z++; return z === 0 ? 0 : (1 << z) - 1 + u(z) }
            const se = () => { const k = ue(); return (k & 1) ? (k + 1) >> 1 : -(k >> 1) }
            const profile = u(8); u(8); u(8)
            ue()   // sps id
            const hi = { 100: 1, 110: 1, 122: 1, 244: 1, 44: 1, 83: 1, 86: 1, 118: 1, 128: 1, 138: 1, 139: 1, 134: 1, 135: 1 }
            let cf = 1
            if (hi[profile]) {
              cf = ue(); if (cf === 3) u(1); ue(); ue(); u(1)
              if (u(1)) { const n = cf !== 3 ? 8 : 12; for (let i = 0; i < n; i++) { if (u(1)) { const size = i < 6 ? 16 : 64; let last = 8, next = 8; for (let j = 0; j < size; j++) { if (next !== 0) next = (last + se() + 256) % 256; last = next === 0 ? last : next } } } }
            }
            ue()   // log2_max_frame_num_minus4
            const poc = ue()
            if (poc === 0) ue()
            else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se() }
            ue(); u(1)   // max_num_ref_frames, gaps
            const wMbs = ue() + 1, hMap = ue() + 1, fmo = u(1)
            if (!fmo) u(1)
            u(1)         // direct_8x8
            let cl = 0, cr = 0, ct = 0, cb = 0
            if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue() }
            const subW = cf === 3 ? 1 : 2, subH = cf === 1 ? 2 : 1
            return ((wMbs * 16 - (cl + cr) * subW) + 'x' + ((2 - fmo) * hMap * 16 - (ct + cb) * subH))
          } catch (e) { return null }
        }
        // 只用来**检测尺寸变化**（分辨率/方向变了）；它不是触控坐标空间
        const videoSizeRef = React.useRef(null)
        const lastFrameRef = React.useRef(0)
        // jmuxer 卡住**观察**用的状态（判据只看"视频时间有没有在走"，见下方 500ms 心跳；本轮不做自愈）
        const stallRef = React.useRef({ t: null, at: 0, diagAt: 0 })
        const draggingRef = React.useRef(false)
        const logOpenRef = React.useRef(false)
        // 注：这里原来有个 lastStatusTextRef 做"文案去重"，但它的初值（''）跟状态初值（WAIT_TEXT）不一致，
        // 导致「有帧了但还没静止」这一次变化被吞掉 —— 文字永远停在"等待画面"（2026-09-25 实测定位）。
        // React 对相同的 setState 值本来就会跳过重渲染，所以去重是多余的，直接去掉。
        // 帧计数只改 ref，500ms 才发布进 state（每帧 setState 会让 React 每秒重建上百棵 fiber 树）
        const framesRef = React.useRef(0)
        const bytesRef = React.useRef(0)
        const shownFramesRef = React.useRef(0)
        const shownBytesRef = React.useRef(0)
        const playingRef = React.useRef(false)

        // 【用户口述 2026-09-29】日志必须带时间戳 —— 否则只能靠猜顺序，两边的日志也没法并排对。
        //   格式与 sidecar 的 `2026.09.29/12:11:28.195/INFO` 对齐，方便把插件日志和 sidecar 日志并排看。
        function logTs() {
          const d = new Date()
          const p = function (n, w) { return String(n).padStart(w || 2, '0') }
          return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + '/'
            + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3)
        }
        function logDiag(msg) { setDiag(function (prev) { return prev.concat(logTs() + ' ' + String(msg)).slice(-15) }) }
        // 需要**活着留证据**的诊断走这条：写进那份 500 行的日志（diag 只有 15 行，卡住诊断很容易被后续诊断挤掉，
        // 而用户通常是事后才打开日志面板 —— 【2026-09-28】为此加）
        function logDiagLong(msg) { setLogLines(function (prev) { return prev.concat(logTs() + ' ' + String(msg)).slice(-500) }) }

        function loadModelInfo() {
          rpc('model:list', {}).then(function (r) { setModelInfo(r || null) }).catch(function () { setModelInfo(null) })
        }
        function changeModel(value) {
          // 下拉里一个选项 = 一对「提供方 + 模型」，用 \u0000 拼在一起传
          const parts = String(value || '').split('\u0000')
          rpc('model:set', { provider: parts[0] || '', model: parts[1] || '' }).then(function () { loadModelInfo() }).catch(function () {})
        }

        function computeWidth() {
          const d = deviceSizeRef.current
          const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
          const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
          const headH = headRef.current ? headRef.current.offsetHeight : 34
          const statusH = statusRef.current ? statusRef.current.offsetHeight : 30
          const keysH = keysRef.current ? keysRef.current.offsetHeight : 54
          const screenH = vh - headH - statusH - keysH
          if (!d || screenH <= 100) return Math.min(360, Math.max(260, Math.round(vw * 0.3)))
          let w = Math.round(screenH * (d.w / d.h))
          w = Math.max(260, Math.min(w, 640))
          return Math.min(w, Math.round(vw * 0.55))
        }
        function applyWidth() {
          if (placement !== 'floating') return
          const w = computeWidth()
          setPanelW(w)
          try { document.documentElement.style.setProperty('--' + CSS_PREFIX + '-panel-w', w + 'px') } catch (e) {}
        }

        function sendCmd(obj) {
          const ws = wsRef.current
          if (!ws || ws.readyState !== 1) return
          try { ws.send(JSON.stringify(obj)) } catch (e) {}
        }
        // ── PC 键盘直输 ──────────────────────────────────────────────
        // 鼠标点一下画面 → 我们的键盘变成设备的**外接键盘**（provider 侧发的是真 UHID HID 报告），
        // 所以设备输入法会按"物理键盘"处理 —— 拼音候选词能出来（这是 INJECT_TEXT 做不到的）。
        // event.code → USB HID usage（Keyboard/Keypad page 0x07，与 scrcpy 客户端同一张表思路）
        const HID_USAGE = {
          KeyA: 4, KeyB: 5, KeyC: 6, KeyD: 7, KeyE: 8, KeyF: 9, KeyG: 10, KeyH: 11,
          KeyI: 12, KeyJ: 13, KeyK: 14, KeyL: 15, KeyM: 16, KeyN: 17, KeyO: 18, KeyP: 19,
          KeyQ: 20, KeyR: 21, KeyS: 22, KeyT: 23, KeyU: 24, KeyV: 25, KeyW: 26, KeyX: 27,
          KeyY: 28, KeyZ: 29,
          Digit1: 30, Digit2: 31, Digit3: 32, Digit4: 33, Digit5: 34, Digit6: 35, Digit7: 36,
          Digit8: 37, Digit9: 38, Digit0: 39,
          Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
          Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
          Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
          CapsLock: 57,
          F1: 58, F2: 59, F3: 60, F4: 61, F5: 62, F6: 63, F7: 64, F8: 65, F9: 66, F10: 67,
          F11: 68, F12: 69,
          Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
          ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
        }
        // 修饰键不占"按下的键"槽位，只改报告第 0 字节（跟 scrcpy 一致）
        const HID_MODIFIER_CODES = { ControlLeft: 1, ControlRight: 1, ShiftLeft: 1, ShiftRight: 1, AltLeft: 1, AltRight: 1, MetaLeft: 1, MetaRight: 1 }
        // 这几个留给宿主（不然在面板里连页面都刷不了）
        const HID_PASSTHROUGH = { F5: 1, F11: 1, F12: 1 }
        function hidModsOf(e) {
          let m = 0
          try {
            if (e.getModifierState('Control')) m |= 0x01
            if (e.getModifierState('Shift')) m |= 0x02
            if (e.getModifierState('Alt')) m |= 0x04
            if (e.getModifierState('Meta')) m |= 0x08
          } catch (err) {}
          return m
        }
        function hidHandles(e) { return HID_MODIFIER_CODES[e.code] === 1 || !!HID_USAGE[e.code] }
        function sendHidKey(e, down) {
          // 【用户实测 2026-09-29】不支持键盘接管的平台（caps.keyboard === false，如鸿蒙）**一个键都不能发**：
          //   鸿蒙 sidecar 的协议里没有 `hid` 类型 → 按一下 Shift 就回 "错误: unknown type: hid"。
          //   之前 caps.keyboard 只用来显示提示文字，没拦住发送，所以漏了。
          if (caps && caps.keyboard === false) return false
          const isMod = HID_MODIFIER_CODES[e.code] === 1
          if (!isMod && !HID_USAGE[e.code]) return false
          if (HID_PASSTHROUGH[e.code] && (e.ctrlKey || e.metaKey || e.code === 'F5' || e.code === 'F11' || e.code === 'F12')) return false
          sendCmd({ type: 'hid', usage: isMod ? 0 : HID_USAGE[e.code], mods: hidModsOf(e), down: down === true })
          return true
        }
        function onHidKeyDown(e) {
          // 重复键交给设备侧（HID 规范：repeat 由 host 处理）
          if (e.repeat) { if (hidHandles(e)) e.preventDefault(); return }
          if (sendHidKey(e, true)) e.preventDefault()
        }
        function onHidKeyUp(e) { if (sendHidKey(e, false)) e.preventDefault() }
        function toggleLog() {
          const next = !logOpen
          setLogOpen(next)
          logOpenRef.current = next
          // 【用户口述 2026-09-27】不做设备日志流：这个面板只放**插件日志**（本地诊断 + provider 推的诊断行）。
          //   以前这里无条件发 {type:'log'} 让 provider 开设备日志 —— 安卓当 no-op，鸿蒙的 sidecar 却会真的
          //   去 `hdc shell hilog` 往面板刷设备日志（实测：一开日志面板满屏 hilog）。
          //   现在只在 provider **声明支持**（capabilities.log === true）时才发这条命令。
          if (caps && caps.log === true) sendCmd({ type: 'log', on: next })
        }

        React.useEffect(function () {
          let disposed = false
          let timerDispose = null
          let gestureDispose = null
          function onResize() { applyWidth() }
          applyWidth()
          try { window.addEventListener('resize', onResize) } catch (e) {}

          async function init() {
            try {
              logDiag('init: 加载 jmuxer…')
              let JMuxerCtor = (typeof JMuxer !== 'undefined') ? JMuxer : (window && window.JMuxer)
              if (!JMuxerCtor) {
                // 静态包不能直接 import 浏览器库：由 core 的 host 半区把源码经 RPC 发过来再 eval
                const src = await rpc('jmuxer:source', {})
                if (src && src.ok && src.source) {
                  try { (0, eval)(src.source) } catch (evErr) { logDiag('eval 失败: ' + String((evErr && evErr.message) || evErr)) }
                  JMuxerCtor = (typeof JMuxer !== 'undefined') ? JMuxer : (window && window.JMuxer)
                }
              }
              if (!JMuxerCtor) throw new Error('JMuxer 加载失败')
              if (disposed) return
              // fps 必须跟实际编码帧率一致：写死 60 而实际 30/15 时，jmuxer 给每帧算的时长会偏短
              const encFps = (props && props.frameRate) > 0 ? props.frameRate : 60
              // 重建解码器：分辨率/方向变了必须换一个新的 jmuxer 实例 —— 否则旧的 avcC 去解新分辨率的帧，
              // 表现就是画面被拉伸/花掉（demo 里的"旋转修复"就是这个，core 这版一开始漏了；2026-09-26 用户实测指出）
              function resetMuxer(reason) {
                // 【用户口述 2026-09-28】重建这件事要留够排查线索：原因 + 重建前的旧状态（元素时间轴/缓冲）
                //   + 当时的帧尺寸/已收帧数/fps。以前只有一行"jmuxer 重建（原因）"，出事看不出上下文。
                let before = ''
                try {
                  const v = videoRef.current
                  if (v) {
                    let ranges = '[]'
                    try {
                      const b = v.buffered, rs = []
                      for (let i = 0; i < b.length; i++) rs.push(b.start(i).toFixed(2) + '-' + b.end(i).toFixed(2))
                      ranges = '[' + rs.join(', ') + ']'
                    } catch (e2) {}
                    before = ' 重建前 readyState=' + v.readyState + ' paused=' + v.paused
                      + ' currentTime=' + (Number(v.currentTime) || 0).toFixed(2) + ' buffered=' + ranges
                  }
                } catch (e2) {}
                logDiagLong('jmuxer 重建开始（' + reason + '）视频尺寸=' + ((videoRef.current && videoRef.current.videoWidth) || 0)
                  + 'x' + ((videoRef.current && videoRef.current.videoHeight) || 0)
                  + ' 坐标空间=' + (deviceSizeRef.current ? deviceSizeRef.current.w + 'x' + deviceSizeRef.current.h : '?')
                  + ' 已收帧=' + framesRef.current + ' fps=' + encFps + before)
                try { if (jmuxerRef.current) jmuxerRef.current.reset() } catch (e) {}
                try { if (jmuxerRef.current) jmuxerRef.current.destroy() } catch (e) {}
                jmuxerRef.current = null
                try {
                  jmuxerRef.current = new JMuxerCtor({ node: videoRef.current, mode: 'video', flushingTime: 0, fps: encFps, onError: function (err) {
                    // 以前这里静默 reset：真出问题时日志里什么都没有。现在把错误原文留下。
                    const msg = String((err && (err.message || err)) || err)
                    logDiag('jmuxer onError: ' + msg)
                    logDiagLong('jmuxer onError: ' + msg)
                    try { jmuxerRef.current.reset() } catch (e3) {}
                  } })
                  logDiag('jmuxer 重建（' + reason + '）')
                  logDiagLong('jmuxer 重建完成（' + reason + '）fps=' + encFps + ' flushingTime=0')
                } catch (e) {
                  logDiag('重建解码器失败: ' + String((e && e.message) || e))
                  logDiagLong('重建解码器失败: ' + String((e && e.message) || e))
                }
              }
              resetMuxer('初始化')

              logDiag('WS 连接 ws://127.0.0.1:' + port + '/（device:connect 给的端口）')
              const ws = new WebSocket('ws://127.0.0.1:' + port + '/')
              ws.binaryType = 'arraybuffer'
              wsRef.current = ws
              ws.onopen = function () {
                if (disposed) return
                logDiag('WS onopen')
                ws.send(JSON.stringify({ type: 'size' }))
                ws.send(JSON.stringify({ type: 'screen', mode: 'video' }))
              }
              ws.onmessage = function (ev) {
                if (disposed) return
                if (typeof ev.data === 'string') {
                  try {
                    const o = JSON.parse(ev.data)
                    if (o.msg === 'size' && o.data) {
                      const parts = String(o.data).split('x')
                      if (parts.length === 2) {
                        const w = parseInt(parts[0], 10), h = parseInt(parts[1], 10)
                        // 【用户口述 2026-09-28】报来的是"provider 的 input 期望的坐标空间"（鸿蒙=设备尺寸、安卓=帧尺寸）。
                        //   存进 reportedSizeRef（原值），由 500ms 心跳按"当前画面方向"决定要不要对调后写进 deviceSizeRef ——
                        //   因为转屏后 sidecar 不会重发这个值，存的原值可能是旧方向的。
                        const prev = reportedSizeRef.current
                        const changed = !!(prev && (prev.w !== w || prev.h !== h))
                        reportedSizeRef.current = { w: w, h: h }
                        if (changed) logDiag('provider 报的坐标空间 ' + prev.w + 'x' + prev.h + ' → ' + w + 'x' + h)
                        // 【用户要求 2026-09-29】这里**只管坐标空间**，不碰解码器：
                        //   重建统一由"喂之前扫 SPS"负责（平台无关）—— 两端走同一条路，core 里不再有平台分支。
                        applyWidth()
                      }
                    } else if (o.msg === 'log' && o.data) {
                      setLogLines(function (prev) { return prev.concat(String(o.data)).slice(-500) })
                    } else if (o.msg === 'hid') {
                      // provider 汇报 UHID 虚拟键盘建没建成 —— 让"打字没反应"变成屏幕上的一句话
                      setHidReady(o.ok === true)
                      setHidConfirmed(o.confirmed === true)
                    } else if (o.ok === false) {
                      // provider 报的错要**看得见**（以前只进 diag，等于没有）
                      logDiag('sidecar: ' + (o.error || o.msg || ev.data))
                      setError(String(o.error || o.msg || T('panel.providerError')))
                    } else {
                      logDiag('WS text: ' + ev.data)
                    }
                  } catch (e) { logDiag('WS text: ' + ev.data) }
                } else if (ev.data instanceof ArrayBuffer) {
                  lastFrameRef.current = Date.now()
                  framesRef.current += 1
                  bytesRef.current += ev.data.byteLength
                  if (!playingRef.current) { playingRef.current = true; setStatus('playing') }
                  // ⚠️ 不要给 feed() 传 duration！【2026-09-28 实测血亏】jmuxer 内部会把一次调用的时长
                  //   按 NAL 个数**整除**（`t/a.length|0`），而变化驱动的流是成串到达的（帧间隔常是 1ms），
                  //   1/2|0 = 0 → 它判定"非法时长"直接丢样本 → 两个平台全黑（buffered=[] readyState=0 paused=true）。
                  //   时间轴漂移改用下面的"播放头拨回"来治，别去动 jmuxer 的计时。
                  const _u8 = new Uint8Array(ev.data)
                  // 【2026-09-29 实测】喂之前先看这一帧里的 SPS：编码尺寸与当前轨道不同 → **先换 jmuxer 再喂**。
                  //   靠 videoWidth 判断太晚（jmuxer 会拿旧轨道比例算出 2160x1440 这种假值），SPS 才是真值。
                  const _dims = spsDimsOf(_u8)
                  if (_dims && _dims !== trackDimsRef.current) {
                    const _prev = trackDimsRef.current
                    trackDimsRef.current = _dims
                    resetMuxer('SPS 换分辨率 ' + (_prev || '空') + ' → ' + _dims)
                    // 重建是异步的：这一帧（通常就是唯一那份"配置+关键帧"）立刻喂会丢 → 攒起来，等 300ms 后一起喂
                    pendingFramesRef.current = [_u8]
                    try { clearTimeout(flushTimerRef.current) } catch (e3) {}
                    flushTimerRef.current = setTimeout(flushPendingFrames, 300)
                    try { ws.send(JSON.stringify({ type: 'size' })) } catch (e2) {}
                    return
                  }
                  if (pendingFramesRef.current) { pendingFramesRef.current.push(_u8); return }   // 还在等补喂，先攒着
                  try { jmuxerRef.current.feed({ video: _u8 }) } catch (e) { logDiag('jmuxer.feed 错误: ' + String((e && e.message) || e)) }
                }
              }
              ws.onclose = function (e) { if (!disposed) { playingRef.current = false; logDiag('WS onclose code=' + e.code + ' reason=' + (e.reason || '') + ' port=' + port); setStatus('closed'); setNote(T('panel.closed')) } }
              ws.onerror = function () { if (!disposed) { playingRef.current = false; logDiag('WS onerror'); setStatus('error'); setNote(T('panel.wsError')) } }

              // 500ms 一跳：状态文案 + 帧/字节计数发布 + MSE 缓冲护栏
              timerDispose = interval(function () {
                if (disposed) return
                let next = ''
                if (lastFrameRef.current === 0) next = WAIT_TEXT
                else {
                  const idle = Math.round((Date.now() - lastFrameRef.current) / 1000)
                  if (idle >= 5) next = HINT_SWIPE ? T('panel.stillSwipe', { n: idle }) : T('panel.noChange', { n: idle })
                }
                setNote(next)
                if (framesRef.current !== shownFramesRef.current) { shownFramesRef.current = framesRef.current; setFrames(framesRef.current) }
                if (bytesRef.current !== shownBytesRef.current) { shownBytesRef.current = bytesRef.current; setBytes(bytesRef.current) }
                try {
                  const v = videoRef.current
                  if (v && v.buffered && v.buffered.length > 0) {
                    const end = v.buffered.end(v.buffered.length - 1)
                    const lag = end - v.currentTime
                    if (lag > 2.5) { v.currentTime = Math.max(0, end - 0.15); logDiag('MSE 缓冲深度 ' + lag.toFixed(1) + 's，已跳到直播边缘') }
                    // 【用户实测 2026-09-28 的诊断行实证】播放头**越过**缓冲末端：
                    //   readyState=2 paused=false ended=false currentTime=56.49 buffered=[9.73-55.63]
                    //   （缓冲只有一段且在持续增长、帧持续到达 → 不是空洞、不是 ended）
                    //   成因：jmuxer 按固定 fps 算每帧时长，而变化驱动的流帧数远少于 fps →
                    //   媒体时间轴比真实时间走得慢 → 播放头跑到缓冲前面断粮。
                    //   这里**只把播放头拨回有数据的地方**（不是重建解码器），元素立刻恢复播放。
                    else if (v.currentTime > end + 0.05) {
                      const ahead = v.currentTime - end
                      v.currentTime = Math.max(v.buffered.start(0), end - 0.1)
                      logDiag('播放头越过缓冲末端 ' + ahead.toFixed(2) + 's，已拨回 ' + v.currentTime.toFixed(2))
                    }
                  }
                } catch (e) {}
                // 【用户口述 2026-09-28】鸿蒙旋转：sidecar 不下发尺寸变化，靠解码尺寸**只判断长宽比是否翻转**。
                //   ⚠️ 绝不能拿 videoWidth 去改 deviceSizeRef（触控坐标空间）：
                //     {msg:'size'} 给的是**设备尺寸**（如 2880x1920），1/2 缩放时 videoWidth 是**编码帧尺寸**（1440x960），
                //     两者本来就不相等 → 会被误判成"旋转/尺寸变化" → 多重建一次解码器 → 等不到关键帧 → **全黑**
                //     （2026-09-28 实测就是这么黑的：屏幕一直横屏、缩放一直是 1/2）
                try {
                  const vv = videoRef.current
                  const vw = vv ? Number(vv.videoWidth) || 0 : 0
                  const vh = vv ? Number(vv.videoHeight) || 0 : 0
                  if (vw > 0 && vh > 0) {
                    // 【用户要求 2026-09-29】坐标空间**原样用 provider 报的值**，core 不做方向纠正
                    //   （平台差异一律回 provider / 靠声明，core 里不许有 inputSpace 这种分支）。
                    const rep = reportedSizeRef.current
                    if (rep) deviceSizeRef.current = { w: rep.w, h: rep.h }
                    const pv = videoSizeRef.current
                    if (!pv) { videoSizeRef.current = { w: vw, h: vh }; applyWidth() }
                    else if (pv.w !== vw || pv.h !== vh) {
                      videoSizeRef.current = { w: vw, h: vh }
                      logDiag('画面尺寸变化 ' + pv.w + 'x' + pv.h + ' → ' + vw + 'x' + vh)
                      logDiagLong('画面尺寸变化 ' + pv.w + 'x' + pv.h + ' → ' + vw + 'x' + vh
                        + '（坐标空间现为 ' + (deviceSizeRef.current ? deviceSizeRef.current.w + 'x' + deviceSizeRef.current.h : '?') + '）')
                      // 【用户要求 2026-09-29】这里**不再重建**（原来按 caps.rebuildOnResize 分平台走两条路）：
                      //   靠 videoWidth 发现变化太晚，而且会造成平台分支。
                      //   重建统一由"喂之前扫 SPS → 异步安全地先换 jmuxer 再喂"负责（那条已实测）。
                      applyWidth()
                    }
                  }
                } catch (e) {}
                // jmuxer 卡住：这里**只观察、不干预**（【用户口述 2026-09-28】"遇到问题就重建 jmuxer，我怎么复现"）。
                //   卡住期间每 2 秒把 video 的真实状态写进日志；根因等诊断行拿到再改。
                try {
                  const v = videoRef.current
                  if (v && framesRef.current > 0) {
                    const st = stallRef.current
                    const cur = Number(v.currentTime) || 0
                    if (st.t === null || Math.abs(cur - st.t) > 0.05) { st.t = cur; st.at = Date.now() }
                    else if (Date.now() - st.at > 2000 && Date.now() - st.diagAt > 2000) {
                      // 「为什么卡住」的仪表（只读）：四种死法在这几个量上长得不一样 ——
                      //   缓冲只有一段且 currentTime 贴着末端 → 元素在等数据/已 ended
                      //   buffered 有两段（中间空洞）        → 播放卡在空洞前，之后 append 的帧都碰不到
                      //   paused/ended 为真                   → 元素状态被按停
                      //   buffered 在长而 currentTime 不动     → jmuxer/解码器内部崩了
                      st.diagAt = Date.now()
                      let ranges = '?'
                      try {
                        const b = v.buffered, rs = []
                        for (let i = 0; i < b.length; i++) rs.push(b.start(i).toFixed(2) + '-' + b.end(i).toFixed(2))
                        ranges = '[' + rs.join(', ') + ']'
                      } catch (e) {}
                      logDiagLong('卡住诊断 readyState=' + v.readyState + ' networkState=' + v.networkState
                        + ' paused=' + v.paused + ' ended=' + v.ended
                        + ' currentTime=' + cur.toFixed(2) + ' buffered=' + ranges
                        + ' 收到帧=' + framesRef.current + ' 距上帧=' + Math.round((Date.now() - lastFrameRef.current) / 1000) + 's')
                    }
                    // ⚠️ 本轮**故意不自动重建解码器**：重建会把要观察的"卡死"状态直接抹掉，
                    //    用户就没法复现、也没法取证。【用户口述 2026-09-28】"遇到问题就重建 jmuxer，我怎么复现"
                    //    这里只当观察者：卡住期间每 2 秒打一行状态（进 500 行那份日志），状态原样留着。
                  }
                } catch (e) {}
              }, 500)

              // 700ms 一跳：取 AI 手势（并在确认期间显示落点绿点）
              // AI 的手势队列在 core，但触控必须经【本设备自己的 WS】发出去，所以由网页取走再发
              gestureDispose = interval(function () {
                if (disposed) return
                rpc('ctl:preview', {}).then(function (r) {
                  if (disposed) return
                  const p = (r && r.preview) || null
                  setPreview(p && p.sn === sn ? p : null)
                }).catch(function () {})
                rpc('ctl:dequeue', {}).then(function (r) {
                  if (disposed) return
                  if (r && r.ok && r.gesture) sendGesture(r.gesture)
                }).catch(function () {})
              }, 700)
              logDiag('init 完成')
            } catch (e) {
              logDiag('init 异常: ' + String((e && e.message) || e))
              setError(String((e && e.message) || e))
              setStatus('error')
              setNote(T('panel.initFailed'))
            }
          }
          init()
          return function () {
            disposed = true
            try { window.removeEventListener('resize', onResize) } catch (e) {}
            try { document.documentElement.style.setProperty('--' + CSS_PREFIX + '-panel-w', '0px') } catch (e) {}
            if (timerDispose) { try { timerDispose() } catch (e) {} }
            if (gestureDispose) { try { gestureDispose() } catch (e) {} }
            try { if (wsRef.current) wsRef.current.close() } catch (e) {}
            try { if (jmuxerRef.current) jmuxerRef.current.reset() } catch (e) {}
          }
        }, [port])

        // 面板不可见 → 暂停"广播"（抓屏会话留着）；重新可见 → 恢复广播
        // 【2026-09-28】本轮**不在恢复可见时重建解码器**：那会把"卡住之后切回来也没用"这个待查现象盖掉。
        //   （用户此前实测：卡住后切回来无效，只有断开重连/旋转屏幕能救）
        React.useEffect(function () {
          if (placement === 'hidden') sendCmd({ type: 'screen', mode: 'pause' })
          else if (placement === 'overlay') {
            sendCmd({ type: 'screen', mode: 'resume' })
          }
          // 把"当前聚焦（面板可见）的设备"告诉 core：AI 工具只作用于它；没有聚焦时 core 会明确报错、不猜
          rpc('device:focus', placement === 'hidden' ? {} : { sn: sn }).catch(function () {})
          if (placement !== 'floating') {
            try { document.documentElement.style.setProperty('--' + CSS_PREFIX + '-panel-w', '0px') } catch (e) {}
          }
        }, [placement])

        /** 执行一个 AI 手势（比例坐标 → 设备像素 → 经本设备 WS 发出去） */
        function sendGesture(g) {
          if (!g) return
          if (g.sn && g.sn !== sn) { logDiag('跳过手势：目标设备 ' + g.sn + ' ≠ 当前投屏 ' + sn); return }
          const d = deviceSizeRef.current
          if (!d) { logDiag('AI 手势未执行：缺少设备分辨率'); return }
          if (g.kind === 'tap' || g.kind === 'longpress') {
            const x = Math.max(0, Math.min(d.w - 1, Math.round(Number(g.fx) * (d.w - 1))))
            const y = Math.max(0, Math.min(d.h - 1, Math.round(Number(g.fy) * (d.h - 1))))
            const hold = g.kind === 'longpress' ? Math.max(100, Math.min(10000, Number(g.holdMs) || 2000)) : 40
            sendCmd({ type: 'touch', event: 'down', x: x, y: y })
            timeout(function () { sendCmd({ type: 'touch', event: 'up', x: x, y: y }) }, hold)
            logDiag('AI ' + (g.kind === 'longpress' ? '长按' : '点击') + ' @' + x + ',' + y + ' · ' + (g.intent || ''))
          } else if (g.kind === 'key') {
            sendCmd({ type: 'key', name: g.key })
            logDiag('AI 按键 ' + g.key + ' · ' + (g.intent || ''))
          }
        }

        /** 比例坐标 → 视频元素内的像素位置（含黑边偏移），用于落点绿点 */
        function dotPos(fx, fy) {
          const screen = screenRef.current
          const video = videoRef.current
          if (!screen || !video || fx === undefined || fy === undefined) return null
          const sr = screen.getBoundingClientRect()
          const r = video.getBoundingClientRect()
          const vw = video.videoWidth || 1, vh = video.videoHeight || 1
          const scale = Math.min(r.width / vw, r.height / vh)
          const drawW = vw * scale, drawH = vh * scale
          const offX = (r.width - drawW) / 2, offY = (r.height - drawH) / 2
          return { x: (r.left - sr.left) + offX + Number(fx) * drawW, y: (r.top - sr.top) + offY + Number(fy) * drawH }
        }
        function previewDots() {
          if (!preview || preview.sn !== sn) return []
          const p = dotPos(preview.fx, preview.fy)
          if (!p) return []
          return [{ cls: preview.kind === 'longpress' ? ' slow' : '', style: { left: p.x + 'px', top: p.y + 'px' } }]
        }

        /** 鼠标触控：去黑边 + 按【设备原始分辨率】换算（不能按视频流分辨率，--scale 只影响流） */
        function sendTouch(event, clientX, clientY) {
          const video = videoRef.current
          const ws = wsRef.current
          if (!video || !ws || ws.readyState !== 1) return
          const r = video.getBoundingClientRect()
          const sx = clientX - r.left, sy = clientY - r.top
          const vw = video.videoWidth || 1, vh = video.videoHeight || 1
          const scale = Math.min(r.width / vw, r.height / vh)
          const drawW = vw * scale, drawH = vh * scale
          const offX = (r.width - drawW) / 2, offY = (r.height - drawH) / 2
          const d = deviceSizeRef.current || { w: vw, h: vh }
          let px = Math.floor((sx - offX) * d.w / drawW)
          let py = Math.floor((sy - offY) * d.h / drawH)
          px = Math.max(0, Math.min(d.w - 1, px))
          py = Math.max(0, Math.min(d.h - 1, py))
          sendCmd({ type: 'touch', event: event, x: px, y: py })
        }

        function disconnect() {
          try { if (wsRef.current) wsRef.current.close() } catch (e) {}
          rpc('device:disconnect', { sn: sn }).catch(function () {})
          onClose()
        }

        const statusCls = status === 'playing' ? 'ok' : (status === 'closed' || status === 'error' ? 'bad' : 'warn')
        // 底行 = 帧计数（【收到过第一帧之后就一直显示】），未出画面 / 画面无变化只是附注
        const baseLine = T('panel.status', { n: frames, mb: (bytes / 1048576).toFixed(1) })
        const statusLine = (status === 'closed' || status === 'error')
          ? (note || T('panel.closed'))
          : (frames > 0 ? (note ? (baseLine + ' · ' + note) : baseLine) : (note || WAIT_TEXT))
        // 键盘状态文案：**由 provider 能力决定**（【用户口述 2026-09-26】：
        // "加个参数？是否有按键输入、（有的话）已连接/未连接的中英文字"）
        //   caps.keyboard = { on: {zh,en}, off: {zh,en}, notReady?: {zh,en} }
        //   core 已按当前语言把 {zh,en} 挑成字符串（见 host 的 pickText / localizeDeep）
        // 【用户口述 2026-09-27】三态，别把"不知道"和"知道但不行"混在一起：
        //   { on, off, notReady } → 有键盘接管，按状态显示那两句
        //   false                 → 明确不支持 → 显示"此平台不支持键盘接管"
        //   完全没声明             → 留白（兼容老 provider / 未知，不冤枉人家）
        //   ⚠️ 不能写成 `caps.keyboard || null`：false 会被 || 吃掉，退化成"没声明"
        const kbdCap = caps ? caps.keyboard : undefined
        const kbdText = kbdCap === false ? T('panel.kbdUnsupported')
          : (!kbdCap ? ''
            : (!kbdOn ? (kbdCap.off || T('panel.kbdOff'))
              : (hidReady === false ? (kbdCap.notReady || kbdCap.off || T('panel.kbdNotReady')) : (kbdCap.on || T('panel.kbdOn')))))

        // 「日志」= 【插件日志】：客户端诊断 + provider 推来的诊断行（2026-09-26【用户口述】：不做设备日志流）
        const logContent = diag.concat(logLines).join('\n') || T('panel.logEmpty')

        const rootCls = CSS_PREFIX + '-control'
          + (placement === 'overlay' ? ' ' + CSS_PREFIX + '-control-overlay' : '')
          + (placement === 'hidden' ? ' ' + CSS_PREFIX + '-control-hidden' : '')
        let rootStyle = null
        if (placement === 'floating') rootStyle = { width: panelW + 'px' }
        else if (placement === 'overlay' && rect) {
          rootStyle = {
            left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px',
            // 侧栏面板 z-index:10；全屏呈现时是 40，得压在它上面
            zIndex: rect.fullscreen ? 45 : 35,
          }
        }

        // 控制区的键：**完全按 provider 的声明**（【用户口述 2026-09-27】"剩下的按钮让 prov 声明"）
        //   caps.keys = 界面按钮（数组顺序即显示顺序；可以是 [] = 这个平台没有这些键）→ core 不再内置默认表
        //   caps.keyLabels = 双语显示名（core 已按当前语言挑好）；个别缺的就用内置表兜，再缺就显示键名本身
        const keys = Array.isArray(caps.keys) ? caps.keys : []
        const keyLabel = Object.assign(
          { back: T('key.back'), home: T('key.home'), volumeUp: T('key.volumeUp'), volumeDown: T('key.volumeDown'), power: T('key.power') },
          (caps && caps.keyLabels) || {},
        )
        // 全部强制成字符串：provider 的显示名可能是 {zh,en}，直接进 React 会炸掉整棵 UI（见 capText 的注释）
        Object.keys(keyLabel).forEach(function (k) { keyLabel[k] = capText(keyLabel[k]) || k })
        // 这排按钮（日志 + 各键）的**统一最小宽度 = 最长那条文案的实际宽度**（【用户口述 2026-09-27】）。
        // 于是它们会先尽量挤在一排；小到这个下限还放不下时，才由 flex-wrap 换行。
        // 量的时候借 -btn-sm 的样式（它字号 13px，比 -key 的 12px 大）→ 宁可宽一点，不会出现文字换行。
        const keyBtnLabels = [T('panel.log') + '▾'].concat(keys.map(function (k) { return capText(keyLabel[k]) || k }))
        const keyMinW = Math.ceil(maxLabelWidth(CSS_PREFIX + '-btn-sm', keyBtnLabels))
        const keyBtnStyle = keyMinW > 0 ? { minWidth: keyMinW + 'px' } : undefined

        return h('div', { className: rootCls, style: rootStyle },
          h('div', { className: CSS_PREFIX + '-control-head', ref: headRef },
            h('span', { className: CSS_PREFIX + '-csn', title: sn }, sn),
            props.wireless === undefined ? null : h('span', {
              className: CSS_PREFIX + '-quality',
              title: props.wireless ? T('panel.wireless') : T('panel.wired'),
            // 角标显示**真实生效的缩放**（【用户口述 2026-09-27】：选原画后不该还写 1/2）；
            //   scale = 除数（1 原画 / 2 / 3 / 4），由 provider 回报；拿不到就显示 —（不编）
            }, props.wireless
              ? T('panel.wirelessShort', { s: props.scale ? (props.scale === 1 ? T('cfg.scaleFull') : ('1/' + props.scale)) : '—' })
              : T('panel.wiredShort', { s: props.scale ? (props.scale === 1 ? T('cfg.scaleFull') : ('1/' + props.scale)) : '—' })),
            h('button', { className: CSS_PREFIX + '-btn-sm ' + CSS_PREFIX + '-shot-btn', title: T('panel.shotTitle'), onClick: function () { if (onAddShotToChat) onAddShotToChat(sn) } }, T('panel.shot')),
            h('button', { className: CSS_PREFIX + '-btn-sm', title: T('panel.settingsTitle'), onClick: function () { setSettingsOpen(true); loadModelInfo() } }, T('panel.settings')),
            h('button', { className: CSS_PREFIX + '-btn-sm', onClick: disconnect }, T('menu.disconnect')),
          ),
          h('div', { className: CSS_PREFIX + '-status-bar' },
            h('div', { className: CSS_PREFIX + '-control-status ' + statusCls, ref: statusRef }, error ? T('panel.errorPrefix', { msg: error }) : statusLine),
            // 原来「输入」按钮的位置（2026-09-26【用户口述】：删掉输入按钮，这儿换成键盘状态，下面不再放东西）
            kbdText ? h('div', { className: CSS_PREFIX + '-hint', title: kbdCap === false ? '' : T('panel.kbdTitle') }, kbdText) : null,
          ),
          h('div', { className: CSS_PREFIX + '-screen', ref: screenRef },
            h('video', {
              ref: videoRef, autoPlay: true, muted: true, playsInline: true, tabIndex: 0,
              // 去掉 Chromium 给聚焦元素的白框（点画面会冒出一圈，很难看）
              style: { outline: 'none' },
              onMouseDown: function (e) { draggingRef.current = true; sendTouch('down', e.clientX, e.clientY) },
              onMouseMove: function (e) { if (draggingRef.current) sendTouch('move', e.clientX, e.clientY) },
              onMouseUp: function (e) { draggingRef.current = false; sendTouch('up', e.clientX, e.clientY) },
              onMouseLeave: function (e) { if (draggingRef.current) { draggingRef.current = false; sendTouch('up', e.clientX, e.clientY) } },
              // 点一下就接管 PC 键盘；点画面外自动放开
              onFocus: function () { setKbdOn(true) },
              onBlur: function () { setKbdOn(false) },
              onKeyDown: onHidKeyDown,
              onKeyUp: onHidKeyUp,
            }),
            previewDots().map(function (d, i) { return h('div', { key: 'd' + i, className: CSS_PREFIX + '-tapdot' + d.cls, style: d.style }) }),
          ),
          logOpen ? h('div', { className: CSS_PREFIX + '-log', ref: logRef }, logContent) : null,
          h('div', { className: CSS_PREFIX + '-control-keys', ref: keysRef },
            // 「日志」对所有 provider 都显示 —— 它是插件日志，不是设备日志流
            h('button', { className: CSS_PREFIX + '-btn-sm ' + CSS_PREFIX + '-key-log', style: keyBtnStyle, onClick: toggleLog }, T('panel.log') + (logOpen ? '▾' : '▸')),
            keys.map(function (k) {
              return h('button', {
                key: k, className: CSS_PREFIX + '-key', style: keyBtnStyle, disabled: status === 'connecting',
                onClick: function () { sendCmd({ type: 'key', name: k }) },
              }, capText(keyLabel[k]) || k)
            }),
          ),
          settingsOpen ? h(SettingsDialog, {
            sn: sn, providerId: props.providerId, caps: caps,
            shotMode: shotMode, ctlMode: ctlMode, keyMode: keyMode, inputMode: inputMode,
            onModeChange: onModeChange,
            modelInfo: modelInfo, onModelChange: changeModel,
            onClose: function () { setSettingsOpen(false) },
          }) : null,
        )
      }

      // ------------------------------------------------------------
      // 设置弹层 A：AI 权限（core 的四项三态）+ 识别模型
      // ------------------------------------------------------------
      function modeRow(label, value, onChange, disabled) {
        return h('div', { className: CSS_PREFIX + '-setting-row' },
          h('div', { className: CSS_PREFIX + '-setting-info' }, h('div', { className: CSS_PREFIX + '-setting-label' }, label)),
          h('select', {
            className: CSS_PREFIX + '-select', value: value || 'off', disabled: !!disabled,
            onChange: function (e) { if (!disabled && onChange) onChange(e.target.value) },
          },
            h('option', { value: 'off' }, T('settings.mode.off')),
            h('option', { value: 'confirm' }, T('settings.mode.confirm')),
            h('option', { value: 'trust' }, T('settings.mode.trust')),
          ),
        )
      }

      function modelRow(info, onChange) {
        const models = (info && info.models) || []
        const cfg = (info && info.configured) || {}
        const value = cfg.provider && cfg.model ? (cfg.provider + '\u0000' + cfg.model) : ''
        let warn = ''
        if (!info) warn = T('settings.modelLoading')
        else if (info.error) warn = info.error
        else if (models.length === 0) warn = T('settings.modelNone')
        return h('div', { className: CSS_PREFIX + '-setting-row' },
          h('div', { className: CSS_PREFIX + '-setting-info' },
            h('div', { className: CSS_PREFIX + '-setting-label' }, T('settings.model')),
            warn ? h('div', { className: CSS_PREFIX + '-hint' }, warn) : null,
          ),
          h('select', {
            className: CSS_PREFIX + '-select', value: value, disabled: models.length === 0,
            onChange: function (e) { if (onChange) onChange(e.target.value) },
          }, models.map(function (m) {
            return h('option', { key: m.provider + '/' + m.id, value: m.provider + '\u0000' + m.id }, m.providerName + ' · ' + m.name)
          })),
        )
      }

      function SettingsDialog(props) {
        useLocaleRev()   // 换语言时重渲染（这些组件的文案是渲染时取 T() 的）
        const sn = props.sn
        const shotOff = !props.shotMode || props.shotMode === 'off'
        return h('div', { className: CSS_PREFIX + '-dialog-mask', onMouseDown: props.onClose },
          h('div', { className: CSS_PREFIX + '-dialog', onMouseDown: function (e) { e.stopPropagation() } },
            h('div', { className: CSS_PREFIX + '-dialog-head' },
              h('span', null, T('settings.title') + (sn ? ' · ' + sn : '')),
              h('button', { className: CSS_PREFIX + '-close', onClick: props.onClose }, '✕'),
            ),
            h('div', { className: CSS_PREFIX + '-dialog-body' },
              modeRow(T('settings.perm.shot'), props.shotMode, function (v) { props.onModeChange('shot', v) }),
              modeRow(T('settings.perm.ctl'), props.ctlMode, function (v) { props.onModeChange('ctl', v) }, shotOff),
              modeRow(keyPermLabel(props.caps), props.keyMode, function (v) { props.onModeChange('key', v) }, shotOff),
              modeRow(T('settings.perm.input'), props.inputMode, function (v) { props.onModeChange('input', v) }, shotOff),
              h('div', { className: CSS_PREFIX + '-hint' }, T('settings.depHint')),
              modelRow(props.modelInfo, props.onModelChange),
            ),
            h('div', { className: CSS_PREFIX + '-dialog-foot' },
              h('button', { className: CSS_PREFIX + '-btn-sm ' + CSS_PREFIX + '-btn-primary', onClick: props.onClose }, T('settings.done')),
            ),
          ),
        )
      }

      // ------------------------------------------------------------
      // 设置弹层 B：**某个 provider 自己的连接设置**
      //   字段全部由 provider 的 cfg:describe 描述 → UI 不知道"Java 路径/hdc/adb"这些概念
      // ------------------------------------------------------------
      function ProviderDialog(props) {
        const [fields, setFields] = React.useState([])
        const [draft, setDraft] = React.useState({})
        const [env, setEnv] = React.useState([])
        const [busy, setBusy] = React.useState(true)
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')

        const [provBuild, setProvBuild] = React.useState('')   // provider 构建戳（显示在"取消/保存"左边）

        async function reload() {
          setBusy(true); setError('')
          try {
            const desc = await providerCall(props.providerId, 'cfg:describe', {})
            const cfg = await providerCall(props.providerId, 'cfg:get', {})
            const e = await providerCall(props.providerId, 'env:detect', {})
            setFields((desc && desc.fields) || [])
            setDraft(Object.assign({}, (cfg && cfg.config) || {}))
            setEnv((e && e.items) || [])
            setProvBuild((desc && desc.build) || '')   // 【用户口述 2026-09-26】：构建戳显示在按钮行左边
          } catch (err) { setError(T('settings.err.load', { msg: String((err && err.message) || err) })) }
          setBusy(false)
        }
        React.useEffect(function () { reload() }, [props.providerId])

        async function autoDetect() {
          setBusy(true); setError(''); setNotice('')
          try {
            const e = await providerCall(props.providerId, 'env:detect', {})
            const items = (e && e.items) || []
            setEnv(items)
            const next = Object.assign({}, draft)
            items.forEach(function (it) { if (it && it.path && next[it.key] !== undefined) next[it.key] = it.path })
            setDraft(next)
            setNotice(T('cfg.detected'))
          } catch (err) { setError(T('cfg.detectFailed', { msg: String((err && err.message) || err) })) }
          setBusy(false)
        }

        async function save() {
          setBusy(true); setError(''); setNotice('')
          try {
            const r = await providerCall(props.providerId, 'cfg:save', draft)
            if (!r || !r.ok) setError(T('cfg.saveFailed', { msg: (r && r.error) || T('common.unknown') }))
            else { setNotice(T('cfg.saved')); await reload() }
          } catch (err) { setError(T('cfg.saveFailed', { msg: String((err && err.message) || err) })) }
          setBusy(false)
        }

        // ── 画面四件套（core 固定渲染；【用户口述 2026-09-26】）──
        //   key 由 core 定：wiredScale / wiredFps / wirelessScale / wirelessFps
        //   provider 声明了 capabilities.picture 才认为它会读；没声明也照样渲染，但给一句提示（不静默失效）
        //   ⚠️ 拿不到 capabilities（老 core/老 payload）时**不提示** —— 不知道就别冤枉人家
        //   默认：有线 1/2 · 60fps，无线 1/4 · 30fps；两端都能到"原画"；帧率 120 封顶
        const capsKnown = props.capabilities !== undefined && props.capabilities !== null
        const pic = capsKnown ? ((props.capabilities && props.capabilities.picture) || null) : {}
        function picOpts(kind) {
          const o = (pic && pic[kind]) || {}
          return {
            scale: Array.isArray(o.scale) && o.scale.length ? o.scale : ['1', '1/2', '1/3', '1/4'],
            fps: Array.isArray(o.fps) && o.fps.length ? o.fps : (kind === 'wireless' ? [60, 30, 15] : [120, 90, 60, 30, 15]),
            defaultScale: o.defaultScale || (kind === 'wireless' ? '1/4' : '1/2'),
            defaultFps: o.defaultFps || (kind === 'wireless' ? 30 : 60),
          }
        }
        function setDraftKey(k, v) { const next = Object.assign({}, draft); next[k] = v; setDraft(next) }
        function isEnvField(f) { return !!(f && f.group === 'env') }
        function renderField(f) {
          const cur = draft[f.key] === undefined || draft[f.key] === null ? '' : String(draft[f.key])
          if (f.type === 'select') {
            const opts = Array.isArray(f.options) ? f.options : []
            return h('div', { key: 'f-' + f.key, className: CSS_PREFIX + '-field' },
              h('label', null, f.label || f.key),
              h('select', { className: CSS_PREFIX + '-ctl', value: cur, onChange: function (e) { setDraftKey(f.key, e.target.value) } },
                opts.map(function (o) {
                  const val = String(o && o.value !== undefined ? o.value : o)
                  const lab = (o && o.label) ? String(o.label) : val
                  return h('option', { key: val, value: val }, lab)
                })),
              f.help ? h('div', { className: CSS_PREFIX + '-hint' }, f.help) : null,
            )
          }
          return h('div', { key: 'f-' + f.key, className: CSS_PREFIX + '-field' },
            h('label', null, f.label || f.key),
            h('input', {
              className: CSS_PREFIX + '-ctl',
              type: f.type === 'number' ? 'number' : 'text',
              value: cur,
              placeholder: f.placeholder || '',
              onChange: function (e) {
                const v = f.type === 'number' ? (Number(e.target.value) || 0) : e.target.value
                setDraftKey(f.key, v)
              },
            }),
            f.help ? h('div', { className: CSS_PREFIX + '-hint' }, f.help) : null,
          )
        }
        function pictureRow(kind, title) {
          const o = picOpts(kind)
          const sKey = kind === 'wired' ? 'wiredScale' : 'wirelessScale'
          const fKey = kind === 'wired' ? 'wiredFps' : 'wirelessFps'
          const sVal = (draft[sKey] === undefined || draft[sKey] === null || draft[sKey] === '') ? o.defaultScale : String(draft[sKey])
          const fVal = (draft[fKey] === undefined || draft[fKey] === null || draft[fKey] === '') ? String(o.defaultFps) : String(draft[fKey])
          return h('div', { key: 'pic-' + kind, className: CSS_PREFIX + '-field' },
            h('label', null, title),
            h('div', { className: CSS_PREFIX + '-row2' },
              h('span', { className: CSS_PREFIX + '-mini' }, T('cfg.scale')),
              h('select', { className: CSS_PREFIX + '-ctl', value: sVal, onChange: function (e) { setDraftKey(sKey, e.target.value) } },
                o.scale.map(function (v) { return h('option', { key: String(v), value: String(v) }, String(v) === '1' ? T('cfg.scaleFull') : String(v)) })),
              h('span', { className: CSS_PREFIX + '-mini' }, T('cfg.fps')),
              h('select', { className: CSS_PREFIX + '-ctl', value: fVal, onChange: function (e) { setDraftKey(fKey, Number(e.target.value)) } },
                o.fps.map(function (v) { return h('option', { key: String(v), value: String(v) }, String(v)) })),
            ),
          )
        }

        return h('div', { className: CSS_PREFIX + '-dialog-mask', onMouseDown: props.onClose },
          h('div', { className: CSS_PREFIX + '-dialog', onMouseDown: function (e) { e.stopPropagation() } },
            h('div', { className: CSS_PREFIX + '-dialog-head' },
              h('span', null, T('cfg.title', { label: props.providerLabel || props.providerId })),
              h('button', { className: CSS_PREFIX + '-close', onClick: props.onClose }, '✕'),
            ),
            h('div', { className: CSS_PREFIX + '-dialog-body' },
              busy && !fields.length ? h('div', { className: CSS_PREFIX + '-empty' }, T('cfg.reading')) : null,

              // ── 环境设置：状态小绿点行 + 路径字段；「自动检测」挪到标题右边（【用户口述 2026-09-26】）──
              // 第一个分区标题 marginTop 归零 —— 否则和大标题之间会空一大块（【用户口述 2026-09-27】）
              h('div', { className: CSS_PREFIX + '-sec-head', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '0' } },
                h('span', null, T('cfg.secEnv')),
                h('button', { className: CSS_PREFIX + '-btn-sm', style: { marginLeft: 'auto' }, onClick: autoDetect, disabled: busy }, T('cfg.auto')),
              ),
              env.map(function (it) {
                return h('div', { key: 'env-' + it.key, className: CSS_PREFIX + '-env-row' },
                  h('span', { className: CSS_PREFIX + '-dot ' + (it.ok ? 'ok' : 'bad') }),
                  h('b', null, it.label || it.key),
                  // info 行（比如"provider 构建"）没有路径，别显示"未配置"占位符去误导人
                  it.info ? null : h('span', { className: CSS_PREFIX + '-path', title: it.path || '' }, it.path || T('menu.notConfigured')),
                  h('span', { className: CSS_PREFIX + '-hint' }, (it.ok ? (it.version || '') : (it.error || T('menu.runFailed'))) + (it.source ? (' · ' + it.source) : '')),
                )
              }),
              fields.filter(isEnvField).map(renderField),

              // ── 参数设置：core 固定的画面四件套 + provider 追加的参数行 ──
              h('div', { className: CSS_PREFIX + '-sec-head' }, T('cfg.secParam')),
              pic ? null : h('div', { className: CSS_PREFIX + '-hint' }, T('cfg.picHint')),
              pictureRow('wired', T('cfg.wired')),
              pictureRow('wireless', T('cfg.wireless')),
              fields.filter(function (f) { return !isEnvField(f) }).map(renderField),
              error ? h('div', { className: CSS_PREFIX + '-hint', style: { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } }, error) : null,
              notice ? h('div', { className: CSS_PREFIX + '-notice' }, notice) : null,
            ),
            h('div', { className: CSS_PREFIX + '-dialog-foot' },
              // provider 构建戳：放在"取消/保存"行的左边（【用户口述 2026-09-26】）
              h('span', { className: CSS_PREFIX + '-hint', style: { marginRight: 'auto' } }, T('cfg.build') + ' ' + (provBuild || '—')),
              h('button', { className: CSS_PREFIX + '-btn-sm', onClick: props.onClose, disabled: busy }, T('cfg.cancel')),
              h('button', { className: CSS_PREFIX + '-btn-sm ' + CSS_PREFIX + '-btn-primary', onClick: save, disabled: busy }, busy ? T('cfg.busy') : T('cfg.save')),
            ),
          ),
        )
      }

      // ------------------------------------------------------------
      // 「scrcpy 菜单」：设备列表（**按 provider 分组**）+ 每组自己的环境行
      // ------------------------------------------------------------
      function DevicePanel(props) {
        useLocaleRev()   // 换语言时重渲染（菜单里的分组名/状态/按钮）
        const [open, setOpen] = React.useState(false)
        const [dialogFor, setDialogFor] = React.useState(null)       // providerId -> 连接设置弹层
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [providers, setProviders] = React.useState([])
        const [devices, setDevices] = React.useState([])
        const [coreBuild, setCoreBuild] = React.useState('')    // core 构建戳（菜单标题栏右边）
        const [refreshingId, setRefreshingId] = React.useState('')   // 正在刷新的 provider id
        const [envMap, setEnvMap] = React.useState({})               // providerId -> env items
        const [connectingSn, setConnectingSn] = React.useState('')
        const [runningSns, setRunningSns] = React.useState([])
        const [tabBroken, setTabBroken] = React.useState(false)
        const { sessions, docks, shotMode, ctlMode, keyMode, inputMode } = useSessionStore()
        useLocaleRev()   // DSH 换语言时重渲染（t() 读的是调用时的活动语言）
        const inputActions = props && props.inputActions
        const canUseTab = !!(tabsRegistry && sidebarRight) && !tabBroken

        React.useEffect(function () {
          if (sessionStore.get().inputActions !== (inputActions || null)) sessionStore.set({ inputActions: inputActions || null })
        }, [inputActions])

        React.useEffect(function () { return onScrcpyMenuOpen(function () { setOpen(true); setNotice('') }) }, [])

        const loadAll = React.useCallback(async function () {
          setBusy(true); setError('')
          try {
            const d = await rpc('devices:list', {})
            const provs = (d && d.providers) || []
            setProviders(provs)
            setCoreBuild((d && d.build) || '')
            setDevices((d && d.devices) || [])
            setRunningSns(((d && d.devices) || []).filter(function (x) { return x.streaming }).map(function (x) { return x.sn }))
            const m = await rpc('mode:get', {})
            const mm = (m && m.modes) || {}
            sessionStore.set({ shotMode: mm.shot || {}, ctlMode: mm.ctl || {}, keyMode: mm.key || {}, inputMode: mm.input || {} })
            // 每个 provider 的环境检测（hos 报 java+hdc，安卓报 adb）—— core 只负责摆位置
            const entries = await Promise.all(provs.map(async function (p) {
              try {
                const e = await providerCall(p.id, 'env:detect', {})
                return [p.id, (e && e.items) || []]
              } catch (err) { return [p.id, [{ key: '_err', label: T('cfg.envFailed'), ok: false, error: String((err && err.message) || err) }]] }
            }))
            const map = {}
            entries.forEach(function (kv) { map[kv[0]] = kv[1] })
            setEnvMap(map)
          } catch (err) { setError(T('notice.deviceInfoFailed', { msg: String((err && err.message) || err) })) }
          setBusy(false)
        }, [])

        /** 只刷新一个 provider 的设备（【用户口述 2026-09-26】：每组标题栏里的"刷新"只刷自己） */
        const refreshProvider = React.useCallback(async function (id) {
          setRefreshingId(id); setError('')
          try {
            const r = await rpc('devices:refresh', { id: id })
            if (!r || !r.ok) setError(T('notice.deviceInfoFailed', { msg: (r && r.error) || T('common.unknown') }))
            else {
              setDevices((r && r.devices) || [])
              setRunningSns(((r && r.devices) || []).filter(function (x) { return x.streaming }).map(function (x) { return x.sn }))
              if (r.build) setCoreBuild(r.build)
              const e = await providerCall(id, 'env:detect', {})
              setEnvMap(function (prev) { const next = Object.assign({}, prev); next[id] = (e && e.items) || []; return next })
            }
          } catch (err) { setError(T('notice.deviceInfoFailed', { msg: String((err && err.message) || err) })) }
          setRefreshingId('')
        }, [])

        React.useEffect(function () { if (open) loadAll() }, [open, loadAll])

        // 菜单开着时轮询：进程可能被空闲自杀收走，或宿主重启后没了。
        // 用"连续两次没看到才清理"防误杀（刚启动时有竞态）。
        const missRef = React.useRef({})
        React.useEffect(function () {
          if (!open) return undefined
          let disposed = false
          async function tick() {
            try {
              const d = await rpc('devices:list', {})
              if (disposed) return
              const list = (d && d.devices) || []
              setDevices(list)
              const sns = list.filter(function (x) { return x.streaming }).map(function (x) { return x.sn })
              setRunningSns(sns)
              Object.keys(sessionStore.get().sessions).forEach(function (sn) {
                if (sns.indexOf(sn) >= 0) { missRef.current[sn] = 0; return }
                missRef.current[sn] = (missRef.current[sn] || 0) + 1
                if (missRef.current[sn] >= 2) {
                  delete missRef.current[sn]
                  sessionStore.removeSession(sn)
                  releaseDeviceTab(sn)
                  closeScrcpyScreenTab(sn)
                  setNotice(T('notice.streamEnded', { sn: sn }))
                }
              })
            } catch (e) {}
          }
          tick()
          const dispose = interval(tick, 2000)
          return function () { disposed = true; try { dispose() } catch (e) {} }
        }, [open])

        async function disconnectDevice(sn) {
          setError('')
          try { await rpc('device:disconnect', { sn: sn }) } catch (e) { setError(T('notice.disconnectFailed', { msg: String((e && e.message) || e) })) }
          sessionStore.removeSession(sn)
          releaseDeviceTab(sn)
          closeScrcpyScreenTab(sn)
          setRunningSns(function (prev) { return prev.filter(function (x) { return x !== sn }) })
          setNotice(T('notice.disconnected', { sn: sn }))
        }

        async function connectDevice(row) {
          setConnectingSn(row.sn); setError('')
          try {
            const r = await rpc('device:connect', { sn: row.sn })
            if (r && r.ok && r.port) {
              setOpen(false)
              // capabilities 挂在 **provider** 上，不在设备行上 —— 以前读 row.capabilities 永远是空对象，
              // 靠 core 里那份写死的默认键表撑着；默认表删掉之后，按键按钮就一个都不剩了（2026-09-27 实测）
              const provRow = providers.find(function (x) { return x.id === row.providerId }) || {}
              sessionStore.setSession(Object.assign({
                sn: row.sn, port: r.port, wireless: !!r.wireless, scale: r.scale || 0,
                frameRate: r.frameRate || 0, iFrameInterval: r.iFrameInterval || 0,
                providerId: row.providerId, providerLabel: row.providerLabel,
                caps: (provRow && provRow.capabilities) || {},
              }))
              if (!(await openScrcpyScreenTab(row.sn))) {
                setTabBroken(true)
                setError(T('notice.tabFailed', { msg: sessionStore.get().openError || T('common.unknownReason') }))
              }
              setRunningSns(function (prev) { return prev.indexOf(row.sn) >= 0 ? prev : prev.concat([row.sn]) })
            } else setError(T('notice.connectFailed', { msg: (r && r.error) || T('common.unknown') }))
          } catch (err) { setError(T('notice.connectFailed', { msg: String((err && err.message) || err) })) }
          setConnectingSn('')
        }

        async function applyMode(perm, sn, mode) {
          setError(''); setNotice('')
          const r = await setMode(perm, sn, mode)
          if (r && r.error) setError(r.error)
          else if (r && r.notice) setNotice(r.notice)
        }

        async function handleAddShotToChat(sn) {
          setError(''); setNotice('')
          try {
            const r = await addShotToChat(sn, inputActions)
            if (r && r.ok) setNotice(T('notice.shotAdded'))
            else setError((r && r.error) || T('notice.shotFailed'))
          } catch (err) { setError(T('notice.shotFailed') + ' · ' + String((err && err.message) || err)) }
        }

        const icon = h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round', style: { width: 13, height: 13 } },
          h('rect', { x: '2', y: '3', width: '12', height: '10', rx: '2' }),
          h('path', { d: 'M2 7h12' }),
        )

        // 没装任何 provider 时的提示（三种可能都讲清）
        const noProviderNote = h('div', { className: CSS_PREFIX + '-note' },
          h('b', null, T('menu.noProvider.title')),
          h('div', null, T('menu.noProvider.three')),
          h('div', null, T('menu.noProvider.a')),
          h('div', null, T('menu.noProvider.b')),
          h('div', null, T('menu.noProvider.c')),
        )

        return h('div', { className: CSS_PREFIX + '-trigger' },
          h('button', { className: CSS_PREFIX + '-btn', title: T('menu.title'), onClick: function () { setOpen(true); setNotice('') } },
            icon, h('span', null, T('menu.title'))),
          Object.keys(sessions).map(function (key) {
            const s = sessions[key]
            const rect = docks[key] || null
            const placement = canUseTab ? (rect ? 'overlay' : 'hidden') : 'floating'
            return h(ControlPanel, {
              key: key, sn: s.sn, port: s.port, wireless: !!s.wireless, scale: s.scale, frameRate: s.frameRate,
              placement: placement, rect: rect, caps: s.caps, providerId: s.providerId,
              shotMode: shotMode[key] || 'off', ctlMode: ctlMode[key] || 'off',
              keyMode: keyMode[key] || 'off', inputMode: inputMode[key] || 'off',
              onModeChange: function (perm, mode) { applyMode(perm, key, mode) },
              onAddShotToChat: handleAddShotToChat,
              onClose: function () {
                sessionStore.removeSession(key)
                releaseDeviceTab(key)
                closeScrcpyScreenTab(key)
              },
            })
          }),
          open ? h('div', { className: CSS_PREFIX + '-mask', onMouseDown: function () { setOpen(false) } }) : null,
          open ? h('div', { className: CSS_PREFIX + '-panel', onMouseDown: function (e) { e.stopPropagation() } },
            h('div', { className: CSS_PREFIX + '-panel-head' },
              h('span', null, T('menu.title')),
              // core 构建戳（【用户口述 2026-09-26】：占原来"刷新"的位置）；刷新已挪到每个 provider 的标题栏
              h('span', { className: CSS_PREFIX + '-hint' }, 'core ' + (coreBuild || '—')),
            ),
            h('div', { className: CSS_PREFIX + '-panel-sec' },
              providers.length === 0 ? noProviderNote : null,
              providers.map(function (p) {
                const envItems = envMap[p.id] || []
                const groupDevices = devices.filter(function (d) { return d.providerId === p.id })
                return h('div', { key: p.id },
                  h('div', { className: CSS_PREFIX + '-group-title' },
                    h('span', null, T('menu.group', { label: p.label })),
                    h('span', { className: CSS_PREFIX + '-env-badge ' + ((p.blocked || !p.available || !envItems.every(function (i) { return i.ok })) ? 'bad' : 'ok') },
                      p.blocked ? T('menu.blocked') : (p.available ? (envItems.every(function (i) { return i.ok }) ? T('menu.envReady') : T('menu.envPending')) : (T('menu.unavailable') + (p.note ? '：' + p.note : '')))),
                    // 连接设置 在左、刷新 在最右（【用户口述 2026-09-26】）；刷新只刷这一个 provider
                    h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
                      h('button', { className: CSS_PREFIX + '-connect', onClick: function () { setDialogFor(p) } }, T('menu.connSettings')),
                      h('button', { className: CSS_PREFIX + '-btn-sm', disabled: refreshingId === p.id, onClick: function () { refreshProvider(p.id) } },
                        refreshingId === p.id ? h('span', { className: CSS_PREFIX + '-spin' }) : null,
                        refreshingId === p.id ? T('menu.refreshing') : T('menu.refresh')),
                    ),
                  ),
                  // 版本不配套 → core 已把这个 provider 停用（设备不进列表、动作不路由），这里给一句原因
                  p.blocked ? h('div', { className: CSS_PREFIX + '-note', style: { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } },
                    '⛔ ' + (p.blockReason || T('menu.blockReason'))) : null,
                  busy && !envItems.length ? h('div', { className: CSS_PREFIX + '-empty' }, T('menu.detecting')) : null,
                  envItems.map(function (it) {
                    return h('div', { key: 'env-' + it.key, className: CSS_PREFIX + '-env-row' },
                      h('span', { className: CSS_PREFIX + '-dot ' + (it.ok ? 'ok' : 'bad') }),
                      h('b', null, it.label || it.key),
                      // info 行（比如"provider 构建"）没有路径，别显示"未配置"占位符去误导人
                  it.info ? null : h('span', { className: CSS_PREFIX + '-path', title: it.path || '' }, it.path || T('menu.notConfigured')),
                      h('span', { className: CSS_PREFIX + '-hint' }, (it.ok ? (it.version || '') : (it.error || T('menu.runFailed'))) + (it.source ? (' · ' + it.source) : '')),
                    )
                  }),
                  h('div', { style: { marginTop: '6px' } },
                    groupDevices.length > 0
                      ? h('div', { className: CSS_PREFIX + '-list' }, groupDevices.map(function (dev) {
                          const running = runningSns.indexOf(dev.sn) >= 0
                          const busyThis = connectingSn === dev.sn
                          return h('div', { className: CSS_PREFIX + '-item', key: dev.sn },
                            h('span', { className: CSS_PREFIX + '-dot ' + (running ? 'ok' : 'idle'), title: running ? T('menu.running') : T('menu.notRunning') }),
                            h('span', { className: CSS_PREFIX + '-item-sn', title: dev.sn }, dev.sn),
                            dev.model ? h('span', { className: CSS_PREFIX + '-item-sub' }, dev.model) : null,
                            busyThis
                              ? h('span', { className: CSS_PREFIX + '-connecting' }, T('menu.connecting'))
                              : running
                                ? h('span', { className: CSS_PREFIX + '-item-actions' },
                                    h('button', { className: CSS_PREFIX + '-connect', onClick: async function () {
                                      const ok = await openScrcpyScreenTab(dev.sn)
                                      if (ok) setOpen(false)
                                      else setError(T('notice.tabFailed', { msg: sessionStore.get().openError || T('common.unknownReason') }))
                                    } }, T('menu.mirror')),
                                    h('button', { className: CSS_PREFIX + '-connect', onClick: function () { disconnectDevice(dev.sn) } }, T('menu.disconnect')),
                                  )
                                : h('button', { className: CSS_PREFIX + '-connect', disabled: !!connectingSn, onClick: function () { connectDevice(dev) }, style: { marginLeft: 'auto' } }, T('menu.start')),
                          )
                        }))
                      : h('div', { className: CSS_PREFIX + '-empty' }, busy ? T('menu.detectingDevices') : (p.available ? T('menu.noDevices') : T('menu.providerUnavailable'))),
                  ),
                )
              }),
            ),
            error ? h('div', { className: CSS_PREFIX + '-panel-sec' }, h('div', { className: CSS_PREFIX + '-hint', style: { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } }, error)) : null,
            notice ? h('div', { className: CSS_PREFIX + '-panel-sec' }, h('div', { className: CSS_PREFIX + '-notice' }, notice)) : null,
            h('div', { className: CSS_PREFIX + '-panel-foot' },
              h('span', { className: CSS_PREFIX + '-hint', style: { marginRight: 'auto' } }, T('menu.permHint')),
            ),
          ) : null,
          dialogFor ? h(ProviderDialog, {
            providerId: dialogFor.id, providerLabel: dialogFor.label,
            capabilities: dialogFor.capabilities,   // 画面四件套的声明（未声明时对话框给提示，不静默失效）
            onClose: function () { setDialogFor(null); loadAll() },
          }) : null,
        )
      }

      // ============================================================
      // 右侧栏标签页 + 开始页入口（DSH 0.1.5+）
      // 服务缺失时整块跳过，不影响上面的 header 菜单
      // ============================================================
      const TAB_KIND = 'dsh-scrcpy-devices'
      // ⚠️ 服务解析时机（静态包实测的坑）：bundle 形式的客户端插件 apply 可能早于 sidebar-right
      // 提供服务，此时 ctx.get 拿到 undefined，而静默早退的现象是"标签页没注册、退化成浮层、
      // 控制台一条日志都没有"。所以 apply 期试取一次，真要用的时侯再解析一次。
      let tabsRegistry = ctx.get('sidebarRightTabs')
      let sidebarRight = ctx.get('sidebarRight')
      let sidebarWarned = false
      function resolveSidebarServices() {
        if (!tabsRegistry) { try { tabsRegistry = ctx.get('sidebarRightTabs') } catch (e) {} }
        if (!sidebarRight) { try { sidebarRight = ctx.get('sidebarRight') } catch (e) {} }
        const missing = []
        if (!tabsRegistry) missing.push('sidebarRightTabs')
        if (!sidebarRight) missing.push('sidebarRight')
        if (missing.length === 0) return true
        if (!sidebarWarned) {
          sidebarWarned = true
          console.warn('[dsh-scrcpy-core] 侧栏服务未就绪，缺少：' + missing.join('、') + ' —— 标签页不可用，退回浮层面板')
        }
        return false
      }

      // 接上 DSH 的 locale 服务（**故意不写进 exports.inject**：inject 是硬依赖，
      // 老版本 DSH 没有这个服务会让整个客户端插件不激活；用 ctx.get 拿不到就退回中文，功能不受影响）
      bindLocale(ctx)

      function safeInject(name, fn) { try { slots.inject(name, fn) } catch (e) { /* 该槽位在当前 DSH 不存在 */ } }

      // 地址里只放安全字符（设备号可能是 ip:port，冒号在 URL 里会被编码，路由匹配不好预期）
      function deviceKey(sn) { return String(sn || '').replace(/[^0-9A-Za-z.\-]/g, '_') }
      function deviceKind(sn) { return TAB_KIND + '-' + deviceKey(sn) }

      // 每台设备一个专属 kind + 专属组件（sn 闭包进组件）：
      // 标签页 body 是按该 tab 的 kind 对应的类型 id 派发的，而那个类型的组件是我们自己注册的，
      // 所以不需要读地址（实测读不到），也不需要 tabInfo 就能知道身份。
      const deviceTabDisposers = {}

      function ensureDeviceTab(sn) {
        if (!sn) return false
        if (deviceTabDisposers[sn]) return true
        if (!resolveSidebarServices() || !slots) {
          sessionStore.set({ openError: T('notice.sidebarUnavailable', { slots: String(!!slots), tabs: String(!!tabsRegistry), side: String(!!sidebarRight) }) })
          return false
        }
        const id = deviceKind(sn)
        const disposers = []
        try {
          // 已有人注册过这个 kind（上一次插件实例的残留）→ 直接用，别再注册（重复注册会抛错）
          const already = typeof tabsRegistry.get === 'function' ? tabsRegistry.get(id) : undefined
          if (already) { deviceTabDisposers[sn] = []; return true }
          disposers.push(tabsRegistry.register({ id: id, kind: id, priority: 'extension', title: function () { return T('menu.mirror') } }))
          const registerPane = function (slotName, comp) {
            const direct = function () { return slots.register({ name: slotName, key: id }, comp) }
            if (typeof slots.inject === 'function') {
              try { return slots.inject(slotName, direct) } catch (e) { /* 退化到直接注册 */ }
            }
            return direct()
          }
          disposers.push(registerPane('sidebar.right.pane.tab', function (p) { return h(ScrcpyTabBody, Object.assign({}, p, { sn: sn })) }))
          disposers.push(registerPane('sidebar.right.pane.tab.title', function (p) { return h(ScrcpyTabTitle, Object.assign({}, p, { sn: sn })) }))
        } catch (e) {
          const msg = T('notice.tabRegisterFailed', { msg: String((e && e.message) || e) })
          console.warn('[dsh-scrcpy-core] ' + msg, e)
          sessionStore.set({ openError: msg })
          disposers.forEach(function (d) { try { d() } catch (e2) {} })
          return false
        }
        deviceTabDisposers[sn] = disposers
        return true
      }

      /** 断开某台设备时注销它的专属 kind（否则留下悬空的类型注册） */
      function releaseDeviceTab(sn) {
        const ds = deviceTabDisposers[sn]
        if (!ds) return
        delete deviceTabDisposers[sn]
        ds.forEach(function (d) { try { d() } catch (e) {} })
      }

      /**
       * 标签页本体只是"占位 + 位置报告器"：
       * 投屏画面挂在常驻的 header 面板里（dockkit 的 paneBody 只渲染活动标签的 body，切走就卸载，
       * 而整条流只有一个关键帧，重开解码器必黑屏），这里只把矩形报给 store，面板据此贴上来。
       */
      function ScrcpyTabBody(props) {
        useLocaleRev()   // 换语言时重渲染（标签页标题靠它刷新）
        const sess = useSessionStore()
        const hostRef = React.useRef(null)
        const sn = String((props && props.sn) || '')
        const snRef = React.useRef(sn)
        snRef.current = sn
        const infoRef = React.useRef(null)
        try { infoRef.current = (props && props.hooks && typeof props.hooks.tabInfo === 'function') ? props.hooks.tabInfo() : null } catch (e) { infoRef.current = null }
        const lastRawRef = React.useRef(null)

        /** 我这张标签页现在是不是"最前 + 侧栏展开"？（不读 tabInfo，直接问 sidebarRight） */
        function myTabActive() {
          if (!sidebarRight) return true
          try {
            if (typeof sidebarRight.isExpanded === 'function' && !sidebarRight.isExpanded()) return false
            const active = typeof sidebarRight.active === 'function' ? sidebarRight.active() : undefined
            if (!active) return false
            return active.kind === deviceKind(sn)
          } catch (e) { return false }
        }

        function publish() {
          const el = hostRef.current
          const mySn = snRef.current
          if (!el || !mySn) return
          const cur = infoRef.current
          if (!myTabActive()) {
            lastRawRef.current = null
            if (sessionStore.get().docks[mySn]) sessionStore.setDock(mySn, null)
            // 面板不可见就不算聚焦设备（AI 只操作看得见的那台）
            if (sessionStore.get().focusedSn === mySn) { sessionStore.set({ focusedSn: '' }); rpc('device:focus', {}).catch(function () {}) }
            return
          }
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) return
          const next = {
            left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
            fullscreen: !!(cur && cur.sidebar && cur.sidebar.fullscreen),
          }
          const prev = sessionStore.get().docks[mySn]
          const same = prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height && prev.fullscreen === next.fullscreen
          const raw = lastRawRef.current
          const rawSame = raw && raw.left === next.left && raw.top === next.top && raw.width === next.width && raw.height === next.height
          lastRawRef.current = next
          // 侧栏展开/收起有 ~200ms 动画，动画期间每帧尺寸都不同，这时改大图层尺寸 = 卡顿来源。
          // 规则：首帧立刻贴，之后必须连续两次采样一致（动画停了）才发布。
          if (!same) { if (!raw || rawSame) sessionStore.setDock(mySn, next) }
          if (sessionStore.get().focusedSn !== mySn) { sessionStore.set({ focusedSn: mySn }); rpc('device:focus', { sn: mySn }).catch(function () {}) }
        }

        React.useEffect(function () {
          publish()
          const dispose = interval(publish, 500)   // 侧栏拖宽 / 窗口变化 / 切全屏都能跟上
          function onResize() { publish() }
          try { window.addEventListener('resize', onResize) } catch (e) {}
          return function () {
            try { dispose() } catch (e) {}
            try { window.removeEventListener('resize', onResize) } catch (e) {}
            const mySn = snRef.current
            if (mySn) sessionStore.setDock(mySn, null)   // 标签页被卸载：面板转隐藏态（仍收流）
          }
        }, [])

        return h('div', { ref: hostRef, className: CSS_PREFIX + '-tab-host', style: { width: '100%', height: '100%', boxSizing: 'border-box' } },
          sess.sessions[sn] ? null : h('div', { className: CSS_PREFIX + '-tab-empty' },
            h('div', { className: CSS_PREFIX + '-hint' }, T('panel.notConnected')),
            h('button', { className: CSS_PREFIX + '-btn-sm ' + CSS_PREFIX + '-btn-primary', onClick: openScrcpyMenu }, T('panel.openMenu')),
          ),
        )
      }

      function ScrcpyTabTitle(props) {
        const sess = useSessionStore()
        const sn = String((props && props.sn) || '')
        if (!sn) return 'scrcpy'
        return sess.sessions[sn] ? T('panel.tabTitle', { sn: sn }) : T('panel.goneTitle', { sn: sn })
      }

      /** 打开（或聚焦）某台设备的投屏标签页；失败返回 false（调用方回退浮层） */
      async function openScrcpyScreenTab(sn) {
        if (!sn) return false
        if (!ensureDeviceTab(sn)) return false
        if (!resolveSidebarServices() || typeof sidebarRight.openTab !== 'function') {
          console.warn('[dsh-scrcpy-core] sidebarRight.openTab 不可用（服务未就绪或版本不匹配），退回浮层面板')
          return false
        }
        const myKind = deviceKind(sn)
        const attempt = function () { try { sidebarRight.openTab(myKind); return { ok: true } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } }
        let last = attempt()
        if (last.ok) return true
        // 侧栏收起时"座位"可能没挂载 → 先展开再重试
        try {
          if (typeof sidebarRight.isExpanded === 'function' && !sidebarRight.isExpanded() && typeof sidebarRight.toggleExpanded === 'function') sidebarRight.toggleExpanded()
        } catch (e) {}
        for (let i = 0; i < 6 && !last.ok; i++) { await new Promise(function (r) { timeout(r, 250) }); last = attempt() }
        if (!last.ok) {
          console.warn('[dsh-scrcpy-core] openTab 失败：', last.error)
          sessionStore.set({ openError: last.error || T('common.unknown') })
          return false
        }
        return true
      }

      /**
       * 关掉某台设备的投屏标签页（断开时调用）。侧栏规则（两条实测出来的坑）：
       *  · 还有别的设备标签页 → 什么都不动（你还在看另一台，贸然收起会把它的画面一起收掉）；
       *  · 这是最后一张 → 主动收起侧栏（否则 dockkit 会切到别的标签，看着像插件乱跳）。
       * 所以调用方必须先 releaseDeviceTab(sn) 再调本函数。
       */
      function closeScrcpyScreenTab(sn) {
        if (!resolveSidebarServices()) return
        try {
          const active = typeof sidebarRight.active === 'function' ? sidebarRight.active() : undefined
          const mine = !!(active && active.id && active.kind === deviceKind(sn))
          if (!mine) return
          if (typeof sidebarRight.close === 'function') sidebarRight.close(active.id)
          if (Object.keys(deviceTabDisposers).length > 0) return
          if (typeof sidebarRight.isExpanded === 'function' && typeof sidebarRight.toggleExpanded === 'function' && sidebarRight.isExpanded()) sidebarRight.toggleExpanded()
        } catch (e) {}
      }

      // ---- 「开始」页入口（复刻官方胶囊列表 + 追加自己的入口） ----
      function CompassGlyph(props) {
        const s = (props && props.size) || 16
        return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', className: props && props.className },
          h('circle', { cx: '8', cy: '8', r: '6', stroke: 'currentColor', strokeWidth: '1.4' }),
          h('path', { d: 'M 10.9 5.1 L 9.1 9.1 L 5.1 10.9 L 6.9 6.9 Z', fill: 'currentColor' }))
      }
      function CubeGlyph(props) {
        const s = (props && props.size) || 16
        return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', className: props && props.className },
          h('path', { d: 'M 8 2.5 L 12.9 5.2 V 10.8 L 8 13.5 L 3.1 10.8 V 5.2 Z', stroke: 'currentColor', strokeWidth: '1.1', strokeLinejoin: 'round' }),
          h('path', { d: 'M 3.1 5.2 L 8 7.9 L 12.9 5.2 M 8 7.9 V 13.5', stroke: 'currentColor', strokeWidth: '1.1', strokeLinejoin: 'round', strokeLinecap: 'round' }))
      }
      function useGuideEntries(registry) {
        const [entries, setEntries] = React.useState(function () { return (registry && registry.guide && registry.guide()) || [] })
        React.useEffect(function () {
          if (!registry || typeof registry.subscribe !== 'function') return undefined
          const unsub = registry.subscribe(function () { setEntries((registry.guide && registry.guide()) || []) })
          return function () { try { unsub() } catch (e) {} }
        }, [])
        return entries
      }
      function GuideEntryBox(props) {
        const entry = props.entry
        const description = props.described && entry.description ? entry.description() : undefined
        const Icon = entry.icon || CubeGlyph
        return h('button', {
          type: 'button', className: CSS_PREFIX + '-guide-entry', 'data-sidebar-right-guide-entry': entry.kind,
          onClick: function () { props.onPick(entry) },
        },
          h('span', { className: CSS_PREFIX + '-guide-entryIcon' },
            h(Icon, { size: description === undefined ? 22 : 26, className: entry.icon === undefined ? (CSS_PREFIX + '-guide-placeholderInk') : undefined })),
          h('span', { className: CSS_PREFIX + '-guide-entryText' },
            h('span', { className: CSS_PREFIX + '-guide-entryTitle' }, entry.title()),
            description !== undefined ? h('span', { className: CSS_PREFIX + '-guide-entryDescription' }, description) : null))
      }
      function GuidePage(props) {
        const MAX_DESCRIBED = 4
        const entries = useGuideEntries(props.registry)
        const described = entries.length <= MAX_DESCRIBED
        return h('div', { className: CSS_PREFIX + '-guide', 'data-sidebar-right-guide': true },
          h('span', { className: CSS_PREFIX + '-guide-hero', 'aria-hidden': 'true' }, h(CompassGlyph, { size: 56 })),
          entries.map(function (entry, index) { return h(GuideEntryBox, { key: entry.kind + ':' + index, entry: entry, described: described, onPick: props.onPick }) }),
          h('button', { type: 'button', className: CSS_PREFIX + '-guide-entry', onClick: function () { props.onOpenMenu() } },
            h('span', { className: CSS_PREFIX + '-guide-entryIcon' }, h(CubeGlyph, { size: 22, className: CSS_PREFIX + '-guide-placeholderInk' })),
            h('span', { className: CSS_PREFIX + '-guide-entryText' },
              h('span', { className: CSS_PREFIX + '-guide-entryTitle' }, T('menu.title')),
              described ? h('span', { className: CSS_PREFIX + '-guide-entryDescription' }, T('menu.describe')) : null)))
      }

      // ---- 注册到宿主的扩展点 ----
      // 会话右上角的「scrcpy 菜单」按钮
      slots.inject('conversation.session.header.utilities', function () {
        return slots.register(
          { name: 'conversation.session.header.utilities', id: 'dsh-scrcpy-devices', order: -20, label: T('menu.title') },
          function (props) { return h(DevicePanel, props) },
        )
      })
      // ⚠️ 「开始」页入口【暂未接线】：原 2.1.1 里 GuidePage 也是"定义了但没注册"的死代码，
      //    说明当时同样没找到正确的槽位名。我在 profile 的 @deepseek-ai 包里 grep 不到
      //    sidebar.right.* 的槽位名（侧栏大概是前端 dist 的编译产物），所以**不猜** ——
      //    等确认 DSH（0.1.7）里真实的槽位名再接。上面 GuidePage / GUIDE_CSS 先留着备用。
    }

    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight']
    exports.apply = apply
    return module.exports
  },
})
}
