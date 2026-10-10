/**
 * 挖两个已确认可用的入口里的实际图片：
 *   A. 专栏搜索 → 专栏正文内嵌图片（高质量图多半在正文里，不只是封面）
 *   B. UP 主相册 link_draw（B 站「图文」图片集）→ 一次多张
 *
 * 同样带固定退避，避免把限流误判成「没有数据」。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WANT = process.argv[2] ?? '终末地';

let lastCall = 0;
async function call(label, url, headers = {}, kind = 'json') {
  const wait = 2500 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: kind === 'html' ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: headers.referer ?? 'https://www.bilibili.com/',
        ...headers,
      },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    if (kind === 'html') return { status: res.status, text };
    try {
      const json = JSON.parse(text);
      console.log(`  ${label}: code=${String(json.code)} msg=${String(json.message ?? '-')}`);
      return json;
    } catch {
      console.log(`  ${label}: 非 JSON (HTTP ${String(res.status)})`);
      return undefined;
    }
  } catch (error) {
    console.log(`  ${label}: ERR ${error.message}`);
    return undefined;
  }
}

async function imageInfo(label, url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = sniffImageMediaType(bytes);
    const size = type === undefined ? undefined : imageSize(bytes, type);
    console.log(`    ${label}: ${String(res.status)} ${String(bytes.length)}B ${type ?? '未识别'} ${size === undefined ? '' : `${String(size.width)}x${String(size.height)}`}`);
  } catch (error) {
    console.log(`    ${label}: ERR ${error.message}`);
  }
}

const asUrl = (raw) => (typeof raw === 'string' && raw.startsWith('//') ? `https:${raw}` : raw);

console.log(`=== A. 专栏搜索（keyword=${WANT}） ===`);
const articleSearch = await call('search/type=article', `https://api.bilibili.com/x/web-interface/search/type?search_type=article&keyword=${encodeURIComponent(WANT)}&page=1`);
const articles = articleSearch?.data?.result ?? [];
console.log(`  专栏条数=${String(articles.length)}`);
if (articles[0]) {
  console.log(`  字段: ${Object.keys(articles[0]).join(', ')}`);
  const first = articles[0];
  console.log(`  样例标题: ${String(first.title).replace(/<[^>]*>/g, '').slice(0, 60)}`);
  console.log(`  cover=${String(first.cover).slice(0, 90)}`);
  console.log(`  id=${String(first.id)} template_id=${String(first.template_id)}`);
  if (first.cover) await imageInfo('专栏封面', asUrl(first.cover));
}

console.log('\n=== B. 专栏正文内嵌图片（cv 页面） ===');
{
  const id = articles[0]?.id;
  if (id === undefined) {
    console.log('  没有专栏 id，跳过');
  } else {
    const page = await call('cv 页面', `https://www.bilibili.com/read/cv${String(id)}`, {}, 'html');
    if (page?.text) {
      console.log(`  HTTP ${String(page.status)} ${String(page.text.length)}B`);
      // 正文图片在页面内嵌 JSON 里（opus/正文 opus 结构的 pics 或 img src）。
      const candidates = [...new Set([
        ...(page.text.match(/https?:\/\/[a-z0-9.-]*hdslb\.com\/bfs\/[^"'\\\s)]+/g) ?? []),
        ...(page.text.match(/\/\/[a-z0-9.-]*hdslb\.com\/bfs\/[^"'\\\s)]+/g) ?? []).map((raw) => `https:${raw}`),
      ])].filter((url) => !/static|favicon|\.svg|\.ico|jinkela/.test(url));
      console.log(`  正文图片候选 ${String(candidates.length)} 个`);
      for (const url of candidates.slice(0, 8)) console.log(`    ${url.slice(0, 120)}`);
      for (const [index, url] of candidates.slice(0, 3).entries()) await imageInfo(`候选#${String(index + 1)}`, url);
    }
  }
}

console.log('\n=== C. UP 主相册 link_draw（图文图片集） ===');
for (const uid of ['703007996', '2', '11783021']) {
  const draw = await call(`link_draw uid=${uid}`, `https://api.vc.bilibili.com/link_draw/v1/doc/doc_list?uid=${uid}&page_num=0&page_size=12&biz=all`);
  const items = draw?.data?.items ?? [];
  console.log(`  条目数=${String(items.length)}${items[0] ? `; 字段: ${Object.keys(items[0]).join(', ')}` : ''}`);
  if (items[0]) {
    const doc = items[0];
    const pics = doc.pictures ?? doc.pics ?? [];
    console.log(`  标题=${String(doc.title).slice(0, 50)}; 图片数=${String(pics.length)}`);
    if (pics[0]) {
      console.log(`  img_src=${String(pics[0].img_src).slice(0, 100)}`);
      await imageInfo('相册首图', asUrl(pics[0].img_src));
    }
    break;
  }
}
