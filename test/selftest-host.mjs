/**
 * Host 半集成自测：真实搜索/下载逻辑 + 替身的 DSH 服务，覆盖完整的两步流程：
 *
 *   1. `search_picture` → 结果落在**预览区**，相册**此时不应被写入**；
 *   2. `save_pictures`  → 认可的图**平铺写入相册**（复制，不是移动）、丢弃项被删、
 *      未选项留在预览区；
 *   3. 边界：keep 用序号、未知文件名、空 keep、预览区已空、重复确认。
 *
 * 相册默认是 `%USERPROFILE%\Pictures`（工作区之外），测试里把它指向工作区内的临时目录，
 * 这样既能真实跑文件读写，又不会污染用户的系统图片文件夹。
 *
 * 另外校验输出形状仍是「无损 JSON」（DSH 会做快照，出现 undefined 就整次失败）。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ensureDirectory, formatPromoteOutput, formatSearchOutput, runPromote, runSearch } from '../src/host.js';
import { listStaged, resolveStaging, STAGING_DIRNAME } from '../src/library.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

const root = join(process.cwd(), '.work', 'hosttest-downloads');
await rm(root, { recursive: true, force: true });
// 相册替身目录：每次测试都清空，保证「重名追加序号」这类断言可复现。
const albumRoot = join(process.cwd(), '.work', 'hosttest-album');
await rm(albumRoot, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// ---- ctx 替身 -------------------------------------------------------------
const attachments = [];
const ctx = {
  fs: {
    async resolve(path, options = {}) {
      const base = options.cwd ?? process.cwd();
      const full = /^[A-Za-z]:[\\/]/.test(path) ? path : join(base, path);
      return { displayPath: full, targetKey: full };
    },
    processPath(target) {
      return target.displayPath;
    },
    async readBytes(target) {
      const { readFile: read } = await import('node:fs/promises');
      return new Uint8Array(await read(target.displayPath));
    },
  },
  attachments: {
    async saveImage(input) {
      const mediaType = sniffImageMediaType(input.data);
      if (mediaType === undefined) {
        const error = new Error('not an image');
        error.code = 'INVALID_IMAGE';
        throw error;
      }
      const size = imageSize(input.data, mediaType);
      const ref = {
        attachmentId: `att-${String(attachments.length + 1)}`,
        mediaType,
        bytes: input.data.byteLength,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      attachments.push(ref);
      return ref;
    },
  },
};

const config = {
  directory: 'downloads',
  count: 4,
  minPixels: 921600,
  minLongEdge: 1000,
  maxAspectRatio: 2.6,
  minBytes: 4096,
  maxBytes: 12 * 1024 * 1024,
  concurrency: 6,
  fetchTimeoutMs: 30000,
  searchTimeoutMs: 20000,
  // 官网通路有独立专项测试（selftest-official.mjs）；这里关掉，让候选取样稳定
  // ——官网首页的图会随时间变化。
  officialSite: false,
  // 相册指向测试替身目录，避免污染用户的系统图片文件夹。
  album: albumRoot,
  albumName: 'dsh-search-picture',
};

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };

console.log('== 1. search_picture：结果只进预览区 ==');
const value = await runSearch(ctx, config, { query: '可塑性记忆 艾拉' }, exec);
console.log(`  预览区=${value.previewFolder}`);
console.log(`  正式目录=${value.targetFolder}（应为不存在的路径）`);
console.log(`  图片=${String(value.images.length)} 张`);
for (const image of value.images) {
  console.log(`    - ${image.fileName} ${String(image.width)}x${String(image.height)} ${String(image.bytes)}B ${image.engine}`);
}

check('返回了候选图片', value.images.length > 0, String(value.images.length));
check('预览区在下载根目录的暂存区下', value.previewFolder.startsWith(join(root, 'downloads', STAGING_DIRNAME)), value.previewFolder);
check('写入目标是相册（不再是按请求命名的子文件夹）', value.targetFolder === join(albumRoot, config.albumName), value.targetFolder);
check('所有图片都落在预览区', value.images.every((image) => image.path.startsWith(value.previewFolder)));
check('清晰度都 ≥ 720p（921600 px²）', value.images.every((image) => (image.width ?? 0) * (image.height ?? 0) >= 921600),
  JSON.stringify(value.images.map((i) => `${String(i.width)}x${String(i.height)}`)));
check('长宽比都在上限内', value.images.every((image) => {
  const long = Math.max(image.width ?? 0, image.height ?? 0);
  const short = Math.min(image.width ?? 0, image.height ?? 0);
  return short === 0 || long / short <= 2.6;
}));
check('每张都有附件（模型能看到图）', value.images.every((image) => image.attachment !== undefined));
check('每张都有 hotlinkFriendly 标记', value.images.every((image) => typeof image.hotlinkFriendly === 'boolean'));

// 关键断言：相册在用户确认前不能被写入。
let albumExists = true;
try {
  await stat(value.targetFolder);
} catch {
  albumExists = false;
}
check('确认前相册目录不存在', !albumExists, value.targetFolder);
// 搜索阶段不应在 downloads 下留下任何按请求命名的子文件夹。
let legacyFolderExists = true;
try {
  await stat(join(root, 'downloads', value.folderName));
} catch {
  legacyFolderExists = false;
}
check('没有按请求命名建文件夹（不建文件）', !legacyFolderExists, join(root, 'downloads', value.folderName));

// 预览清单应当写进预览区，且列出全部候选。
const manifest = await readFile(join(value.previewFolder, 'STAGING.md'), 'utf8');
check('预览区有清单文件 STAGING.md', manifest.includes('待确认图片'), manifest.slice(0, 60));
check('清单列出每一张候选', value.images.every((image) => manifest.includes(image.fileName)));
check('清单标出「待确认」状态', manifest.includes('待确认'));

console.log('\n== 2. 输出形状：无损 JSON（DSH 会快照） ==');
{
  const serialized = JSON.stringify(value);
  check('JSON.stringify 成功', typeof serialized === 'string');
  check('往返后深度相等', JSON.stringify(JSON.parse(serialized)) === serialized);
  const flat = (node, path = '$') => {
    if (Array.isArray(node)) return node.flatMap((item, index) => flat(item, `${path}[${String(index)}]`));
    if (node !== null && typeof node === 'object') return Object.entries(node).flatMap(([key, v]) => flat(v, `${path}.${key}`));
    return node === undefined ? [path] : [];
  };
  check('没有 undefined 字段', flat(value).length === 0, flat(value).join(', '));
  const text = formatSearchOutput(value);
  check('文本提示「只在预览区」', text.includes('预览区') && text.includes('下一步'));
  check('文本给出相册路径', text.includes(value.targetFolder));
  check('文本不再要求指定 folder', !/folder 用/.test(text), text.slice(text.indexOf('【下一步】'), text.indexOf('【下一步】') + 120));
}

console.log('\n== 3. save_pictures：按序号写入相册 ==');
{
  const stagedBefore = await listStaged(value.previewFolder);
  console.log(`  预览区文件：${stagedBefore.join(', ')}`);
  const keepIndex = stagedBefore.length >= 2 ? ['1', `#${String(stagedBefore.length)}`] : ['1'];
  const expected = keepIndex.map((raw) => stagedBefore[Number(raw.replace('#', '')) - 1]);
  const keepNames = [...new Set(expected)];

  const promoted = await runPromote(ctx, config, {
    previewFolder: value.previewFolder,
    sourceFolder: value.sourceFolder,
    keep: keepIndex,
    discard: stagedBefore.filter((name) => !keepNames.includes(name)),
  }, exec);

  console.log(`  写入相册：${promoted.saved.map((entry) => entry.fileName).join(', ')}`);
  console.log(`  删除：${promoted.discarded.join(', ')}`);
  console.log(`  失败：${JSON.stringify(promoted.failures)}`);
  console.log(`  备注：${promoted.notes}`);

  check('保留项数量正确', promoted.saved.length === keepNames.length, `${String(promoted.saved.length)} vs ${String(keepNames.length)}`);
  check('写入目标是相册目录（不是按请求命名的子文件夹）', promoted.targetFolder === join(albumRoot, config.albumName), promoted.targetFolder);
  check('相册内没有子文件夹，图是平铺的', promoted.saved.every((entry) => dirname(entry.path) === promoted.targetFolder), JSON.stringify(promoted.saved.map((e) => e.path)));
  check('文件真的写进了相册且字节一致', (await Promise.all(promoted.saved.map(async (entry) => (await stat(entry.path)).size === entry.bytes))).every(Boolean));
  // 相册是「复制」而不是「移动」：确认过的图仍留在预览区，用户改主意时还能再要。
  check('写入后原图仍留在预览区（复制而非移动）', (await Promise.all(promoted.saved.map(async (entry) => {
    try {
      await stat(join(value.previewFolder, entry.fileName));
      return true;
    } catch {
      return false;
    }
  }))).every(Boolean));
  check('丢弃项确实被删', (await Promise.all(promoted.discarded.map(async (name) => {
    try {
      await stat(join(value.previewFolder, name));
      return false;
    } catch {
      return true;
    }
  }))).every(Boolean));
  check('备注给出相册路径', promoted.notes.includes(albumRoot), promoted.notes);
  const promoteText = formatPromoteOutput(promoted);
  check('结果文本给出相册路径', promoteText.includes(promoted.targetFolder));
  // 输出必须严格符合 index.js 里的 PROMOTE_SCHEMA：多一个字段 DSH 就会拒绝整个结果，
  // 少一个必填字段同样。这里用键集合对齐来防止再次出现「多塞了一个字段」。
  const promoteKeys = Object.keys(promoted).sort();
  check('输出字段与 schema 完全一致', JSON.stringify(promoteKeys) === JSON.stringify(['discarded', 'failures', 'folderName', 'notes', 'saved', 'targetFolder']), JSON.stringify(promoteKeys));
}

console.log('\n== 4. 边界：未知文件名 / 空 keep / 预览区已空 ==');
{
  // 4a. 未知文件名要被如实报告，而不是静默忽略。
  const batchDir = join(root, 'downloads', STAGING_DIRNAME, 'edge-1');
  await mkdir(batchDir, { recursive: true });
  await writeFile(join(batchDir, 'a-01.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
  const promoted = await runPromote(ctx, config, {
    previewFolder: batchDir,
    sourceFolder: join(root, 'downloads'),
    folder: '边界测试',
    keep: ['a-01.jpg', '不存在.jpg'],
  }, exec);
  check('存在的文件被移入', promoted.saved.length === 1, JSON.stringify(promoted.saved));
  check('不存在的文件被报告为失败', promoted.failures.length === 1 && promoted.failures[0].file === '不存在.jpg', JSON.stringify(promoted.failures));

  // 4b. 空 keep 不做任何改动。
  const batchDir2 = join(root, 'downloads', STAGING_DIRNAME, 'edge-2');
  await mkdir(batchDir2, { recursive: true });
  await writeFile(join(batchDir2, 'b-01.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
  const empty = await runPromote(ctx, config, {
    previewFolder: batchDir2,
    sourceFolder: join(root, 'downloads'),
    folder: '空测试',
    keep: [],
  }, exec);
  check('空 keep 不移动任何文件', empty.saved.length === 0 && empty.failures.length === 1, JSON.stringify(empty));
  check('空 keep 时预览区文件仍在', (await exists(join(batchDir2, 'b-01.jpg'))));

  // 4c. 相册流程是「复制」：确认过的图仍留在预览区，所以还能再确认一次；
  //     并且相册里重名会追加序号，绝不覆盖已有图片。
  const again = await runPromote(ctx, config, {
    previewFolder: value.previewFolder,
    sourceFolder: join(root, 'downloads'),
    keep: ['1'],
  }, exec);
  check('确认过的图仍在预览区，可以再次确认', again.saved.length === 1, JSON.stringify(again.notes));
  const firstAlbumName = value.images[0].fileName.replace(/(\.[^.]+)$/, '');
  check('相册内重名自动追加序号（不覆盖原图）', existsSync(join(albumRoot, config.albumName, `${firstAlbumName}-2.jpg`))
    || (await readdir(join(albumRoot, config.albumName))).some((name) => name.includes('-2')), JSON.stringify((await readdir(join(albumRoot, config.albumName)))));

  // 4d. 预览区根本不存在时，给出明确说明而不是抛异常。
  const missing = await runPromote(ctx, config, {
    previewFolder: join(root, 'downloads', STAGING_DIRNAME, 'does-not-exist'),
    sourceFolder: join(root, 'downloads'),
    keep: ['1'],
  }, exec);
  check('预览区不存在时给出明确说明', missing.saved.length === 0 && missing.notes.includes('没有可确认'), JSON.stringify(missing.notes));
}

console.log('\n== 5. 目录解析：相对/绝对/批次 id ==');
{
  const downloadsRoot = await ensureDirectory({ fs: ctx.fs, workspaceRoot: root }, 'downloads', exec.signal);
  check('相对目录解析到会话工作区下', downloadsRoot === join(root, 'downloads'), downloadsRoot);
  check('批次 id 解析到暂存区下', resolveStaging(downloadsRoot, 'abc123') === join(downloadsRoot, STAGING_DIRNAME, 'abc123'));
  check('绝对路径原样使用', resolveStaging(downloadsRoot, value.previewFolder) === value.previewFolder);
  check('.staging 相对路径不重复拼接', resolveStaging(downloadsRoot, `${STAGING_DIRNAME}/x`) === join(downloadsRoot, STAGING_DIRNAME, 'x'));
}

console.log('\n== 6. index.js 关键常量 ==');
{
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const hostSource = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  check('host.js 定义 TOOL_NAME = search_picture', /export const TOOL_NAME = 'search_picture';/u.test(hostSource));
  check('index.js 注册 save_pictures', source.includes("name: 'save_pictures'"));
  check('index.js 保留搜索工具用 TOOL_NAME', source.includes('name: TOOL_NAME'));
  check('清晰度门槛默认 921600（720p）', source.includes('minPixels: z.number().default(921600)'));
  check('Client 半用同样的 key', readFileSync(new URL('../client.js', import.meta.url), 'utf8').includes("key: 'search_picture'"));
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
