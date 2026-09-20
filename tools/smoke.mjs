import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// 默认测同仓库根目录的页面；也可传参：node tools/smoke.mjs path/to/page.html
const target = process.argv[2] || fileURLToPath(new URL('../index.html', import.meta.url));
const html = fs.readFileSync(target, 'utf8');
console.log('测试文件: ' + target);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---- 1. 语法解析检查（老内核挂掉的首要原因）----
console.log('\n[1] 语法解析');
scripts.forEach((code, i) => {
  let err = null;
  try { new vm.Script(code); } catch (e) { err = e; }
  ok(`script #${i + 1} 可解析`, !err, err && err.message);
});

// ---- 从 HTML 里真实存在的 id / class 构建 DOM 桩 ----
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const screenIds = [...html.matchAll(/<section class="screen[^"]*" id="([^"]+)"/g)].map(m => m[1]);
const tabScreens = [...html.matchAll(/data-screen="([^"]+)"/g)].map(m => m[1]);
const backdropCount = (html.match(/class="modal-backdrop"/g) || []).length;

function makeEl(sel) {
  let _html = '';
  return {
    _sel: sel, _text: '', value: '', placeholder: '', hidden: false,
    dataset: {}, style: {}, onclick: null, parentNode: null, disabled: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }
    },
    get innerHTML() { return _html; },
    set innerHTML(v) { _html = String(v); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    focus() {}, blur() {},
  };
}

// data-* 属性 -> 从哪个容器的 innerHTML 里解析
const attrSource = {
  'data-habit': '#actions', 'data-wish': '#wishList', 'data-edit-wish': '#wishList',
  'data-delete-wish': '#wishList', 'data-edit-habit': '#habitList', 'data-delete-habit': '#habitList',
};

function makeDoc() {
  const byId = new Map();
  ids.forEach(id => byId.set(id, makeEl('#' + id)));
  // 按 HTML 上真实存在的 hidden 属性初始化（<div class="modal" ... hidden>、<input ... hidden />）
  ids.forEach(id => {
    const m = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>').exec(html);
    if (m && /\bhidden\b/.test(m[0])) byId.get(id).hidden = true;
  });
  const screens = screenIds.map(id => byId.get(id));
  screens[0].classList.add('active');
  const tabs = tabScreens.map(s => { const e = makeEl('.tab'); e.dataset.screen = s; return e; });
  tabs[0].classList.add('active');
  const backdrops = [];
  for (let i = 0; i < backdropCount; i++) backdrops.push(makeEl('.modal-backdrop'));
  const attrCache = new Map();

  const doc = {
    querySelector(sel) {
      if (sel[0] === '#') return byId.get(sel.slice(1)) || null;
      if (sel === '.tab') return tabs[0];
      if (sel === '.screen') return screens[0];
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.screen') return screens.slice();
      if (sel === '.tab') return tabs.slice();
      if (sel === '.modal-backdrop') return backdrops.slice();
      const m = sel.match(/^\[([a-z-]+)\]$/);
      if (!m) return [];
      const attr = m[1];
      const srcSel = attrSource[attr];
      if (!srcSel) return [];
      const src = doc.querySelector(srcSel);
      const srcHtml = src ? src.innerHTML : '';
      const ck = attr + '|' + srcHtml;
      if (attrCache.has(ck)) return attrCache.get(ck).slice();
      const out = [];
      const re = new RegExp(attr + '="([^"]*)"(?:\\s+data-event="([^"]*)")?', 'g');
      let g;
      while ((g = re.exec(srcHtml)) !== null) {
        const e = makeEl('[' + attr + ']');
        // 真实 DOM：data-delete-wish -> dataset.deleteWish
        e.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = g[1];
        if (g[2] !== undefined) e.dataset.event = g[2];
        out.push(e);
      }
      attrCache.set(ck, out);
      return out.slice();
    },
    getElementById(id) { return byId.get(id) || null; },
  };
  // 绑定 backdrop 的父节点
  backdrops.forEach((b, i) => { b.parentNode = makeEl('.modal'); });
  return { doc, byId, screens, tabs, backdrops };
}

function makeStorage(mode, seed) {
  if (mode === 'throw') {
    return { getItem() { throw new Error('SecurityError: storage disabled'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  }
  if (mode === 'null') return null;
  const m = new Map();
  if (seed !== undefined) m.set('little-star-planet-v1', seed);
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

function boot(opts) {
  const { doc, byId, screens, tabs, backdrops } = makeDoc();
  const storage = makeStorage(opts.storage, opts.seed);
  const errors = [];
  const win = {
    localStorage: storage,
    location: { protocol: opts.protocol || 'https:' },
    scrollTo() {},
    onerror: null,
  };
  const sandbox = {
    window: win, document: doc, console,
    setTimeout: (fn, t) => setTimeout(fn, t || 0),
    clearTimeout, Date, Math, JSON, Number, String, Object, Array, isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  scripts.forEach((code, i) => {
    try { vm.runInContext(code, sandbox, { filename: 'script' + i }); }
    catch (e) { errors.push('script' + i + ': ' + e.message); }
  });
  return { byId, screens, tabs, backdrops, errors, storage, win, $: s => doc.querySelector(s), $$: s => doc.querySelectorAll(s) };
}

// ---- 2. 正常环境（https + localStorage 可用）----
console.log('\n[2] 正常环境（https + localStorage 可用）');
{
  const t = boot({ storage: 'ok', protocol: 'https:' });
  ok('脚本执行无异常', t.errors.length === 0, t.errors.join(' / '));
  ok('渲染出 6 个预设行为项目', t.$$('[data-habit]').length === 6, '实际 ' + t.$$('[data-habit]').length);
  ok('完成计数为 0 / 6', t.$('#doneCount').textContent === '0 / 6 已完成', t.$('#doneCount').textContent);
  ok('初始余额为 0', t.$('#balance').textContent === '0', t.$('#balance').textContent);
  ok('未显示环境警告条', t.$('#envWarn').hidden === true);
  ok('设置页显示存储状态“正常”', t.$('#storagePill').textContent === '正常', t.$('#storagePill').textContent);
  ok('数据已写入 localStorage', !!t.storage._m.get('little-star-planet-v1'));

  // 打卡
  ok('未打卡时按钮为 ＋1 ⭐', /＋1 ⭐/.test(t.$('#actions').innerHTML));
  const btn = t.$$('[data-habit]')[1];
  btn.onclick();
  ok('打卡后余额为 1', t.$('#balance').textContent === '1', t.$('#balance').textContent);
  ok('打卡后完成计数为 1 / 6', t.$('#doneCount').textContent === '1 / 6 已完成', t.$('#doneCount').textContent);
  const done = t.$$('[data-habit]')[1];
  ok('已打卡项按钮变为“取消完成”', /取消完成/.test(t.$('#actions').innerHTML));
  ok('已打卡项带 data-event', !!done.dataset.event, JSON.stringify(done.dataset));
  done.onclick();
  ok('取消打卡后余额回到 0', t.$('#balance').textContent === '0', t.$('#balance').textContent);

  // tab 切换 + 高亮
  const settingsTab = t.tabs.find(b => b.dataset.screen === 'settings');
  settingsTab.onclick();
  ok('切到设置页', t.$('#settings').classList.contains('active'));
  ok('离开今天页', !t.$('#today').classList.contains('active'));
  ok('设置 tab 高亮跟随', settingsTab.classList.contains('active') && !t.tabs[0].classList.contains('active'));

  // 本周目标：不再依赖 prompt()
  t.$('#goalBtn').onclick();
  ok('点“本周目标”弹出自定义弹层', t.$('#askDialog').hidden === false);
  ok('弹层带数字输入框', t.$('#askInput').hidden === false);
  t.$('#askInput').value = '30';
  t.$('#askOk').onclick();
  const saved = JSON.parse(t.storage._m.get('little-star-planet-v1'));
  ok('目标已保存为 30', saved.goal === 30, String(saved.goal));
  ok('设置按钮文案同步为 30 ⭐', t.$('#goalBtn').textContent === '30 ⭐', t.$('#goalBtn').textContent);
  ok('弹层已关闭', t.$('#askDialog').hidden === true);

  // 添加行为项目：不再依赖 <dialog>.showModal()
  t.$('#habitBtn').onclick();
  ok('进入行为项目管理页', t.$('#habitsMgmt').classList.contains('active'));
  ok('返回设置的 tab 仍高亮', settingsTab.classList.contains('active'));
  t.$('#addHabitBtn').onclick();
  ok('添加行为弹层打开', t.$('#recordDialog').hidden === false);
  ok('弹层内显示分类输入框', t.$('#habitCategory').hidden === false);
  t.$('#recordNote').value = '自己穿衣服';
  t.$('#habitCategory').value = '自理';
  t.$('#habitIcon').value = '🧦';
  t.$('#confirmDialog').onclick();
  ok('行为项目增加到 7 个', t.$$('[data-habit]').length === 7, '实际 ' + t.$$('[data-habit]').length);
  ok('新行为已持久化', JSON.parse(t.storage._m.get('little-star-planet-v1')).habits.length === 7);

  // 空名称必须拦截
  t.$('#addHabitBtn').onclick();
  t.$('#recordNote').value = '   ';
  t.$('#confirmDialog').onclick();
  ok('空名称被拦截，弹层不关闭', t.$('#recordDialog').hidden === false);
  t.$('#cancelDialog').onclick();
  ok('取消可关闭弹层', t.$('#recordDialog').hidden === true);

  // 删除愿望：不再依赖 confirm()
  t.$('#addWishBtn').onclick();
  t.$('#recordNote').value = '去海洋馆';
  t.$('#wishCost').value = '40';
  t.$('#confirmDialog').onclick();
  const wishCount = JSON.parse(t.storage._m.get('little-star-planet-v1')).wishes.length;
  ok('添加愿望成功（3+1）', wishCount === 4, String(wishCount));
  const del = t.$$('[data-delete-wish]')[0];
  ok('愿望列表渲染出删除按钮', t.$$('[data-delete-wish]').length === 4, '实际 ' + t.$$('[data-delete-wish]').length);
  del.onclick();
  ok('删除前弹出确认层', t.$('#askDialog').hidden === false);
  t.$('#askOk').onclick();
  ok('确认后愿望减少到 3', JSON.parse(t.storage._m.get('little-star-planet-v1')).wishes.length === 3);

  // 额外表扬 / 扣星
  t.$('#extraBtn').onclick();
  t.$('#recordNote').value = '主动分享玩具';
  t.$('#confirmDialog').onclick();
  ok('额外表扬 +1', t.$('#balance').textContent === '1', t.$('#balance').textContent);
  t.$('#deductBtn').onclick();
  t.$('#recordNote').value = '玩具没收好';
  t.$('#confirmDialog').onclick();
  ok('扣星 −1 后回到 0', t.$('#balance').textContent === '0', t.$('#balance').textContent);

  // 兑换愿望（余额不足应禁用）
  const redeem = t.$$('[data-wish]')[0];
  ok('余额不足时兑换按钮禁用', /disabled/.test(t.$('#wishList').innerHTML));
  ok('渲染许愿池余额', t.$('#poolBalance').textContent === '0', t.$('#poolBalance').textContent);

  // 统计 / 账本
  ok('账本渲染出 2 条记录', (t.$('#ledgerList').innerHTML.match(/class="entry"/g) || []).length === 2, t.$('#ledgerList').innerHTML.slice(0, 80));
  ok('统计图渲染 7 根柱子', (t.$('#chart').innerHTML.match(/bar-group/g) || []).length === 7);
  ok('统计页含 7 个习惯完成率行', (t.$('#habitStats').innerHTML.match(/class="setting"/g) || []).length === 7);
  ok('日期标题不依赖 Intl', /^\d{1,2}月\d{1,2}日 星期.$/.test(t.$('#dateLabel').textContent), t.$('#dateLabel').textContent);
  ok('无脚本报错条', t.$('#errbar').hidden === true);
  ok('自检提示在脚本跑完后自动隐藏', t.$('#bootFlag').hidden === true);
}

// ---- 3. 微信 file:// 场景 A：localStorage 抛错 ----
console.log('\n[3] 微信文件预览场景 A：localStorage 抛 SecurityError');
{
  const t = boot({ storage: 'throw', protocol: 'file:' });
  ok('脚本未崩溃', t.errors.length === 0, t.errors.join(' / '));
  ok('6 个预设项目依然渲染', t.$$('[data-habit]').length === 6, '实际 ' + t.$$('[data-habit]').length);
  ok('顶部显示环境警告', t.$('#envWarn').hidden === false);
  ok('设置页标记存储“不可用”', t.$('#storagePill').textContent === '不可用', t.$('#storagePill').textContent);
  ok('自检提示已隐藏（脚本完整跑完）', t.$('#bootFlag').hidden === true);
  t.$$('[data-habit]')[0].onclick();
  ok('无存储时仍可打卡（内存态）', t.$('#balance').textContent === '1', t.$('#balance').textContent);
  t.$('#goalBtn').onclick();
  ok('无存储时目标弹层仍可打开', t.$('#askDialog').hidden === false);
}

// ---- 4. 微信 file:// 场景 B：localStorage 为 null（Android WebView 未开 DOM storage）----
console.log('\n[4] 微信文件预览场景 B：window.localStorage === null');
{
  const t = boot({ storage: 'null', protocol: 'file:' });
  ok('脚本未崩溃', t.errors.length === 0, t.errors.join(' / '));
  ok('6 个预设项目依然渲染', t.$$('[data-habit]').length === 6, '实际 ' + t.$$('[data-habit]').length);
  ok('顶部显示环境警告', t.$('#envWarn').hidden === false);
  t.$('#addHabitBtn').onclick();
  t.$('#recordNote').value = '自己穿鞋';
  t.$('#confirmDialog').onclick();
  ok('无存储时仍能添加行为', t.$$('[data-habit]').length === 7, '实际 ' + t.$$('[data-habit]').length);
}

// ---- 5. 脏数据容错 ----
console.log('\n[5] 脏数据容错（localStorage 里存了坏数据）');
{
  const t = boot({ storage: 'ok', protocol: 'https:', seed: '{这不是合法JSON' });
  ok('坏 JSON 不导致崩溃', t.errors.length === 0, t.errors.join(' / '));
  ok('坏 JSON 回落到 6 个默认项目', t.$$('[data-habit]').length === 6, '实际 ' + t.$$('[data-habit]').length);
}
{
  const dirty = JSON.stringify({
    events: [null, 'x', { amount: 'NaN' }, { amount: 1, type: 'earn', title: '正常', date: new Date().toISOString(), icon: '<img src=x onerror=alert(1)>' }],
    goal: -5,
    wishes: [['🦁'], null, ['📚', '绘本', 'abc', 'x'], ['🎠', '游乐场', 50]],
    habits: [null, { name: '缺图标' }, 'string'],
  });
  const t = boot({ storage: 'ok', protocol: 'https:', seed: dirty });
  ok('脏数据不导致崩溃', t.errors.length === 0, t.errors.join(' / '));
  ok('非法 goal 回落为 20', t.$('#goalBtn').textContent === '20 ⭐', t.$('#goalBtn').textContent);
  ok('非法愿望被过滤，仅留 1 条', t.$$('[data-delete-wish]').length === 1, '实际 ' + t.$$('[data-delete-wish]').length);
  ok('缺失字段的行为被补全为 3 项', t.$$('[data-habit]').length === 3, '实际 ' + t.$$('[data-habit]').length);
  ok('图标里的 HTML 被转义', !/<img/.test(t.$('#actions').innerHTML) && /&lt;img/.test(t.$('#ledgerList').innerHTML), t.$('#ledgerList').innerHTML.slice(0, 120));
  const after = JSON.parse(t.storage._m.get('little-star-planet-v1'));
  ok('修复后的数据已回写', after.goal === 20 && after.habits.length === 3 && after.wishes.length === 1);
}

// ---- 6. 本地日期分组（修 UTC 导致“今天”的分界线落在早上 8 点）----
console.log('\n[6] 本地日期分组');
{
  const at = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const ev = (habit, title, hour) => ({ id: habit * 100 + hour, amount: 1, type: 'earn', title, icon: '⭐', note: '完成今日好习惯', habit, date: at(hour) });
  const seedWith = events => JSON.stringify({ events, goal: 20, wishes: [], habits: null });

  const a = boot({ storage: 'ok', protocol: 'https:', seed: seedWith([ev(4, '好好吃早饭', 7)]) });
  ok('脚本执行无异常', a.errors.length === 0, a.errors.join(' / '));
  ok('本地早上 7 点的打卡算作“今天”', a.$('#doneCount').textContent === '1 / 6 已完成', a.$('#doneCount').textContent);
  ok('早上 7 点的星星已计入余额', a.$('#balance').textContent === '1', a.$('#balance').textContent);
  ok('该项目显示为已完成', /取消完成/.test(a.$('#actions').innerHTML));
  const chart = a.$('#chart').innerHTML;
  const groups = chart.split('bar-group').slice(1); // 最后一组是“今天”
  ok('7 天柱状图渲染出 7 组', groups.length === 7, String(groups.length));
  ok('这次打卡落在最后一根（今天）柱子上', /height:25%/.test(groups[groups.length - 1] || ''), (groups[groups.length - 1] || '').slice(0, 90));
  ok('前一天那根柱子是空的', /height:5%/.test(groups[groups.length - 2] || ''), (groups[groups.length - 2] || '').slice(0, 90));
  ok('其余 6 天仍是空柱', (chart.match(/height:5%/g) || []).length === 6, String((chart.match(/height:5%/g) || []).length));
  ok('完成率按 1 天计', /好好吃早饭<\/b><small>本周 1 \//.test(a.$('#habitStats').innerHTML), a.$('#habitStats').innerHTML.slice(-220));

  // 同一本地日的早晨 + 上午两次打卡，只能算 1 天（改之前会被算成 2 天）
  const b = boot({ storage: 'ok', protocol: 'https:', seed: seedWith([ev(4, '好好吃早饭', 7), ev(4, '好好吃早饭', 9)]) });
  const hs = b.$('#habitStats').innerHTML;
  ok('同一本地日两次打卡仍算 1 天', /好好吃早饭<\/b><small>本周 1 \//.test(hs), hs.slice(-220));
  ok('没有出现虚高的“本周 2 天”', !/本周 2 \//.test(hs), hs.slice(-220));
  const rates = (hs.match(/<span class="pill">(\d+)%/g) || []).map(s => parseInt(s.replace(/\D/g, ''), 10));
  ok('完成率均不超过 100%', rates.length > 0 && rates.every(r => r <= 100), JSON.stringify(rates));
}

console.log('\n=================================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
