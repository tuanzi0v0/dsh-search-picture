/**
 * 自动清理预览区（`pruneStaging`）专项自测。
 *
 * 要证明的：
 *   1. 新搜索会清掉**历史批次**（用户的要求）；
 *   2. **当前批次绝不被删**（最关键的安全边界——否则会把用户正要看的候选清掉）；
 *   3. 只清「批次 id 形态」的目录，**其他名字的目录一律保留**（防误删）；
 *   4. 预览区不存在时不报错（首次搜索）；
 *   5. `autoCleanPreview: false` 时什么都不清。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { pruneStaging, STAGING_DIRNAME } from '../src/library.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

const root = join(process.cwd(), '.work', 'prune-check');
const staging = join(root, STAGING_DIRNAME);
await rm(root, { recursive: true, force: true });

/** 造一个「批次」目录，里面放一个假图片文件。 */
async function makeBatch(name, file = 'a.jpg') {
  const dir = join(staging, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
  await writeFile(join(dir, 'STAGING.md'), '# x', 'utf8');
  return dir;
}

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

console.log('== 1. 首次搜索：预览区还不存在 ==');
{
  const result = await pruneStaging(root, '20260101000000-aaaa');
  check('不报错，返回空', result.removed.length === 0 && result.kept.length === 0, JSON.stringify(result));
}

console.log('\n== 2. 清历史批次、保留当前批次 ==');
{
  const old1 = await makeBatch('20260101120000-aaaa');
  const old2 = await makeBatch('20260101130000-bbbb');
  const current = await makeBatch('20260101140000-cccc');
  const result = await pruneStaging(root, '20260101140000-cccc');
  check('删掉了 2 个历史批次', result.removed.length === 2, JSON.stringify(result.removed));
  check('当前批次被保留', result.kept.includes('20260101140000-cccc'), JSON.stringify(result.kept));
  check('历史批次目录已不存在', !(await exists(old1)) && !(await exists(old2)));
  check('当前批次目录仍在', await exists(current));
  check('当前批次里的图片没被动', await exists(join(current, 'a.jpg')));
}

console.log('\n== 3. 非批次 id 的目录一律保留（防误删） ==');
{
  await makeBatch('我的手工备份');
  await makeBatch('batch-1');
  await makeBatch('20260101120000-AAAA'); // 大写：不符合小写字母数字规则
  const result = await pruneStaging(root, '20260101140000-cccc');
  check('「我的手工备份」被保留', await exists(join(staging, '我的手工备份')));
  check('「batch-1」被保留', await exists(join(staging, 'batch-1')));
  check('大写随机串的目录被保留', await exists(join(staging, '20260101120000-AAAA')));
  check('本轮没有删任何东西', result.removed.length === 0, JSON.stringify(result.removed));
}

console.log('\n== 4. 顶层散落文件不动 ==');
{
  await writeFile(join(staging, 'loose.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]));
  await pruneStaging(root, '20260101140000-cccc');
  check('顶层散落的 loose.jpg 仍存在', await exists(join(staging, 'loose.jpg')));
}

console.log('\n== 5. 真实调用：search_picture 的自动清理（走 runSearch） ==');
{
  process.env.NODE_NO_WARNINGS = '1';
  const { runSearch } = await import('../src/host.js');
  const { imageSize, sniffImageMediaType } = await import('../src/image.js');

  const hostRoot = join(process.cwd(), '.work', 'prune-host');
  await rm(hostRoot, { recursive: true, force: true });

  const ctx = {
    fs: {
      async resolve(path, options = {}) {
        const base = options.cwd ?? process.cwd();
        return { displayPath: /^[A-Za-z]:[\\/]/.test(path) ? path : join(base, path), targetKey: '' };
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
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: hostRoot } } } };

  const baseConfig = {
    directory: 'downloads', count: 3, minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 2.6,
    minBytes: 4096, maxBytes: 12 * 1024 * 1024, concurrency: 6, fetchTimeoutMs: 30000, searchTimeoutMs: 20000,
    officialSite: false, safebooru: false, album: join(hostRoot, 'album'), albumName: 'x',
    autoCleanPreview: true,
  };

  // 先人为造两个「旧批次」，再跑一次真实搜索，看它们是否被清掉。
  const hostStaging = join(hostRoot, 'downloads', STAGING_DIRNAME);
  await mkdir(join(hostStaging, '20260101120000-aaaa'), { recursive: true });
  await writeFile(join(hostStaging, '20260101120000-aaaa', 'old.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  await mkdir(join(hostStaging, '20260101130000-bbbb'), { recursive: true });

  const value = await runSearch(ctx, baseConfig, { query: '可塑性记忆 艾拉' }, exec);
  const remaining = await readdir(hostStaging);
  check('搜索后旧批次 20260101120000-aaaa 已被清', !remaining.includes('20260101120000-aaaa'), JSON.stringify(remaining));
  check('搜索后旧批次 20260101130000-bbbb 已被清', !remaining.includes('20260101130000-bbbb'), JSON.stringify(remaining));
  check('本次批次仍在', remaining.includes(value.previewFolder.split('\\').pop()), JSON.stringify(remaining));
  check('备注里告知了自动清理', value.notes.includes('自动清理'), value.notes);
  check('本次候选正常返回', value.images.length > 0, String(value.images.length));

  // autoCleanPreview: false 时不清。
  await mkdir(join(hostStaging, '20260101150000-dddd'), { recursive: true });
  await runSearch(ctx, { ...baseConfig, autoCleanPreview: false, count: 2 }, { query: '可塑性记忆 艾拉' }, exec);
  const remaining2 = await readdir(hostStaging);
  check('autoCleanPreview=false 时旧批次被保留', remaining2.includes('20260101150000-dddd'), JSON.stringify(remaining2));
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
