// core 内部纯逻辑的单元测试：从源码里把函数抽出来，用 new Function 注入依赖后直接跑。
// 覆盖两类真出过问题的东西：
//   1) [object Object] —— 双语对象没挑语言就被拼进字符串
//   2) DSH 版本探测 —— 先读 profiles 会读到磁盘上的旧副本（实测 0.1.5-rc.3，而运行中的是 0.2.1-rc.2）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import os from 'node:os'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 抽出源码里的一个顶层函数（"function name(" 到行首 } 收尾） */
function extract(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, '找不到函数 ' + name)
  const end = source.indexOf('\n}', start) + 2
  assert.ok(end > start, '函数 ' + name + ' 没有正常收尾')
  return source.slice(start, end)
}

const fn = (args, names, extra) =>
  new Function(...args, (extra || '') + '\n' + names.map(extract).join('\n') + '\nreturn ' + names[names.length - 1])

test('pickText：字符串原样返回，{zh,en} 按当前语言挑，嵌套再挑一层', () => {
  const pickText = fn(['hostLocale'], ['pickText'])('zh')
  assert.equal(pickText('安卓'), '安卓')
  assert.equal(pickText({ zh: '安卓', en: 'Android' }), '安卓')
  assert.equal(pickText({ en: 'Android' }), 'Android')
  assert.equal(pickText({ zh: { zh: '嵌套' } }), '嵌套')
  assert.equal(pickText(null), '')
  assert.equal(pickText(undefined), '')
  assert.equal(pickText(42), '42')
})

test('pickText：挑不出语言的怪对象给 JSON 原文，绝不给 [object Object]', () => {
  const pickText = fn(['hostLocale'], ['pickText'])('zh')
  const weird = { foo: 'bar' }
  const out = pickText(weird)
  assert.notEqual(out, '[object Object]')
  assert.equal(out, JSON.stringify(weird))
})

test('localizeDeep：已知文案字段挑语言，keyLabels 整表逐条挑（漏了它 React 会卸掉整块 UI）', () => {
  const pickText = fn(['hostLocale'], ['pickText'])('zh')
  const TEXT_KEYS = ['label', 'hint', 'help', 'note', 'placeholder', 'title', 'text', 'error', 'blockReason', 'providerLabel', 'on', 'off', 'notReady']
  const localizeDeep = new Function('pickText', 'hostLocale', 'TEXT_KEYS',
    extract('localizeDeep') + '\nreturn localizeDeep')(pickText, 'zh', TEXT_KEYS)

  const out = localizeDeep({
    label: { zh: '鸿蒙', en: 'HarmonyOS' },
    keyLabels: { back: { zh: '返回', en: 'Back' }, home: { zh: '主页', en: 'Home' } },
    nested: { note: { zh: '说明', en: 'Note' } },
    count: 3,
  }, 0)
  assert.equal(out.label, '鸿蒙')
  assert.equal(out.keyLabels.back, '返回')
  assert.equal(out.keyLabels.home, '主页')
  assert.equal(out.nested.note, '说明')
  assert.equal(out.count, 3)
})

test('compareVersion：预发布版低于正式版，版本序单调', () => {
  const compareVersion = fn([], ['parseVersion', 'cmpPreId', 'compareVersion'])()
  assert.ok(compareVersion('0.2.1', '0.2.1-rc.2') > 0)
  assert.ok(compareVersion('0.2.1-rc.2', '0.2.1') < 0)
  assert.ok(compareVersion('0.2.1-rc.2', '0.1.0-rc8') > 0)
  assert.ok(compareVersion('0.1.5-rc.3', '0.1.0-rc8') > 0)
  assert.equal(compareVersion('1.2.3', '1.2.3'), 0)
})

/** 造一个最小可用的 asar，里面放 dsh 的 manifest */
function makeAsar(dir, version) {
  const payload = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  const header = Buffer.from(JSON.stringify({
    files: { dsh: { files: { node_modules: { files: { '@deepseek-ai': { files: { dsh: { files: { 'package.json': { size: payload.length, offset: '0' } } } } } } } } } },
  }))
  const headerSize = 8 + header.length + ((4 - (header.length % 4)) % 4)
  const prefix = Buffer.alloc(8 + headerSize)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(headerSize, 4)
  prefix.writeUInt32LE(headerSize - 4, 8)
  prefix.writeUInt32LE(header.length, 12)
  header.copy(prefix, 16)
  const archive = join(dir, 'app.asar')
  writeFileSync(archive, Buffer.concat([prefix, payload]))
  return archive
}

test('readAsarJson：读得到目标文件，畸形/截断归档安全返回 null', (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsh-asar-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const readAsarJson = new Function('openSync', 'readSync', 'closeSync',
    extract('readAsarJson') + '\nreturn readAsarJson')(openSync, readSync, closeSync)

  const archive = makeAsar(dir, '0.2.1-rc.2')
  assert.equal(readAsarJson(archive, 'dsh/node_modules/@deepseek-ai/dsh/package.json').version, '0.2.1-rc.2')
  assert.equal(readAsarJson(archive, '不存在的/路径.json'), null)

  const broken = join(dir, 'broken.asar')
  writeFileSync(broken, Buffer.from('broken'))
  assert.equal(readAsarJson(broken, 'package.json'), null)

  const huge = join(dir, 'huge.asar')
  const bad = Buffer.alloc(16)
  bad.writeUInt32LE(0xffffffff, 4)
  writeFileSync(huge, bad)
  assert.equal(readAsarJson(huge, 'package.json'), null)
})

test('readDshVersion：asar（运行中的那份）优先于 profiles 里的旧残留副本', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsh-ver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const old = join(dir, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.3' }))

  const archive = makeAsar(dir, '0.2.1-rc.2')
  const readAsarJson = new Function('openSync', 'readSync', 'closeSync',
    extract('readAsarJson') + '\nreturn readAsarJson')(openSync, readSync, closeSync)

  const fakeProcess = { env: { DSH_HOME: dir, DSH_ASAR_PATH: archive }, execPath: join(dir, 'node.exe'), resourcesPath: '' }
  const readDshVersion = new Function('join', 'dirname', 'os', 'process', 'readFileSync', 'readAsarJson',
    'let dshVersion = ""\nlet dshVersionPending = null\n' + extract('readDshVersion') + '\nreturn readDshVersion')(
    join, dirname, { homedir: () => dir }, fakeProcess, (p) => readFileSync(p, 'utf8'), readAsarJson)

  assert.equal(await readDshVersion(), '0.2.1-rc.2', 'asar 里的版本必须优先于 profiles 里的旧副本')

  // 没有 asar 时退回 profiles（CLI 安装布局）
  const cliOnly = new Function('join', 'dirname', 'os', 'process', 'readFileSync', 'readAsarJson',
    'let dshVersion = ""\nlet dshVersionPending = null\n' + extract('readDshVersion') + '\nreturn readDshVersion')(
    join, dirname, { homedir: () => dir }, { env: { DSH_HOME: dir }, execPath: join(dir, 'node.exe'), resourcesPath: '' },
    (p) => readFileSync(p, 'utf8'), () => null)
  assert.equal(await cliOnly(), '0.1.5-rc.3')
})
