/**
 * Where did these images actually come from, and can I still prove it per file?
 *
 * The search_picture output reports each image's local path and SOURCE PAGE, but not
 * the direct image URL (that lives only in the failure list). So per-file provenance
 * has to be reconstructed, and whatever cannot be reconstructed must be said plainly
 * rather than guessed.
 *
 * What this script does:
 *   1. lists what is on disk now;
 *   2. reports each file's real format/size (the plugin's own validation);
 *   3. scans bytes for recognizable CDN hostnames (which identifier survives the download);
 *   4. compares the CURRENT engine output against the files on disk, so we can tell
 *      whether a URL would still be reproducible today.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ENGINES, runEngine } from '../src/providers.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const dir = join(process.cwd(), 'downloads');
const names = (await readdir(dir)).sort();
console.log(`downloads/ has ${String(names.length)} file(s)\n`);

console.log('== 1. 每个文件的真实格式与尺寸（插件自己校验的那套判据） ==');
for (const name of names) {
  const path = join(dir, name);
  const info = await stat(path);
  const bytes = new Uint8Array(await readFile(path));
  const mediaType = sniffImageMediaType(bytes);
  const size = imageSize(bytes, mediaType);
  const dim = size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`;
  console.log(`  ${name}`);
  console.log(`      ${info.size} B  ${mediaType ?? 'unknown'}  ${dim}  px=${size === undefined ? '?' : String(size.width * size.height)}`);
}

console.log('\n== 2. 字节里能认出的图床域名（下载后仍保留的标识） ==');
const HOSTS = [
  'hdslb.com', 'zhimg.com', 'dtstatic.com', 'baidu.com', 'bdstatic.com',
  'qhimg.com', 'qhimgs1.com', 'mm.bing.net', 'bilibili.com', 'sinaimg.cn',
  'douyinpic.com', 'xhscdn.com', 'taobao.com', 'zhihu.com',
];
for (const name of names) {
  const bytes = new Uint8Array(await readFile(join(dir, name)));
  const text = Buffer.from(bytes).toString('latin1');
  const found = HOSTS.filter((host) => text.includes(host));
  // EXIF/PNG 元数据里的可读串，用于佐证来源（不保证每张都有）。
  const exif = [];
  const marker = text.indexOf('Exif');
  if (marker !== -1) {
    const chunk = Buffer.from(bytes.subarray(marker, marker + 400)).toString('latin1');
    for (const part of chunk.split(/[^\x20-\x7e]+/)) if (part.length > 5 && /[a-z]/i.test(part)) exif.push(part.slice(0, 60));
  }
  console.log(`  ${name}`);
  console.log(`      hosts=${found.length > 0 ? found.join(', ') : '(none)'}${exif.length > 0 ? `  exif=${JSON.stringify(exif.slice(0, 4))}` : ''}`);
}

console.log('\n== 3. 现在同关键词还能搜到什么（同一批 URL 是否可复现） ==');
for (const [query, keep] of [
  ['终末地 提芙洛斯', ['终末地 提芙洛斯-04.jpg']],
  ['Arknights Endfield Tiflos character', ['Arknights Endfield Tiflos character-01.jpg', 'Arknights Endfield Tiflos character-03.jpg', 'Arknights Endfield Tiflos character-04.jpg']],
]) {
  const merged = [];
  const seen = new Set();
  const errors = [];
  for (const engine of ENGINES) {
    const result = await runEngine(engine, query, { timeoutMs: 20000 });
    if (result.error !== undefined) errors.push(`${engine}: ${result.error}`);
    for (const candidate of result.candidates) {
      if (seen.has(candidate.imageUrl)) continue;
      seen.add(candidate.imageUrl);
      merged.push(candidate);
    }
  }
  // 与盘上文件名里的序号对齐：插件按清晰度排序取前 N 张。
  const ranked = [...merged].sort((a, b) => {
    const pa = a.proxied === true ? 1 : 0;
    const pb = b.proxied === true ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
  });
  console.log(`\n  query "${query}" → ${String(merged.length)} 合并候选 (errors: ${errors.length === 0 ? 'none' : errors.join('; ')})`);
  for (const [index, candidate] of ranked.slice(0, 6).entries()) {
    const hit = keep.some((name) => name.includes(`-${String(index + 1).padStart(2, '0')}`));
    console.log(`    #${String(index + 1)}${hit ? ' <- 盘上保留的正是这一位' : ''} ${String(candidate.width ?? '?')}x${String(candidate.height ?? '?')} ${candidate.engine}`);
    console.log(`        图片直链: ${candidate.imageUrl.slice(0, 130)}`);
    console.log(`        来源页面: ${candidate.pageUrl ?? '(引擎未提供)'}`);
  }
}
