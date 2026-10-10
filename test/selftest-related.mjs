/**
 * 新功能自测：
 *   A. 「相关站点」图源（萌娘百科）—— 词条检索、取图、下载；
 *   B. 水印过滤 —— 域名判据、标记判据、不误伤正常图床；
 *   C. 端到端 —— `search_picture` 带 `relatedSites` 时，相关站点的图真的会进候选。
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadCandidates, isWatermarkRisk } from '../src/download.js';
import { runSearch } from '../src/host.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { collectRelatedCandidates, entryImages, RELATED_SITES, searchEntries } from '../src/related.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label}  ${detail}`);
  }
};

console.log('== A1. 水印过滤判据（确定性，不需要视觉模型） ==');
{
  const blocked = [
    ['https://img.58pic.com/a.jpg', '58pic 图库'],
    ['https://pic.699pic.com/b.jpg', '699pic 图库'],
    ['https://img.gettyimages.com/c.jpg', 'getty 图库'],
    ['https://x.example.com/watermark_1.jpg', '地址带 watermark'],
    ['https://x.example.com/带水印的图.jpg', '中文水印标记'],
    ['https://x.example.com/pic_水印.jpg', '水印字样'],
  ];
  for (const [url, why] of blocked) {
    check(`拦截：${why}`, isWatermarkRisk(url).blocked, url);
  }
  const allowed = [
    ['https://pic1.zhimg.com/v2-abc_r.jpg', '知乎'],
    ['https://i0.hdslb.com/bfs/archive/x.jpg', 'B 站'],
    ['https://safebooru.org/images/1/a.jpg', 'Safebooru'],
    ['https://storage.moegirl.org.cn/moegirl/commons/3/31/x.jpg', '萌娘百科图床'],
  ];
  for (const [url, why] of allowed) {
    check(`放行：${why}`, !isWatermarkRisk(url).blocked, url);
  }
  check('可配置追加域名', isWatermarkRisk('https://img.mysite.cn/a.jpg', ['mysite.cn']).blocked);
  check('配置为空数组时不误伤', !isWatermarkRisk('https://img.mysite.cn/a.jpg', []).blocked);
  check('非法 URL 不抛错', !isWatermarkRisk('not-a-url').blocked);
}

console.log('\n== A2. 萌娘百科：词条检索 ==');
{
  const site = RELATED_SITES.moegirl;
  check('moegirl 站点定义存在', site !== undefined);
  const titles = await searchEntries(site, '可塑性记忆');
  console.log(`    「可塑性记忆」→ ${titles.join(' / ') || '(无)'}`);
  check('能命中词条', titles.length > 0, JSON.stringify(titles));
  const titles2 = await searchEntries(site, '千夏');
  console.log(`    「千夏」→ ${titles2.join(' / ') || '(无)'}`);
  check('能命中含消歧义的词条（千夏(...)）', titles2.some((t) => t.includes('千夏')));
}

console.log('\n== A2b. 复合查询词与相关性校验（实测踩到的两个坑） ==');
{
  const site = RELATED_SITES.moegirl;
  // 坑 1：opensearch 是前缀匹配，带空格的复合查询整串匹配不到 → 必须拆词重试。
  const compound = await searchEntries(site, '可塑性记忆 艾拉');
  console.log(`    「可塑性记忆 艾拉」→ ${compound.join(' / ') || '(无)'}`);
  check('复合查询词（作品名+角色名）能命中', compound.length > 0, JSON.stringify(compound));
  const compound2 = await searchEntries(site, '千夏 绝区零');
  console.log(`    「千夏 绝区零」→ ${compound2.join(' / ') || '(无)'}`);
  check('复合查询词能命中消歧义词条（千夏(绝区零)）', compound2.includes('千夏(绝区零)'), JSON.stringify(compound2));

  // 坑 2：拆词后前缀匹配会命中无关词条（「洱海 风景」→「风景杀」，那是个卡牌游戏）。
  const irrelevant = await searchEntries(site, '洱海 风景');
  console.log(`    「洱海 风景」→ ${irrelevant.join(' / ') || '(无)'}`);
  check('无关查询不再命中「风景杀」这类词条', !irrelevant.includes('风景杀'), JSON.stringify(irrelevant));
  check('风景类查询（萌娘百科没有该词条）返回空而不是噪声', irrelevant.length === 0, JSON.stringify(irrelevant));
}

console.log('\n== A3. 萌娘百科：取词条图片（必须走 generator=images） ==');
{
  const site = RELATED_SITES.moegirl;
  const { images, blocked } = await entryImages(site, '可塑性记忆');
  console.log(`    位图 ${String(images.length)} 张（已排除 SVG 与站点素材）`);
  for (const image of images.slice(0, 6)) {
    console.log(`      ${String(image.width).padStart(5)}x${String(image.height).padEnd(5)}  ${String(image.title).slice(0, 40)}`);
  }
  check('未被 WAF 拦', !blocked);
  check('拿到位图', images.length > 0, String(images.length));
  check('全部是位图格式（无 SVG）', images.every((i) => /\.(png|jpe?g|gif|webp)$/i.test(i.imageUrl)));
  check('排除了站点自用素材（logo/icon 等）', images.every((i) => !/(logo|icon|emblem)/i.test(String(i.title))), JSON.stringify(images.map((i) => i.title)));
  check('带尺寸信息', images.every((i) => typeof i.width === 'number' && typeof i.height === 'number'));
}

console.log('\n== A4. 相关站点候选：能否真的下载下来 ==');
{
  const { candidates, errors } = await collectRelatedCandidates(['moegirl'], '可塑性记忆', { timeoutMs: 25000 });
  console.log(`    候选 ${String(candidates.length)} 条${errors.length > 0 ? `；errors=${errors.join('; ')}` : ''}`);
  check('收集到候选', candidates.length > 0, JSON.stringify(errors));
  check('候选标记 engine=related', candidates.every((c) => c.engine === 'related'));
  check('候选带出处页', candidates.every((c) => typeof c.pageUrl === 'string' && c.pageUrl.startsWith('http')));
  check('候选带来源站点名', candidates.every((c) => typeof c.sourceSite === 'string'));

  const outDir = join(process.cwd(), '.work', 'related-e2e');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const { files, failures } = await downloadCandidates(candidates, {
    directory: outDir, query: 'moegirl', count: 2,
    minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 3.0,
    minBytes: 4096, concurrency: 2, timeoutMs: 30000,
  });
  console.log(`    下载成功 ${String(files.length)} 张，淘汰 ${String(failures.length)} 条`);
  for (const failure of failures.slice(0, 3)) console.log(`      - ${failure.reason}`);
  check('真的下载到图片', files.length > 0, String(files.length));
  for (const file of files) {
    const info = await stat(file.path);
    const bytes = new Uint8Array(await readFile(file.path));
    const mediaType = sniffImageMediaType(bytes);
    const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
    check(
      `${file.fileName} ${String(file.width)}x${String(file.height)} ${String(Math.round(info.size / 1024))}KB`,
      size !== undefined && size.width === file.width && size.height === file.height && info.size === file.bytes,
      JSON.stringify(size),
    );
  }
}

console.log('\n== B. 端到端：search_picture 带 relatedSites ==');
{
  const root = join(process.cwd(), '.work', 'related-host');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const ctx = {
    fs: {
      async resolve(path, options = {}) {
        const base = options.cwd ?? process.cwd();
        return { displayPath: /^[A-Za-z]:[\\/]/.test(path) ? path : join(base, path), targetKey: '' };
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
        return { attachmentId: `a-${String(Math.random()).slice(2, 8)}`, mediaType, bytes: input.data.byteLength, width: size?.width ?? 0, height: size?.height ?? 0 };
      },
    },
  };
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };
  const config = {
    directory: 'downloads', count: 6, minPixels: 921600, minLongEdge: 1000, maxAspectRatio: 2.6,
    minBytes: 4096, maxBytes: 12 * 1024 * 1024, concurrency: 6, fetchTimeoutMs: 30000, searchTimeoutMs: 20000,
    officialSite: false, safebooru: false, album: join(root, 'album'), albumName: 'x',
    autoCleanPreview: true, relatedSites: ['moegirl'], watermarkHosts: [],
  };
  const value = await runSearch(ctx, config, { query: '可塑性记忆' }, exec);
  const byEngine = {};
  for (const image of value.images) byEngine[image.engine] = (byEngine[image.engine] ?? 0) + 1;
  console.log(`    候选 ${String(value.images.length)} 张，来源分布 ${JSON.stringify(byEngine)}`);
  console.log(`    searched：${value.searched.map((s) => `${s.engine}=${String(s.found)}`).join(', ')}`);
  check('searched 里出现 related', value.searched.some((s) => s.engine === 'related'), JSON.stringify(value.searched.map((s) => s.engine)));
  check('related 贡献了候选', value.images.some((i) => i.engine === 'related'), JSON.stringify(byEngine));
  check('备注说明来自相关站点', value.notes.includes('相关站点'), value.notes);
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
