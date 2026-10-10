/**
 * 用与 DSH 同构的规则校验 search_picture / save_pictures 的输出是否符合 index.js 里声明的 schema。
 *
 * 动机：如果输出违反 schema，DSH 会抛 INVALID_TOOL_OUTPUT，整次调用失败——那种情况下
 * 既不会有图片块也不会有卡片，表现为「什么都没出现」。这个检查把这条可能性排除掉。
 *
 * 校验器覆盖 DSH enforced JSON Schema 子集的全部约束：type、properties、required、
 * additionalProperties、items、enum、const、oneOf。
 */
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

// ---- 校验器（镜像 DSH 的子集语义） -----------------------------------------
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function validate(schema, value, path = '$') {
  const violations = [];
  if (schema.oneOf !== undefined) {
    const hits = schema.oneOf.filter((branch) => validate(branch, value, path).length === 0);
    if (hits.length !== 1) violations.push(`${path}: oneOf matched ${String(hits.length)} branches`);
    return violations;
  }
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path}: const mismatch`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) violations.push(`${path}: not in enum`);
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const ok = schema.type === 'number' ? actual === 'number' || actual === 'integer' : actual === schema.type;
    if (!ok) {
      violations.push(`${path}: expected ${schema.type}, got ${actual}`);
      return violations;
    }
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: required but missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key}: additional property not allowed`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) violations.push(...validate(child, value[key], `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => violations.push(...validate(schema.items, item, `${path}[${String(index)}]`)));
  }
  return violations;
}

// ---- 从 index.js 里取回 schema（真源，不复制粘贴） ---------------------------
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
console.log('== schema 声明体检 ==');
const checks = [
  ['minPixels 默认 921600（720p 保底）', source.includes('minPixels: z.number().default(921600)')],
  ['minLongEdge 默认 1000', source.includes('minLongEdge: z.number().default(1000)')],
  ['maxAspectRatio 默认 2.6', source.includes('maxAspectRatio: z.number().default(2.6)')],
  ['注册 search_picture', source.includes('name: TOOL_NAME')],
  ['注册 save_pictures', source.includes("name: 'save_pictures'")],
  ['save_pictures 有 keep 必填数组', /keep: \{\s*type: 'array',\s*required: true/.test(source)],
  // 相册流程下 folder 已被弃用：必须**不是**必填，否则模型每次都被迫编一个文件夹名。
  ['save_pictures 的 folder 已弃用（非必填）', !/folder: \{\s*type: 'string',\s*required: true/.test(source)],
  ['配置里有相册目录 album', source.includes('album: z.string()')],
  ['配置里有相册子目录名 albumName', source.includes('albumName: z.string()')],
  ['输出声明 presentationMeta', source.includes('presentationMeta')],
];
for (const [label, ok] of checks) check(label, ok);

// 把 schema 字面量从源码里 eval 出来，保证校验用的是真源。
const literal = (name) => {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`找不到 ${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const from = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // eslint-disable-next-line no-eval
  return eval(`(${source.slice(from, index + 1)})`);
};

// OUTPUT_SCHEMA 里引用了 IMAGE_PROPERTIES，先把这段字面量取出来作为 eval 的额外绑定。
const imageProperties = literal('IMAGE_PROPERTIES');
const literalWith = (name, bindings) => {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`找不到 ${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const from = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const keys = Object.keys(bindings);
  const values = Object.values(bindings);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `return (${source.slice(from, index + 1)});`)(...values);
};

const OUTPUT_SCHEMA = literalWith('OUTPUT_SCHEMA', { IMAGE_PROPERTIES: imageProperties });
const PROMOTE_SCHEMA = literal('PROMOTE_SCHEMA');
console.log(`  （取到 OUTPUT_SCHEMA 键: ${Object.keys(OUTPUT_SCHEMA.properties).join(', ')}）`);

// ---- 用真实流程产出真实输出，再校验 ----------------------------------------
console.log('\n== 真实输出 vs schema ==');
const { mkdir, rm } = await import('node:fs/promises');
const { join } = await import('node:path');
const { runPromote, runSearch } = await import('../src/host.js');
const { sniffImageMediaType, imageSize } = await import('../src/image.js');

const root = join(process.cwd(), '.work', 'schema-check');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const ctx = {
  fs: {
    async resolve(path, options = {}) {
      const full = /^[A-Za-z]:[\\/]/.test(path) ? path : join(options.cwd ?? process.cwd(), path);
      return { displayPath: full, targetKey: full };
    },
    processPath: (target) => target.displayPath,
    async readBytes(target) {
      const { readFile } = await import('node:fs/promises');
      return new Uint8Array(await readFile(target.displayPath));
    },
  },
  attachments: {
    async saveImage(input) {
      const mediaType = sniffImageMediaType(input.data);
      if (mediaType === undefined) {
        const error = new Error('bad');
        error.code = 'INVALID_IMAGE';
        throw error;
      }
      const size = imageSize(input.data, mediaType);
      return { attachmentId: `a-${String(Math.random()).slice(2, 8)}`, mediaType, bytes: input.data.byteLength, width: size?.width ?? 0, height: size?.height ?? 0 };
    },
  },
};
const config = {
  directory: 'downloads', count: 3, minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 2.6,
  minBytes: 4096, maxBytes: 12 * 1024 * 1024, concurrency: 6, fetchTimeoutMs: 30000, searchTimeoutMs: 20000,
  // 关掉官网通路：本测试只关心输出形状，官网图片内容会随时间变化。
  officialSite: false,
  // 相册指向测试替身目录，避免写入用户的系统图片文件夹。
  album: join(root, 'album'),
  albumName: 'dsh-search-picture',
};
const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };

const search = await runSearch(ctx, config, { query: '可塑性记忆 艾拉' }, exec);
const searchViolations = validate(OUTPUT_SCHEMA, search);
check(`search_picture 输出符合 schema（${String(search.images.length)} 张图）`, searchViolations.length === 0, searchViolations.slice(0, 6).join('; '));

const promote = await runPromote(ctx, config, {
  previewFolder: search.previewFolder,
  sourceFolder: search.sourceFolder,
  folder: '可塑性记忆 艾拉',
  keep: ['1'],
  discard: search.images.slice(1).map((image) => image.fileName),
}, exec);
const promoteViolations = validate(PROMOTE_SCHEMA, promote);
check(`save_pictures 输出符合 schema（保留 ${String(promote.saved.length)}）`, promoteViolations.length === 0, promoteViolations.slice(0, 6).join('; '));

// 空结果分支也要过 schema。
const emptySearch = await runSearch(ctx, config, { query: 'zzz不存在的关键词zzz' }, exec);
check('空结果分支也符合 schema', validate(OUTPUT_SCHEMA, emptySearch).length === 0, validate(OUTPUT_SCHEMA, emptySearch).slice(0, 4).join('; '));

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
