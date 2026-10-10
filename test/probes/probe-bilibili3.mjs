/**
 * Are there richer Bilibili image sources than video covers?
 *
 * Probes the two endpoints that could yield an actual image list rather than one cover
 * per video. Kept small and spaced out: the search API bans bursts (code -412).
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://search.bilibili.com/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(label, url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: REFERER, ...headers },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return console.log(`  ${label}: HTTP ${String(res.status)} non-JSON (${text.slice(0, 80)})`);
    }
    console.log(`  ${label}: HTTP ${String(res.status)} code=${String(json.code)} message=${String(json.message ?? '-')}`);
    return json;
  } catch (error) {
    console.log(`  ${label}: ERR ${error.message} ${error.cause?.code ?? ''}`);
    return undefined;
  }
}

console.log('=== 1. UP 主相册（有没有独立图片列表） ===');
{
  // 先用搜索拿一个 UP 主的 mid，再问他的相册。
  const search = await get('搜索视频（取 up 主）', `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent('终末地')}&page=1`);
  const mid = search?.data?.result?.[0]?.mid;
  console.log(`  mid=${String(mid)}`);
  if (mid) {
    await sleep(2000);
    const album = await get('相册列表 space album', `https://api.bilibili.com/x/space/album/index?mid=${String(mid)}&page=1&pagesize=10`);
    if (album?.data) console.log(`  data keys: ${Object.keys(album.data).join(', ')} | 条目数: ${String(album.data.item?.length ?? album.data.list?.length ?? '?')}`);
  }
}

console.log('\n=== 2. 用户动态（图文动态里带多张图） ===');
{
  await sleep(2500);
  const feed = await get('动态 feed space', 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=2&timezone_offset=-480');
  const items = feed?.data?.items ?? [];
  console.log(`  动态条数: ${String(items.length)}`);
  let pics = 0;
  for (const item of items) {
    const draw = item.modules?.module_dynamic?.major?.draw;
    if (draw?.items) pics += draw.items.length;
  }
  console.log(`  图文动态里的图片总数: ${String(pics)}`);
  const first = items.find((item) => (item.modules?.module_dynamic?.major?.draw?.items ?? []).length > 0);
  if (first) {
    const url = first.modules.module_dynamic.major.draw.items[0].src;
    console.log(`  样例图片: ${String(url).slice(0, 100)}`);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' }, signal: AbortSignal.timeout(15000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { sniffImageMediaType, imageSize } = await import('../src/image.js');
    const type = sniffImageMediaType(bytes);
    const size = type === undefined ? undefined : imageSize(bytes, type);
    console.log(`  下载: ${String(res.status)} ${String(bytes.length)}B ${type ?? '?'} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`}`);
  }
}

console.log('\n=== 3. 视频详情里除了封面还有什么图 ===');
{
  await sleep(2500);
  const view = await get('view（取 bvid）', 'https://api.bilibili.com/x/web-interface/view?bvid=BV1fKpP6PEpq');
  if (view?.data) {
    const keys = Object.keys(view.data).filter((k) => /pic|cover|image|frame/i.test(k));
    console.log(`  与图相关的字段: ${keys.join(', ') || '(仅 pic)'}`);
    console.log(`  pic=${String(view.data.pic)}`);
    const pages = view.data.pages ?? [];
    console.log(`  分 P 数: ${String(pages.length)}; 分 P 里的图字段: ${pages[0] ? (Object.keys(pages[0]).filter((k) => /pic|cover|image/i.test(k)).join(', ') || '(无)') : '-'}`);
  }
}
