/**
 * Can we search Bilibili directly for images?
 *
 * Bilibili has no public image-search endpoint, but its search API returns a `pic`
 * (cover) field per result. This probe answers three questions with real calls:
 *   1. which search types work, and do they carry image URLs;
 *   2. do those image URLs download (bilibili CDN enforces hotlink rules);
 *   3. what does a single search actually yield (fields, sizes, count).
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://search.bilibili.com/';

const { sniffImageMediaType, imageSize } = await import('../src/image.js');

async function api(label, url, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: REFERER, ...extraHeaders },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { label, status: res.status, error: `non-JSON (${res.headers.get('content-type')})`, head: text.slice(0, 120) };
    }
    return { label, status: res.status, code: json.code, message: json.message, data: json.data };
  } catch (error) {
    return { label, status: 0, error: error.message, cause: error.cause?.code };
  }
}

const keyword = encodeURIComponent('终末地');

console.log('=== 1. 各 search_type 是否带图片字段 ===');
for (const type of ['video', 'media_bangumi', 'media_ft', 'bili_user', 'article', 'live', 'live_room', 'photo']) {
  const result = await api(type, `https://api.bilibili.com/x/web-interface/search/type?search_type=${type}&keyword=${keyword}&page=1`);
  if (result.error !== undefined) {
    console.log(`  ${type.padEnd(14)} ERROR ${result.error} ${result.cause ?? ''}`);
    continue;
  }
  const items = Array.isArray(result.data?.result) ? result.data.result : [];
  const withPic = items.filter((item) => typeof item.pic === 'string' && item.pic !== '');
  const sample = withPic[0];
  console.log(`  ${type.padEnd(14)} code=${String(result.code)} items=${String(items.length)} 带pic=${String(withPic.length)}`);
  if (sample) {
    console.log(`        pic=${String(sample.pic).slice(0, 95)}`);
    if (sample.pic && !sample.pic.startsWith('http')) console.log('        (注意：pic 不是绝对地址，需要补 //)');
    if (sample.title) console.log(`        title=${String(sample.title).replace(/<[^>]*>/g, '').slice(0, 60)}`);
    if (sample.bvid) console.log(`        bvid=${sample.bvid}`);
  }
  if (result.message) console.log(`        message=${result.message}`);
}

console.log('\n=== 2. 视频封面字段与可分页数量 ===');
{
  const first = await api('video-p1', 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + keyword + '&page=1');
  const items = first.data?.result ?? [];
  console.log(`  page1: ${String(items.length)} 条, 字段样例: ${items[0] ? Object.keys(items[0]).filter((k) => /pic|title|bvid|duration|play|author|pubdate/i.test(k)).join(', ') : '(无)'}`);
  const second = await api('video-p2', 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + keyword + '&page=2');
  console.log(`  page2: ${String((second.data?.result ?? []).length)} 条, code=${String(second.code)}`);
}

console.log('\n=== 3. 封面能否直接下载（防盗链检查） ===');
{
  const result = await api('video', 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + keyword + '&page=1');
  const pics = (result.data?.result ?? []).filter((item) => typeof item.pic === 'string' && item.pic !== '').slice(0, 4);
  for (const item of pics) {
    const url = item.pic.startsWith('//') ? `https:${item.pic}` : item.pic;
    for (const [mode, headers] of [
      ['裸请求', {}],
      ['带 Referer', { referer: REFERER }],
    ]) {
      try {
        const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', ...headers }, signal: AbortSignal.timeout(15000) });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = sniffImageMediaType(bytes);
        const size = type === undefined ? undefined : imageSize(bytes, type);
        console.log(`  [${mode}] ${res.status} ${String(bytes.length)}B ${type ?? 'unsupported'} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}  <- ${url.slice(0, 78)}`);
      } catch (error) {
        console.log(`  [${mode}] ERR ${error.message} ${error.cause?.code ?? ''}  <- ${url.slice(0, 78)}`);
      }
    }
  }
}

console.log('\n=== 4. 有没有更好的尺寸（URL 后缀 / 视频详情接口） ===');
{
  const result = await api('video', 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + keyword + '&page=1');
  const item = (result.data?.result ?? []).find((row) => typeof row.pic === 'string' && row.pic !== '');
  if (item) {
    const base = item.pic.startsWith('//') ? `https:${item.pic}` : item.pic;
    console.log(`  封面原样: ${base}`);
    console.log(`  去 @ 后缀后: ${base.replace(/@[^/]*$/, '')}`);
    for (const variant of [base, base.replace(/@[^/]*$/, ''), `${base.replace(/@[^/]*$/, '')}@1600w_900h_1c.webp`]) {
      try {
        const res = await fetch(variant, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = sniffImageMediaType(bytes);
        const size = type === undefined ? undefined : imageSize(bytes, type);
        console.log(`    ${res.status} ${String(bytes.length)}B ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}  ${variant.slice(-46)}`);
      } catch (error) {
        console.log(`    ERR ${error.message}`);
      }
    }
    if (item.bvid) {
      const view = await api('view', `https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`);
      console.log(`  视频详情接口 code=${String(view.code)}; data.pic=${String(view.data?.pic).slice(0, 90)}`);
    }
  }
}
