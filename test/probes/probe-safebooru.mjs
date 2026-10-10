/**
 * Safebooru 作为新图源的可行性实测。
 *
 * 上次只探到「HTTP 200 + JSON」，这不足以决定接入。必须再验证三件事：
 *   1. 标签检索的内容相关性（用真实角色标签搜，看回来的是不是那个角色）；
 *   2. 原图分辨率（`file_url`）是否达到我们的 720p 门槛；
 *   3. 下载是否有防盗链、单页能给多少条。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(label, tags, limit = 8) {
  const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${String(limit)}&tags=${encodeURIComponent(tags)}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`  ${label.padEnd(34)} HTTP ${String(res.status)} 非 JSON：${text.slice(0, 90).replace(/\s+/g, ' ')}`);
      return [];
    }
    console.log(`  ${label.padEnd(34)} HTTP ${String(res.status)} ${String(json.length).padStart(3)} 条 ${String(Date.now() - started)}ms`);
    return json;
  } catch (error) {
    console.log(`  ${label.padEnd(34)} ERR ${error.message} ${error.cause?.code ?? ''}`);
    return [];
  }
}

async function probeImage(url, referer) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', referer }, signal: AbortSignal.timeout(20000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mediaType = sniffImageMediaType(bytes);
    const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
    return {
      status: res.status,
      bytes: bytes.length,
      mediaType,
      dim: size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`,
      pixels: size === undefined ? 0 : size.width * size.height,
    };
  } catch (error) {
    return { status: 0, bytes: 0, dim: `ERR ${error.message.slice(0, 30)}`, pixels: 0 };
  }
}

console.log('=== 1. 标签检索的相关性（内容由我随后看图核对） ===');
const queries = [
  ['plastics_memories', '可塑性记忆（英文标签）'],
  ['isla_(plastic_memories)', '艾拉（角色标签）'],
  ['arknights', '明日方舟（大类标签）'],
  ['deepseek', 'DeepSeek（应该很少）'],
];
const collected = [];
for (const [tags, label] of queries) {
  const rows = await api(label, tags, 6);
  for (const row of rows.slice(0, 3)) {
    collected.push({ label, tags, row });
  }
  await sleep(600);
}

console.log('\n=== 2. 原图分辨率（file_url） vs 缩略图 ===');
let ok = 0;
let big = 0;
for (const { label, row } of collected.slice(0, 8)) {
  const fileUrl = row.file_url?.startsWith('http') ? row.file_url : `https:${row.file_url ?? ''}`;
  const sampleUrl = row.sample_url?.startsWith('http') ? row.sample_url : `https:${row.sample_url ?? ''}`;
  console.log(`\n  [${label}] id=${String(row.id)}`);
  console.log(`    标签：${String(row.tags).slice(0, 90)}`);
  console.log(`    声明尺寸：${String(row.width)}x${String(row.height)}  大小：${String(row.file_size)}B`);
  const full = await probeImage(fileUrl, 'https://safebooru.org/');
  console.log(`    file_url  : HTTP ${String(full.status)} ${String(full.bytes)}B ${full.dim} ${full.mediaType ?? ''}`);
  if (full.status === 200) ok += 1;
  if (full.pixels >= 921600) big += 1;
  if (sampleUrl !== fileUrl && sampleUrl !== 'https:') {
    const sample = await probeImage(sampleUrl, 'https://safebooru.org/');
    console.log(`    sample_url: HTTP ${String(sample.status)} ${String(sample.bytes)}B ${sample.dim}`);
  }
  await sleep(500);
}
console.log(`\n  → 抽样 ${String(Math.min(8, collected.length))} 张：HTTP 200 的 ${String(ok)} 张，达 720p 的 ${String(big)} 张`);

console.log('\n=== 3. 防盗链与单页上限 ===');
{
  const row = collected[0]?.row;
  const fileUrl = row?.file_url?.startsWith('http') ? row.file_url : `https:${row?.file_url ?? ''}`;
  for (const [mode, referer] of [['裸请求', undefined], ['带 Referer', 'https://safebooru.org/']]) {
    const result = await probeImage(fileUrl, referer);
    console.log(`  ${mode.padEnd(12)} HTTP ${String(result.status)} ${String(result.bytes)}B ${result.dim}`);
    await sleep(300);
  }
  for (const limit of [20, 100]) {
    const rows = await api(`limit=${String(limit)}`, 'arknights', limit);
    console.log(`  limit=${String(limit)} → 实际返回 ${String(rows.length)} 条`);
    await sleep(600);
  }
}

console.log('\n=== 4. 候选图片直链（供人眼核对内容） ===');
for (const { label, row } of collected.slice(0, 6)) {
  const fileUrl = row.file_url?.startsWith('http') ? row.file_url : `https:${row.file_url ?? ''}`;
  console.log(`  [${label}] ${String(row.width)}x${String(row.height)}  ${fileUrl.slice(0, 100)}`);
}
