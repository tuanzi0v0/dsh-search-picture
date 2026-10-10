/**
 * Follow-up: can a Bilibili cover actually be downloaded, and can we get a bigger size?
 *
 * Bilibili image URLs accept an `@<width>w_<height>h_<crop>c.<format>` suffix that asks
 * the CDN for a derived size. The search API hands back covers without that suffix, so
 * the question is whether asking for a large size yields a genuinely larger image.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://search.bilibili.com/';
const { sniffImageMediaType, imageSize } = await import('../src/image.js');

async function probe(url, headers, label) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...headers }, signal: AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = sniffImageMediaType(bytes);
    const size = type === undefined ? undefined : imageSize(bytes, type);
    return `${label}: ${res.status} ${String(bytes.length)}B ${type ?? 'unsupported'} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${String(Date.now() - started)}ms`;
  } catch (error) {
    return `${label}: ERR ${error.message} ${error.cause?.code ?? ''}`;
  }
}

// 1) 拿几个视频封面
async function searchPage(page, attempt = 1) {
  const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent('终末地')}&page=${page}`, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER },
  });
  const body = JSON.parse(await res.text());
  const rows = (body.data?.result ?? []).filter((row) => typeof row.pic === 'string' && row.pic !== '');
  if (rows.length === 0) {
    console.log(`  page ${String(page)} attempt ${String(attempt)}: code=${String(body.code)} message=${String(body.message)} data=${body.data === undefined ? 'undefined' : 'present'}`);
    if (attempt < 3) {
      // 站内搜索对无 cookie 的突发请求会限流（-412 / 降级过滤），退避后再试一次。
      await new Promise((resolve) => setTimeout(resolve, 2500 * attempt));
      return searchPage(page, attempt + 1);
    }
  }
  return rows;
}

const items = await searchPage(1);
console.log(`\n搜索到 ${String(items.length)} 条带封面的视频`);
if (items.length === 0) {
  console.log('无结果，后续检查跳过（说明该接口在无 cookie 时可能持续限流）。');
  process.exit(0);
}

console.log('\n=== 封面下载与防盗链 ===');
for (const item of items.slice(0, 3)) {
  const url = item.pic.startsWith('//') ? `https:${item.pic}` : item.pic;
  console.log(`\n  ${String(item.title).replace(/<[^>]*>/g, '').slice(0, 50)}`);
  console.log(`    ${await probe(url, {}, '裸请求        ')}`);
  console.log(`    ${await probe(url, { referer: REFERER }, '带 Referer    ')}`);
}

console.log('\n=== 尺寸后缀是否给出更大的图 ===');
{
  const item = items[0];
  const base = (item.pic.startsWith('//') ? `https:${item.pic}` : item.pic).replace(/@[^/]*$/, '');
  const variants = [
    ['原样（无后缀）      ', base],
    ['@1920w_1080h_1c    ', `${base}@1920w_1080h_1c`],
    ['@1920w_1080h_1c.webp', `${base}@1920w_1080h_1c.webp`],
    ['@2560w_1440h_1c    ', `${base}@2560w_1440h_1c`],
    ['@100w_100h_1c      ', `${base}@100w_100h_1c`],
  ];
  for (const [label, url] of variants) console.log(`    ${await probe(url, {}, label)}`);
}

console.log('\n=== 视频详情接口能否给出更大的封面 ===');
{
  const item = items[0];
  const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER },
  });
  const detail = JSON.parse(await view.text());
  console.log(`    code=${String(detail.code)} pic=${String(detail.data?.pic)}`);
  console.log(`    字段里与图相关的: ${detail.data ? Object.keys(detail.data).filter((k) => /pic|cover|image/i.test(k)).join(', ') : '(无)'}`);
  if (detail.data?.pic) {
    const url = detail.data.pic.startsWith('//') ? `https:${detail.data.pic}` : detail.data.pic;
    console.log(`    ${await probe(url, {}, '详情封面      ')}`);
  }
}

console.log('\n=== 分页与速率 ===');
for (const page of [1, 2, 3]) {
  const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent('终末地')}&page=${page}`, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER },
  });
  const body = JSON.parse(await res.text());
  console.log(`    page ${String(page)}: code=${String(body.code)} items=${String((body.data?.result ?? []).length)}`);
}
