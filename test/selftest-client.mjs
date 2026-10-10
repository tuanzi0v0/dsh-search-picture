/**
 * Client 半的离线自测（无浏览器）：
 *   1. client.js 语法可解析；
 *   2. `__ModuleLoader__.load({id, factory})` 用包名注册，工厂返回合法的 cordis 插件；
 *   3. `apply(ctx)` 在 `tool.call.toolview` 上用 key `search_picture` 注册了视图；
 *   4. 视图渲染函数在「运行中 / 有结果 / 空结果 / 元数据损坏」四种输入下都不抛错。
 *
 * 用最小 React 替身驱动渲染：只覆盖视图实际用到的 hook 与 `createElement`。
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

console.log('== client.js 装载 ==');
let registered;
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry;
    },
  },
};
// client.js 只引用全局 window / document 在组件内部使用，装载阶段不需要 document。
globalThis.window = fakeWindow;

await import('../client.js');

check('以包名注册模块', registered?.id === pkg.name, String(registered?.id));
check('factory 是函数', typeof registered?.factory === 'function');

// --- 最小 React 替身 -------------------------------------------------------
const hookState = [];
let hookCursor = 0;
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(initial) {
    const index = hookCursor;
    hookCursor += 1;
    if (hookState[index] === undefined) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], (next) => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next; }];
  },
  useEffect(effect) {
    const index = 1000 + hookCursor;
    hookCursor += 1;
    if (hookState[index] !== true) {
      hookState[index] = true;
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanup();
    }
    return undefined;
  },
  useRef(initial) {
    const index = 2000 + hookCursor;
    hookCursor += 1;
    hookState[index] ??= { current: initial };
    return hookState[index];
  },
};

const plugin = registered.factory((spec) => {
  if (spec === 'react') return ReactStub;
  throw new Error(`unexpected require(${spec})`);
});

check('插件导出 name', typeof plugin?.name === 'string', String(plugin?.name));
check('插件 inject 含 slots', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'));
check('插件导出 apply', typeof plugin?.apply === 'function');

// --- 用假 ctx 跑 apply -----------------------------------------------------
const registrations = [];
const fakeCtx = {
  get(service) {
    if (service === 'locale') return { getLocale: () => ({ id: 'zh-CN' }) };
    return undefined;
  },
  slots: {
    inject(name, register) {
      check(`inject 到 ${name}`, name === 'tool.call.toolview', name);
      // 真实的 slots 会驱动注册函数：普通函数直接调用，生成器则迭代到底
      // （插件用生成器注册多个 key，所以替身必须支持这种形态）。
      const outcome = register();
      if (outcome !== null && typeof outcome === 'object' && typeof outcome.next === 'function') {
        for (let step = outcome.next(); step.done !== true; step = outcome.next()) {
          if (step.value !== undefined && typeof step.value.then === 'function') throw new Error('替身不支持异步注册步骤');
        }
      }
    },
    register(options, View) {
      registrations.push({ options, View });
      return () => {};
    },
  },
};

plugin.apply(fakeCtx);
check('注册了 2 个视图（搜索 + 保存）', registrations.length === 2, String(registrations.length));
const searchView = registrations.find((entry) => entry.options?.key === 'search_picture');
const saveView = registrations.find((entry) => entry.options?.key === 'save_pictures');
check('视图 key = search_picture', searchView !== undefined, JSON.stringify(registrations.map((r) => r.options?.key)));
check('视图 key = save_pictures', saveView !== undefined, JSON.stringify(registrations.map((r) => r.options?.key)));
check('视图 name = tool.call.toolview', registrations.every((entry) => entry.options?.name === 'tool.call.toolview'));
check('视图都是组件函数', registrations.every((entry) => typeof entry.View === 'function'));

// --- 渲染多种输入 ----------------------------------------------------------
const View = searchView.View;
const SaveView = saveView.View;
const attachment = { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 1000, width: 1920, height: 1080 };

function render(props, component = View) {
  hookCursor = 0;
  return component(props);
}

/** 清空替身 hook 表：每次新渲染都应当像首次挂载一样重新执行 effect。 */
function resetHooks() {
  hookState.length = 0;
  hookCursor = 0;
}

/** 递归遍历渲染树；遇到函数组件就地求值，尽量贴近 React 的展开行为。 */
function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 40) return;
  if (typeof node === 'function') {
    hookCursor = 0;
    walk(node({}), visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (typeof node.type === 'function') {
    hookCursor = 0;
    walk(node.type({ ...(node.props ?? {}), children: node.children }), visit, depth + 1);
    return;
  }
  for (const child of node.children ?? []) walk(child, visit, depth + 1);
}

const cases = [
  ['运行中（无 meta）', { toolName: 'search_picture', phase: 'start', block: { args: { query: '可塑性记忆' } } }],
  ['有结果', { toolName: 'search_picture', phase: 'result', block: { args: { query: '可塑性记忆' }, meta: { query: '可塑性记忆', previewFolder: 'C:/ws/downloads/.staging/x', targetFolder: 'C:/ws/downloads/可塑性记忆 艾拉', folderName: '可塑性记忆 艾拉', images: [{ path: 'C:/ws/downloads/.staging/x/a-01.jpg', fileName: 'a-01.jpg', bytes: 200000, width: 1920, height: 1080, engine: 'bing', attachment }] } }, loadImage: () => Promise.resolve('blob:fake') }],
  ['空结果', { toolName: 'search_picture', phase: 'result', block: { args: { query: 'x' }, meta: { query: 'x', previewFolder: 'C:/ws/downloads/.staging/y', targetFolder: 'C:/ws/downloads/x', folderName: 'x', images: [] } }, loadImage: () => Promise.resolve('blob:fake') }],
  ['元数据损坏', { toolName: 'search_picture', phase: 'result', block: { meta: { images: 'not-an-array' } }, loadImage: undefined }],
  ['元数据缺附件', { toolName: 'search_picture', phase: 'result', block: { args: { query: 'y' }, meta: { query: 'y', previewFolder: '', targetFolder: '', folderName: '', images: [{ path: 'p.jpg', fileName: 'p.jpg' }] } }, loadImage: () => Promise.resolve('blob:fake') }],
];

for (const [label, props] of cases) {
  try {
    resetHooks();
    const tree = render(props);
    let nodes = 0;
    walk(tree, () => { nodes += 1; });
    check(`渲染「${label}」不抛错且产出 ${String(nodes)} 个节点`, nodes > 0);
  } catch (error) {
    check(`渲染「${label}」不抛错`, false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  }
}

// `save_pictures` 卡片的输入：正常、运行中、元数据损坏。
const saveCases = [
  ['保存结果', { toolName: 'save_pictures', block: { args: { folder: '可塑性记忆 艾拉', keep: ['1'] }, meta: { folderName: '可塑性记忆 艾拉', targetFolder: 'C:/ws/downloads/可塑性记忆 艾拉', saved: [{ fileName: 'a-01.jpg', path: 'C:/ws/downloads/可塑性记忆 艾拉/a-01.jpg', bytes: 314184 }], discarded: ['a-02.jpg'] } } }],
  ['保存运行中', { toolName: 'save_pictures', block: { args: { folder: 'x', keep: ['1'] } } }],
  ['保存元数据损坏', { toolName: 'save_pictures', block: { meta: { saved: 'nope' } } }],
  ['保存零结果', { toolName: 'save_pictures', block: { meta: { folderName: 'x', targetFolder: 'C:/ws/downloads/x', saved: [], discarded: [] } } }],
];

for (const [label, props] of saveCases) {
  try {
    resetHooks();
    const tree = render(props, SaveView);
    let nodes = 0;
    walk(tree, () => { nodes += 1; });
    check(`渲染「${label}」不抛错且产出 ${String(nodes)} 个节点`, nodes > 0);
  } catch (error) {
    check(`渲染「${label}」不抛错`, false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  }
}

// 有结果时：缩略图进入加载态（img 要等 loader 的 Promise 落地后才有 URL）。
{
  resetHooks();
  const tree = render(cases[1][1]);
  const tags = [];
  const texts = [];
  walk(tree, (node) => {
    if (typeof node.type === 'string') tags.push(node.type);
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  check('有结果时渲染出缩略图外框', tags.includes('button'), JSON.stringify(tags));
  check('有结果时渲染出加载占位', texts.includes('…'), JSON.stringify(texts));
}

// loader 的调用用一个独立探针确认：把视图单独渲染一次，统计 loader 入参。
{
  resetHooks();
  const calls = [];
  const probe = {
    toolName: 'search_picture',
    block: {
      args: { query: 'q' },
      meta: { query: 'q', directory: '', images: [{ path: 'p', fileName: 'p.jpg', attachment }] },
    },
    loadImage: (att) => {
      calls.push(att);
      return Promise.resolve('blob:x');
    },
  };
  const tree = render(probe);
  walk(tree, () => {});
  check('loadImage 以 attachment 被调用', calls.length === 1 && calls[0] === attachment, JSON.stringify(calls.map((c) => c?.attachmentId)));
}

// 运行中不应出现 img。
{
  const tree = render(cases[0][1]);
  const tags = [];
  walk(tree, (node) => { if (typeof node.type === 'string') tags.push(node.type); });
  check('运行中不渲染 img', !tags.includes('img'), JSON.stringify(tags));
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
