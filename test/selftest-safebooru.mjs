/**
 * Safebooru 图源自测：
 *   1. 解析器的边界（空 body、非 JSON、非数组、缺字段）——实测空结果就是空 body；
 *   2. 真实标签检索能返回候选，且图片可下载、≥720p；
 *   3. 反例守卫：带空格的自然语言标签必须得到「0 结果而不是噪声」；
 *   4. 端到端：`search_picture` 带 tags 时 Safebooru 真的进了候选并落到预览区。
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadCandidates } from '../src/download.js';
import { runSearch } from '../src/host.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { parseSafebooruJson, runEngine } from '../src/providers.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

console.log('== 1. 解析器边界 ==');
{
  check('空 body → 空数组（实测无结果就是空 body）', parseSafebooruJson('').length === 0);
  check('空白 body → 空数组', parseSafebooruJson('   \n ').length === 0);
  check('非 JSON → 空数组', parseSafebooruJson('<html>error</html>').length === 0);
  check('JSON 对象（非数组）→ 空数组', parseSafebooruJson('{"a":1}').length === 0);
  check('null 行被跳过', parseSafebooruJson('[null,{"file_url":"https://safebooru.org/images/1/a.jpg","width":"1200","height":"800","tags":"1girl test","id":42}]').length === 1);
  const parsed = parseSafebooruJson(JSON.stringify([{
    file_url: '//safebooru.org/images/1/a.jpg',
    sample_url: 'https://safebooru.org/samples/1/sample_a.jpg',
    width: 3000,
    height: 6000,
    tags: '1girl absurdres isla_(plastic_memories) blue_eyes',
    id: 7165118,
  }]));
  check('协议相对 file_url 被补全', parsed[0]?.imageUrl === 'https://safebooru.org/images/1/a.jpg', parsed[0]?.imageUrl);
  check('宽高解析为数字', parsed[0]?.width === 3000 && parsed[0]?.height === 6000);
  check('出处指向图片详情页', parsed[0]?.pageUrl === 'https://safebooru.org/index.php?page=post&s=view&id=7165118', parsed[0]?.pageUrl);
  check('标题取前几个标签', parsed[0]?.title === '1girl absurdres isla_(plastic_memories) blue_eyes', parsed[0]?.title);
  check('没有 file_url 的行被跳过', parseSafebooruJson(JSON.stringify([{ id: 1, tags: 'x' }])).length === 0);
}

console.log('\n== 2. 真实标签检索 ==');
const tags = 'isla_(plastic_memories)';
const result = await runEngine('safebooru', tags, { timeoutMs: 25000 });
console.log(`  tags="${tags}" → 候选 ${String(result.candidates.length)} 条，error=${result.error ?? '-'}`);
check('返回候选', result.candidates.length > 0, result.error ?? '');
check('候选都标记为 safebooru', result.candidates.every((c) => c.engine === 'safebooru'));
if (result.candidates[0]) {
  console.log(`    首条：${String(result.candidates[0].width)}x${String(result.candidates[0].height)}  ${result.candidates[0].imageUrl.slice(0, 80)}`);
}

console.log('\n== 3. 反例守卫：自然语言标签不得产生噪声 ==');
{
  const noise = await runEngine('safebooru', 'Plastic Memories Isla', { timeoutMs: 25000 });
  console.log(`  tags="Plastic Memories Isla" → 候选 ${String(noise.candidates.length)} 条，error=${noise.error ?? '-'}`);
  check('带空格的自然语言得到 0 候选（而不是不相关噪声）', noise.candidates.length === 0, String(noise.candidates.length));
}

console.log('\n== 4. 下载与清晰度 ==');
const outDir = join(process.cwd(), '.work', 'safebooru-downloads');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
{
  const { files, failures } = await downloadCandidates(result.candidates, {
    directory: outDir,
    query: 'safebooru-test',
    count: 5,
    minPixels: 921600,
    minLongEdge: 1000,
    maxAspectRatio: 2.6,
    minBytes: 4096,
    concurrency: 5,
    timeoutMs: 30000,
  });
  console.log(`  下载：成功 ${String(files.length)} 张，失败/淘汰 ${String(failures.length)} 条`);
  for (const failure of failures.slice(0, 3)) console.log(`    - ${failure.reason}`);
  for (const file of files) {
    const info = await stat(file.path);
    const bytes = new Uint8Array(await readFile(file.path));
    const pixels = (file.width ?? 0) * (file.height ?? 0);
    check(
      `${file.fileName} ${String(file.width)}x${String(file.height)} ${String(Math.round(file.bytes / 1024))}KB 校验一致`,
      info.size === file.bytes && sniffImageMediaType(bytes) === file.mediaType && imageSize(bytes, file.mediaType)?.width === file.width && pixels >= 921600,
      `stat=${String(info.size)} px=${String(pixels)}`,
    );
  }
  check('至少下到 1 张 ≥720p', files.length > 0, String(files.length));
}

console.log('\n== 5. 端到端：search_picture 带 tags ==');
{
  const root = join(process.cwd(), '.work', 'safebooru-host');
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
        const { readFile: read } = await import('node:fs/promises');
        return new Uint8Array(await read(target.displayPath));
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
        const ref = { attachmentId: `a-${String(attachments.length + 1)}`, mediaType, bytes: input.data.byteLength, width: size?.width ?? 0, height: size?.height ?? 0 };
        attachments.push(ref);
        return ref;
      },
    },
  };
  const config = {
    directory: 'downloads', count: 8, minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 2.6,
    minBytes: 4096, maxBytes: 12 * 1024 * 1024, concurrency: 6, fetchTimeoutMs: 30000, searchTimeoutMs: 20000,
    officialSite: false, safebooru: true,
  };
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };

  const value = await runSearch(ctx, config, { query: '可塑性记忆 艾拉', tags, count: 8 }, exec);
  console.log(`  候选 ${String(value.images.length)} 张；来源分布：`);
  const byEngine = {};
  for (const image of value.images) byEngine[image.engine] = (byEngine[image.engine] ?? 0) + 1;
  console.log(`    ${JSON.stringify(byEngine)}`);
  console.log(`  searched：${value.searched.map((s) => `${s.engine}=${String(s.found)}`).join(', ')}`);

  check('Safebooru 出现在 searched 里', value.searched.some((s) => s.engine === 'safebooru'), JSON.stringify(value.searched.map((s) => s.engine)));
  check('Safebooru 真的贡献了候选', value.images.some((image) => image.engine === 'safebooru'), JSON.stringify(byEngine));
  check('输出含 officialSites 字段', Array.isArray(value.officialSites));
  check('备注提到插画源', value.notes.includes('Safebooru'), value.notes);
  console.log(`  预览区：${value.previewFolder}`);
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
