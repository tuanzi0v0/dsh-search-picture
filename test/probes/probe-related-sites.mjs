/**
 * 实测「相关站点」图源的可行性：萌娘百科 + B 站 wiki（biligame）。
 *
 * 要回答三个问题：
 *   1. 萌娘百科的 MediaWiki API 匿名可用吗？能按关键词搜到词条、并列出图片吗？
 *   2. 它的图（`img.moegirl.org.cn`）能不能下载？有没有防盗链？
 *   3. B 站 wiki（`wiki.biligame.com`）能不能同样处理？
 */
import { BROWSER_UA } from '../src/util.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(label, url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json, text/plain, */*', 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`  ${label.padEnd(30)} HTTP ${String(res.status)}  非 JSON（${String(text.length)}B）「${text.slice(0, 60).replace(/\s+/g, ' ')}」`);
      return undefined;
    }
    console.log(`  ${label.padEnd(30)} HTTP ${String(res.status)}  json keys=${Object.keys(json).slice(0, 6).join(',')}`);
    return json;
  } catch (error) {
    console.log(`  ${label.padEnd(30)} ERR ${error.message} ${error.cause?.code ?? ''}`);
    return undefined;
  }
}

console.log('=== 1. 萌娘百科 MediaWiki API（zh.moegirl.org.cn） ===');
const MOE = 'https://zh.moegirl.org.cn/api.php';
const search = await getJson('opensearch 搜「千夏」', `${MOE}?action=opensearch&search=${encodeURIComponent('千夏')}&limit=5&format=json`);
if (Array.isArray(search)) {
  console.log(`      命中词条：${(search[1] ?? []).join(' / ')}`);
}
await sleep(400);

const search2 = await getJson('opensearch 搜「可塑性记忆」', `${MOE}?action=opensearch&search=${encodeURIComponent('可塑性记忆')}&limit=5&format=json`);
if (Array.isArray(search2)) {
  console.log(`      命中词条：${(search2[1] ?? []).join(' / ')}`);
}
await sleep(400);

// 取某个词条的图片列表
const title = Array.isArray(search2) && search2[1]?.[0] ? search2[1][0] : '可塑性记忆';
const images = await getJson(`query images（${title}）`, `${MOE}?action=query&titles=${encodeURIComponent(title)}&prop=images&imlimit=20&format=json`);
if (images?.query?.pages) {
  const page = Object.values(images.query.pages)[0];
  const list = (page.images ?? []).map((i) => i.title);
  console.log(`      图片 ${String(list.length)} 个：${list.slice(0, 8).join(', ')}`);
}
await sleep(400);

// 取图片的真实 URL（imageinfo）
const fileTitle = images?.query?.pages
  ? (Object.values(images.query.pages)[0].images ?? []).map((i) => i.title).find((t) => /\.(png|jpe?g|gif|webp)$/i.test(t))
  : undefined;
if (fileTitle !== undefined) {
  const info = await getJson(`imageinfo（${fileTitle}）`, `${MOE}?action=query&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo&iiprop=url|size&format=json`);
  const page = info?.query?.pages ? Object.values(info.query.pages)[0] : undefined;
  const ii = page?.imageinfo?.[0];
  if (ii !== undefined) {
    console.log(`      URL：${ii.url}`);
    console.log(`      声明尺寸：${String(ii.width)}x${String(ii.height)}`);
    // 下载验证
    for (const [mode, headers] of [['裸请求', {}], ['带 Referer', { referer: 'https://zh.moegirl.org.cn/' }]]) {
      try {
        const res = await fetch(ii.url, { headers: { 'user-agent': BROWSER_UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(20000) });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        console.log(`      [${mode}] HTTP ${String(res.status)} ${String(bytes.length)}B ${mediaType ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}`);
      } catch (error) {
        console.log(`      [${mode}] ERR ${error.message.slice(0, 40)}`);
      }
      await sleep(300);
    }
  } else {
    console.log('      （没有 imageinfo，可能是共享图/外链）');
  }
}

console.log('\n=== 2. B 站 wiki（wiki.biligame.com） ===');
await getJson('MediaWiki API 探测', 'https://wiki.biligame.com/zzz/api.php?action=query&meta=siteinfo&format=json');
await sleep(400);
await getJson('搜「千夏」', `https://wiki.biligame.com/zzz/api.php?action=query&list=search&srsearch=${encodeURIComponent('千夏')}&format=json`);
await sleep(400);

console.log('\n=== 3. 已知「带水印图床」探测（用于过滤） ===');
{
  // 这些站点普遍给图加水印/带运营标识；确认一下它们的域名特征，供过滤规则使用。
  const hosts = [
    ['千图网', 'https://www.58pic.com/'],
    ['摄图网', 'https://699pic.com/'],
    ['包图网', 'https://ibaotu.com/'],
    ['觅知网', 'https://www.51miz.com/'],
  ];
  for (const [name, url] of hosts) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(12000) });
      console.log(`  ${name.padEnd(10)} HTTP ${String(res.status)}  ${url}`);
    } catch (error) {
      console.log(`  ${name.padEnd(10)} ERR ${error.message.slice(0, 40)}`);
    }
    await sleep(200);
  }
}
