/**
 * 确认三件事：
 *   1. 萌娘百科 `generator=images` 拿到的图（storage.moegirl.org.cn）能否下载、有无防盗链；
 *   2. biligame 的**动漫** wiki 是否也可用（用户说「例如动漫可以去萌娘百科这类的网站」）；
 *   3. 过滤 SVG 后，一次能拿到多少张 ≥720p 的图。
 */
import { BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RASTER = /\.(png|jpe?g|gif|webp)$/i;

async function apiJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

/** 用 generator=images + imageinfo 一步拿到「词条的图 + 真实 URL + 尺寸」。 */
async function imagesOf(apiBase, title, limit = 30) {
  const url = `${apiBase}?action=query&generator=images&titles=${encodeURIComponent(title)}`
    + `&gimlimit=${String(limit)}&prop=imageinfo&iiprop=url|size&format=json`;
  const json = await apiJson(url);
  const pages = json?.query?.pages;
  if (pages === undefined) return { images: [], error: json?.error?.info };
  const images = [];
  for (const page of Object.values(pages)) {
    const ii = page.imageinfo?.[0];
    if (ii?.url === undefined) continue;
    if (!RASTER.test(ii.url)) continue;
    images.push({ title: page.title, url: ii.url, width: ii.width, height: ii.height });
  }
  return { images };
}

async function tryDownload(url) {
  for (const [mode, headers] of [['裸请求', {}], ['带 Referer', { referer: 'https://zh.moegirl.org.cn/' }]]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(20000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      if (res.status === 200 && mediaType !== undefined) {
        console.log(`  ✅ [${mode}] ${String(size.width)}x${String(size.height)} ${String(Math.round(bytes.length / 1024))}KB`);
        return { ok: true, width: size.width, height: size.height };
      }
      console.log(`  ❌ [${mode}] HTTP ${String(res.status)} ${mediaType ?? '未识别'}`);
    } catch (error) {
      console.log(`  ❌ [${mode}] ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(250);
  }
  return { ok: false };
}

console.log('=== 1. 萌娘百科：generator=images 的下载验证 ===');
const MOE = 'https://zh.moegirl.org.cn/api.php';
for (const term of ['可塑性记忆', '千夏(绝区零)']) {
  const { images, error } = await imagesOf(MOE, term);
  const big = images.filter((i) => (i.width ?? 0) * (i.height ?? 0) >= 921600);
  console.log(`\n  【${term}】位图 ${String(images.length)} 张，其中 ≥720p 的 ${String(big.length)} 张${error === undefined ? '' : `  error=${error}`}`);
  for (const item of big.slice(0, 6)) {
    console.log(`      ${String(item.width).padStart(5)}x${String(item.height).padEnd(5)}  ${item.title.replace(/^File:/, '')}`);
  }
  const top = big.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (top !== undefined) {
    console.log(`    → 下载验证：${top.title}`);
    await tryDownload(top.url);
  } else {
    console.log('    （没有 ≥720p 的图，可能是条目配图偏小）');
  }
  await sleep(500);
}

console.log('\n=== 2. biligame 动漫 wiki（zh.moegirl 之外的「相关站点」） ===');
{
  // biligame 下有几个动漫相关 wiki，试几个看哪个可用
  const wikis = [
    ['zzz（绝区零）', 'https://wiki.biligame.com/zzz/api.php'],
    ['shengxiao（动漫）', 'https://wiki.biligame.com/shengxiao/api.php'],
    ['dongman（动漫）', 'https://wiki.biligame.com/dongman/api.php'],
  ];
  for (const [name, api] of wikis) {
    try {
      const json = await apiJson(`${api}?action=query&list=search&srsearch=${encodeURIComponent('千夏')}&srlimit=3&format=json`);
      const hits = json?.query?.search;
      if (hits === undefined) {
        console.log(`  ${name.padEnd(18)} ✗ ${json?.error?.info ?? 'no query'}`);
      } else {
        console.log(`  ${name.padEnd(18)} ✓ 命中 ${String(hits.length)} 条：${hits.map((h) => h.title).join(' / ')}`);
      }
    } catch (error) {
      console.log(`  ${name.padEnd(18)} ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(300);
  }
}

console.log('\n=== 3. 萌娘百科按关键词搜索词条（供引擎使用） ===');
{
  for (const term of ['游戏人生', 'No Game No Life', '可塑性记忆']) {
    const url = `${MOE}?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=5&format=json`;
    try {
      const json = await apiJson(url);
      const hits = json?.query?.search ?? [];
      console.log(`  「${term}」→ ${hits.length === 0 ? '(无)' : hits.map((h) => h.title).join(' / ')}`);
    } catch (error) {
      console.log(`  「${term}」ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(300);
  }
}
