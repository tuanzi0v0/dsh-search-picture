/**
 * Wikimedia Commons 图源自测：
 *   1. 解析器的边界（空 body、非 JSON、缺 pages、缺 imageinfo）；
 *   2. 授权字段必须带出来（`LicenseShortName` / `Artist`）——这是这个源存在的理由；
 *   3. 只收位图：svg/gif/tiff 被排除；标题的 `File:` 前缀被剥掉；
 *   4. 真实检索能返回候选，且**原图直链可下载**（缩略图域名实测被拒，所以只用原图）；
 *   5. 端到端：`search_picture` 的 images 条目带 license/artist，notes 里点名授权。
 *
 * ⚠️ 第 4、5 项会真实联网下载数 MB 原图，属于 e2e 检查，不是纯单测。
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadCandidates } from '../src/download.js';
import { runSearch } from '../src/host.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { engineLabel, parseCommonsJson, runEngine } from '../src/providers.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

/** 构造一条最小的 generator=search 响应。 */
const page = (overrides = {}) => ({
  title: 'File:Example photo.jpg',
  index: 1,
  imageinfo: [{
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_photo.jpg',
    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example_photo.jpg',
    width: 3000,
    height: 2000,
    mime: 'image/jpeg',
    extmetadata: {
      LicenseShortName: { value: 'CC BY 4.0' },
      Artist: { value: '<a href="https://example.org">Jane Doe</a>' },
    },
  }],
  ...overrides,
});

console.log('== 1. 解析器边界 ==');
{
  check('空 body → 空数组', parseCommonsJson('').length === 0);
  check('空白 body → 空数组', parseCommonsJson('  \n ').length === 0);
  check('非 JSON → 空数组', parseCommonsJson('<html>Wikimedia Error</html>').length === 0);
  check('缺 query → 空数组', parseCommonsJson('{"batchcomplete":true}').length === 0);
  check('query 里缺 pages → 空数组', parseCommonsJson('{"query":{}}').length === 0);
  check('pages 为空对象 → 空数组', parseCommonsJson('{"query":{"pages":{}}}').length === 0);
  check('缺 imageinfo → 跳过', parseCommonsJson(JSON.stringify({ query: { pages: { 1: { title: 'File:x.jpg', index: 1 } } } })).length === 0);
  check('缺 url → 跳过', parseCommonsJson(JSON.stringify({
    query: { pages: { 1: { title: 'File:x.jpg', index: 1, imageinfo: [{ width: 2000, height: 2000, mime: 'image/jpeg' }] } } },
  })).length === 0);
}

console.log('\n== 2. 授权与作者（本源的核心价值） ==');
{
  const parsed = parseCommonsJson(JSON.stringify({ query: { pages: { 1: page() } } }));
  check('解析出 1 条', parsed.length === 1);
  check('engine 标记为 commons', parsed[0]?.engine === 'commons', parsed[0]?.engine);
  check('带出 license', parsed[0]?.license === 'CC BY 4.0', parsed[0]?.license);
  check('artist 去掉了 HTML 标签', parsed[0]?.artist === 'Jane Doe', parsed[0]?.artist);
  check('宽高解析为数字', parsed[0]?.width === 3000 && parsed[0]?.height === 2000);
  check('出处是 descriptionurl', String(parsed[0]?.pageUrl).startsWith('https://commons.wikimedia.org/wiki/File:'), parsed[0]?.pageUrl);
  check('标题剥掉了 File: 前缀', parsed[0]?.title === 'Example photo', parsed[0]?.title);

  // 授权缺失时不能编造：必须是 undefined，由上层显示「未标注」。
  const noLicense = parseCommonsJson(JSON.stringify({
    query: { pages: { 1: page({ imageinfo: [{ url: 'https://upload.wikimedia.org/a.jpg', width: 2000, height: 2000, mime: 'image/jpeg', extmetadata: {} }] }) } },
  }));
  check('缺 extmetadata 时 license 是 undefined（不臆造）', noLicense[0]?.license === undefined, String(noLicense[0]?.license));
}

console.log('\n== 3. 只收位图 ==');
{
  for (const mime of ['image/svg+xml', 'image/gif', 'image/tiff']) {
    const one = parseCommonsJson(JSON.stringify({
      query: { pages: { 1: page({ imageinfo: [{ url: 'https://upload.wikimedia.org/x', width: 2000, height: 2000, mime }] }) } },
    }));
    check(`${mime} 被排除`, one.length === 0, String(one.length));
  }
  const png = parseCommonsJson(JSON.stringify({
    query: { pages: { 1: page({ imageinfo: [{ url: 'https://upload.wikimedia.org/x.png', width: 2000, height: 2000, mime: 'image/png' }] }) } },
  }));
  check('image/png 保留（视频底图可用）', png.length === 1, String(png.length));
}

console.log('\n== 4. 真实检索 + 原图可下载 ==');
const query = 'Zelenskyy Trump White House meeting';
const result = await runEngine('commons', query, { timeoutMs: 25000 });
console.log(`  query="${query}" → 候选 ${String(result.candidates.length)} 条，error=${result.error ?? '-'}`);
check('返回候选', result.candidates.length > 0, result.error ?? '');
check('候选都标记为 commons', result.candidates.every((c) => c.engine === 'commons'));
if (result.candidates.length > 0) {
  check('候选都带 license', result.candidates.every((c) => typeof c.license === 'string' && c.license !== ''),
    String(result.candidates.filter((c) => c.license === undefined).length));
  const first = result.candidates[0];
  console.log(`    首条：${String(first.width)}x${String(first.height)} ${first.license ?? '?'} ${first.imageUrl.slice(0, 70)}`);
  check('首条原图直链指向 upload.wikimedia.org', first.imageUrl.includes('upload.wikimedia.org'), first.imageUrl.slice(0, 60));
  check('display 名可读', engineLabel('commons').includes('Commons'));
}

console.log('\n== 5. 下载并保留授权字段 ==');
const outDir = join(process.cwd(), '.work', 'commons-downloads');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
{
  const { files } = await downloadCandidates(result.candidates, {
    directory: outDir,
    query: 'commons-test',
    count: 2,
    minPixels: 921600,
    minLongEdge: 1000,
    maxAspectRatio: 2.6,
    minBytes: 4096,
    concurrency: 2,
    timeoutMs: 60000,
  });
  console.log(`  下载成功 ${String(files.length)} 张`);
  check('至少下到 1 张', files.length > 0, String(files.length));
  for (const file of files) {
    check(`${file.fileName} 保留了 license`, typeof file.license === 'string' && file.license !== '', String(file.license));
    check(`${file.fileName} 是有效图片`, sniffImageMediaType(new Uint8Array(await (await import('node:fs/promises')).readFile(file.path))) !== undefined);
  }
}

console.log('\n== 6. 端到端：search_picture 的 images 带授权、notes 点名授权 ==');
{
  const root = join(process.cwd(), '.work', 'commons-host');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const attachments = [];
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
        if (mediaType === undefined) throw Object.assign(new Error('bad'), { code: 'INVALID_IMAGE' });
        const size = imageSize(input.data, mediaType);
        const ref = { attachmentId: `a-${String(attachments.length + 1)}`, mediaType, bytes: input.data.byteLength, width: size?.width ?? 0, height: size?.height ?? 0 };
        attachments.push(ref);
        return ref;
      },
    },
  };
  const config = {
    directory: 'downloads', count: 3, minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 2.6,
    minBytes: 4096, maxBytes: 16 * 1024 * 1024, concurrency: 3, fetchTimeoutMs: 60000, searchTimeoutMs: 25000,
    // 关掉其它源，确保断言只反映 Commons 的行为。
    officialSite: false, safebooru: false, relatedSites: [], commons: true,
  };
  // 四路默认引擎照常跑（无法单独关），但断言只针对 commons 条目。
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };
  const value = await runSearch(ctx, config, { query, count: 3 }, exec);
  const byEngine = {};
  for (const image of value.images) byEngine[image.engine] = (byEngine[image.engine] ?? 0) + 1;
  console.log(`  候选 ${String(value.images.length)} 张，来源分布 ${JSON.stringify(byEngine)}`);
  console.log(`  searched：${value.searched.map((s) => `${s.engine}=${String(s.found)}`).join(', ')}`);

  check('commons 出现在 searched 里', value.searched.some((s) => s.engine === 'commons'), JSON.stringify(value.searched.map((s) => s.engine)));
  check('notes 提到 Wikimedia Commons 与授权', value.notes.includes('Commons') && value.notes.includes('授权'), value.notes.slice(0, 120));
  const commonsImages = value.images.filter((image) => image.engine === 'commons');
  if (commonsImages.length > 0) {
    check('images 条目带 license 字段', commonsImages.every((image) => typeof image.license === 'string'), JSON.stringify(commonsImages.map((i) => i.license)));
    console.log(`  预览区：${value.previewFolder}`);
  } else {
    console.log('  （本轮 Commons 未进入最终候选，跳过 images 字段断言）');
  }
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
