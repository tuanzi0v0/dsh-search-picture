/**
 * 官网图源自测：
 *   1. `looksOfficial` 的判定逻辑（官网 vs 第三方站）；
 *   2. `extractSearchResults` 能从真实 Bing 结果页里认出官网；
 *   3. `extractImageUrls` **不截断**查询串（回归：曾经把 20 张可下载的大图误判成 404）；
 *   4. 端到端：找到官网 → 抽图 → 下载 → 量分辨率，并对 ≥720p 的比例给出结论。
 */
import { collectOfficialImages, extractImageUrls, extractSearchResults, findOfficialSite, looksOfficial } from '../src/official.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

console.log('== 1. looksOfficial 判定 ==');
{
  const cases = [
    ['https://endfield.hypergryph.com/', '《明日方舟：终末地》官方网站-Arknights: Endfield', true],
    ['https://endfield.hypergryph.com/news/7231', '《明日方舟：终末地》官方网站', true],
    ['https://www.bilibili.com/video/BV1xx', '终末地攻略', false],
    ['https://www.9game.cn/mrfz/11670294.html', '终末地角色前瞻', false],
    ['https://www.taptap.cn/moment/847884', '提弗洛斯 - TapTap', false],
    ['https://baike.baidu.com/item/xxx', '百度百科', false],
    ['not-a-url', 'xxx', false],
  ];
  for (const [url, title, expected] of cases) {
    const judged = looksOfficial(url, title);
    check(`${expected ? '官网' : '非官网'}：${url.slice(0, 46)}`, judged.official === expected, `实际=${String(judged.official)} (${judged.reason})`);
  }
}

console.log('\n== 2. 搜索页结果抽取 ==');
{
  const html = `
    <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=xx">跳转</a></h2></li>
    <li class="b_algo"><h2><a href="https://endfield.hypergryph.com/" target="_blank">《明日方舟：终末地》官方网站-Arknights: Endfield</a></h2></li>
    <li class="b_algo"><h2><a href="https://www.9game.cn/mrfz/11670294.html">终末地攻略_九游</a></h2></li>
    <li><a href="https://www.bilibili.com/video/BV1xx">B站视频</a></li>
  `;
  const results = extractSearchResults(html);
  check('抽取到 3 条站外结果（过滤掉 bing 跳转）', results.length === 3, JSON.stringify(results.map((r) => r.url)));
  check('标题被解码且去标签', results[0]?.title.startsWith('《明日方舟：终末地》'), results[0]?.title);
  const picked = results.map((r) => looksOfficial(r.url, r.title)).find((j) => j.official);
  check('能在结果里认出官网', picked !== undefined, JSON.stringify(results));
}

console.log('\n== 3. 图片地址抽取不截断查询串（回归测试） ==');
{
  const html = `
    <img src="https://cdn.example.com/a.png?x-oss-process=image/resize,w_1920&v=2">
    <img data-src="//cdn.example.com/b.jpg">
    <script>var m = "https://web.hycdn.cn/upload/image/20260930/abc.png";</script>
    <img src="data:image/gif;base64,R0lGOD">
    <img src="/local/c.webp">
  `;
  const urls = extractImageUrls(html, 'https://official.example.com/page');
  const withQuery = urls.find((url) => url.includes('x-oss-process'));
  check('带查询串的地址被完整保留（& 不被当分隔符）', withQuery !== undefined && withQuery.includes('v=2'), JSON.stringify(urls));
  check('协议相对地址被补全为 https', urls.some((url) => url === 'https://cdn.example.com/b.jpg'), JSON.stringify(urls));
  check('内联脚本里的绝对地址被抽出', urls.some((url) => url.includes('hycdn.cn/upload/image')), JSON.stringify(urls));
  check('data: URI 不被当成图片', !urls.some((url) => url.startsWith('data:')), JSON.stringify(urls));
  check('站内相对路径不产出（不是图片直链）', !urls.some((url) => url.includes('/local/c.webp')), JSON.stringify(urls));
}

console.log('\n== 4. 端到端：找官网 → 抽图 → 下载 ==');
{
  const found = await findOfficialSite('明日方舟 终末地', { timeoutMs: 20000 });
  console.log(`  官网：${found.site ?? '(未找到)'}  ${found.reason}${found.error === undefined ? '' : `  error=${found.error}`}`);
  check('找到了官网', found.site !== undefined, found.error ?? found.reason);
  if (found.site !== undefined) {
    check('官网地址看起来是官方域名', /hypergryph\.com|gryphline\.com/.test(found.site), found.site);

    const collected = await collectOfficialImages(found.site, { timeoutMs: 25000, limit: 12 });
    console.log(`  抽出候选 ${String(collected.candidates.length)} 条（status=${String(collected.status)}）`);
    check('抽到了图片候选', collected.candidates.length > 0, collected.error ?? '');
    check('候选标记为 official 档位', collected.candidates.every((c) => c.tier === 'official'));
    check('候选带首页出处', collected.candidates.every((c) => c.pageUrl === collected.pageUrl));

    let ok = 0;
    let big = 0;
    for (const candidate of collected.candidates.slice(0, 10)) {
      try {
        const response = await fetch(candidate.imageUrl, {
          headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*', referer: collected.pageUrl },
          signal: AbortSignal.timeout(20000),
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const mediaType = sniffImageMediaType(bytes);
        const size = mediaType === undefined ? undefined : imageSize(bytes, mediaType);
        const pixels = size === undefined ? 0 : size.width * size.height;
        if (response.status === 200) ok += 1;
        if (pixels >= 921600) big += 1;
        console.log(`    ${pixels >= 921600 ? '✅' : '  '} ${String(response.status)} ${size === undefined ? '?' : `${String(size.width)}x${String(size.height)}`} ${String(bytes.length)}B`);
      } catch (error) {
        console.log(`    ❌ ${error.message.slice(0, 40)}`);
      }
    }
    console.log(`  → 抽样中 HTTP 200 的 ${String(ok)} 张，达 720p 的 ${String(big)} 张`);
    check('官网图片可下载', ok > 0, String(ok));
    check('官网图片多为高清（≥720p）', big > 0, String(big));
  }
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
