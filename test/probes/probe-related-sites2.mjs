/**
 * 第二步：确认能从萌娘百科 / biligame wiki 拿到**可直接下载的真实大图**。
 *
 * 上一轮发现：
 *   · opensearch 能精确命中「千夏(绝区零)」这类词条；
 *   · `prop=images` 返回 13 个图，但混着 SVG 图标（下载器不处理 SVG）；
 *   · 某些文件的 `imageinfo` 报错（可能是共享库图片，需要 repo 参数）。
 *
 * 这轮要拿到：真实文件 URL、尺寸、能否下载（含防盗链测试）、以及过滤掉 SVG/图标后的可用数量。
 */
import { BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RASTER = /\.(png|jpe?g|gif|webp)$/i;

async function api(label, url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    return { status: res.status, json };
  } catch (error) {
    console.log(`  ${label.padEnd(34)} ERR ${error.message.slice(0, 50)}`);
    return undefined;
  }
}

/** 把一批 File: 标题转成真实 URL + 尺寸（分批，避免 URL 过长）。 */
async function resolveFiles(apiBase, titles, label) {
  const out = [];
  for (let i = 0; i < titles.length; i += 10) {
    const chunk = titles.slice(i, i + 10);
    const url = `${apiBase}?action=query&titles=${encodeURIComponent(chunk.join('|'))}&prop=imageinfo&iiprop=url|size|mime&format=json`;
    const res = await api(`${label} imageinfo ${String(i / 10 + 1)}`, url);
    const pages = res?.json?.query?.pages;
    if (pages === undefined) continue;
    for (const page of Object.values(pages)) {
      const ii = page.imageinfo?.[0];
      if (ii === undefined) {
        // 共享库图片：再试一次带 iiprop=url 的 canonical 查询
        continue;
      }
      out.push({ title: page.title, url: ii.url, width: ii.width, height: ii.height, mime: ii.mime });
    }
    await sleep(300);
  }
  return out;
}

async function tryDownload(label, url) {
  for (const [mode, headers] of [['裸请求', {}], ['带 Referer', { referer: 'https://zh.moegirl.org.cn/' }]]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(20000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mediaType = sniffImageMediaType(bytes);
      const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
      const ok = res.status === 200 && mediaType !== undefined;
      console.log(`  ${ok ? '✅' : '❌'} [${mode}] HTTP ${String(res.status)} ${String(bytes.length)}B ${mediaType ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}  ${label}`);
      if (ok) return { ok: true, width: size.width, height: size.height, bytes: bytes.length };
    } catch (error) {
      console.log(`  ❌ [${mode}] ERR ${error.message.slice(0, 40)}  ${label}`);
    }
    await sleep(250);
  }
  return { ok: false };
}

console.log('=== A. 萌娘百科：拿真实图片 URL ===');
const MOE = 'https://zh.moegirl.org.cn/api.php';
for (const term of ['千夏(绝区零)', '可塑性记忆']) {
  const images = await api(`images(${term})`, `${MOE}?action=query&titles=${encodeURIComponent(term)}&prop=images&imlimit=30&format=json`);
  const titles = images?.json?.query?.pages
    ? (Object.values(images.json.query.pages)[0].images ?? []).map((i) => i.title)
    : [];
  const raster = titles.filter((t) => RASTER.test(t));
  console.log(`\n  【${term}】图片共 ${String(titles.length)} 个，其中位图（jpg/png/gif/webp）${String(raster.length)} 个`);
  console.log(`    SVG 图标被排除：${String(titles.length - raster.length)} 个`);
  await sleep(300);
  const resolved = await resolveFiles(MOE, raster, term);
  console.log(`    解析出 URL 的：${String(resolved.length)} 个`);
  for (const item of resolved.slice(0, 6)) {
    console.log(`      ${String(item.width)}x${String(item.height)}  ${item.mime}  ${item.title}`);
  }
  const candidate = resolved.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (candidate !== undefined) {
    console.log(`    → 下载验证最大的那张：${candidate.title}`);
    await tryDownload(candidate.title.slice(0, 30), candidate.url);
  }
  await sleep(400);
}

console.log('\n=== B. biligame wiki（以 zzz 为例） ===');
{
  const BILI = 'https://wiki.biligame.com/zzz/api.php';
  const search = await api('搜「千夏」', `${BILI}?action=query&list=search&srsearch=${encodeURIComponent('千夏')}&srlimit=5&format=json`);
  const hits = search?.json?.query?.search ?? [];
  console.log(`  命中 ${String(hits.length)} 条：${hits.map((h) => h.title).join(' / ')}`);
  await sleep(300);
  const page = hits[0]?.title;
  if (page !== undefined) {
    const images = await api(`images(${page})`, `${BILI}?action=query&titles=${encodeURIComponent(page)}&prop=images&imlimit=30&format=json`);
    const titles = images?.json?.query?.pages
      ? (Object.values(images.json.query.pages)[0].images ?? []).map((i) => i.title)
      : [];
    const raster = titles.filter((t) => RASTER.test(t));
    console.log(`  图片共 ${String(titles.length)} 个，位图 ${String(raster.length)} 个`);
    await sleep(300);
    const resolved = await resolveFiles(BILI, raster, 'biligame');
    console.log(`  解析出 URL 的：${String(resolved.length)} 个`);
    const candidate = resolved.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    if (candidate !== undefined) {
      console.log(`  → 下载验证：${String(candidate.width)}x${String(candidate.height)}  ${candidate.url.slice(0, 90)}`);
      await tryDownload(candidate.title.slice(0, 30), candidate.url);
    } else {
      console.log('  （没有可解析的位图）');
    }
  }
}
