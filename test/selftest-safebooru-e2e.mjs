/**
 * 任务 2：自测「能否从 Safebooru 真实下载到图片」——而且要走**完整流程**：
 *   图源检索 → 清晰度筛选 → 落盘 → 内容可读 → 写入相册。
 *
 * 不只是「HTTP 200」就算通过：要真的解码出尺寸、核对字节、并让图片可被读出来看。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadCandidates } from '../src/download.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { runEngine } from '../src/providers.js';
import { saveToAlbum } from '../src/library.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

const work = join(process.cwd(), '.work', 'safebooru-e2e');
await rm(work, { recursive: true, force: true });
const staging = join(work, 'staging');
const album = join(work, 'album');
await mkdir(staging, { recursive: true });

console.log('== 1. Safebooru 检索（真实网络请求） ==');
const TAG = 'no_game_no_life';
const result = await runEngine('safebooru', TAG, { timeoutMs: 25000 });
console.log(`  tags=${TAG} → 候选 ${String(result.candidates.length)} 条，error=${result.error ?? '-'}`);
check('检索返回候选', result.candidates.length > 0, result.error ?? '');
check('候选都标记为 safebooru 引擎', result.candidates.every((c) => c.engine === 'safebooru'));
check('候选都带图片直链与出处页', result.candidates.every((c) => typeof c.imageUrl === 'string' && c.imageUrl.startsWith('http') && typeof c.pageUrl === 'string'));

console.log('\n== 2. 下载（走 downloadCandidates：含清晰度门槛与三重校验） ==');
const { files, failures } = await downloadCandidates(result.candidates, {
  directory: staging,
  query: 'ngnl',
  count: 3,
  minPixels: 921600,
  minLongEdge: 1000,
  maxAspectRatio: 3.0,
  minBytes: 4096,
  concurrency: 3,
  timeoutMs: 30000,
});
console.log(`  成功 ${String(files.length)} 张，失败/淘汰 ${String(failures.length)} 条`);
for (const failure of failures.slice(0, 3)) console.log(`    - ${failure.reason}`);
check('真的下载到了图片', files.length > 0, String(files.length));

console.log('\n== 3. 落盘文件校验（字节 + 格式 + 尺寸 + 可读性） ==');
for (const file of files) {
  const info = await stat(file.path);
  const bytes = new Uint8Array(await readFile(file.path));
  const mediaType = sniffImageMediaType(bytes);
  const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
  const ok = info.size === file.bytes
    && mediaType !== undefined
    && size !== undefined
    && size.width === file.width
    && size.height === file.height
    && (file.width ?? 0) * (file.height ?? 0) >= 921600;
  check(
    `${file.fileName}  ${String(file.width)}x${String(file.height)}  ${String(Math.round(file.bytes / 1024))}KB`,
    ok,
    `stat=${String(info.size)} vs ${String(file.bytes)}；解码=${size === undefined ? '失败' : `${String(size.width)}x${String(size.height)}`}`,
  );
}

console.log('\n== 4. 写入相册（复用 saveToAlbum，端到端最后一步） ==');
{
  const before = await readdir(staging);
  const saved = await saveToAlbum({ stagingDir: staging, albumDir: album, keep: files.map((f) => f.fileName) });
  console.log(`  写入 ${String(saved.saved.length)} 张 → ${album}`);
  for (const failure of saved.failures) console.log(`    - ${failure.file}: ${failure.reason}`);
  check('全部写入成功', saved.saved.length === files.length, JSON.stringify(saved.failures));
  check('相册目录里确实是平铺的图片', (await readdir(album)).length === files.length, JSON.stringify(await readdir(album)));
  // 与源文件逐字节比对（用 sha256，确认复制无损）
  const intact = [];
  for (const entry of saved.saved) {
    const a = createHash('sha256').update(await readFile(entry.path)).digest('hex');
    const b = createHash('sha256').update(await readFile(join(staging, entry.fileName))).digest('hex');
    intact.push(a === b);
  }
  check('相册文件与预览区逐字节一致（无损复制）', intact.every(Boolean), `${String(intact.filter(Boolean).length)}/${String(intact.length)}`);
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
