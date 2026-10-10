/**
 * 离线自测（不依赖 DSH 运行时）：
 *   1. 三个图源的解析器对真实响应体的正确性；
 *   2. 端到端：多引擎搜索 → 清晰度筛选 → 下载落盘 → 字节/尺寸校验。
 *
 * 用法：node .work/selftest.mjs ["查询词"] [张数]
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import * as providersModule from '../src/providers.js';
import {
  ENGINES,
  decodeBaiduObjUrl,
  parseBaiduJson,
  parseBilibiliArticleJson,
  parseBilibiliDrawJson,
  parseBingHtml,
  parseSo360Json,
  runEngine,
} from '../src/providers.js';
import { downloadCandidates, rankCandidates } from '../src/download.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { sanitizeQuery } from '../src/util.js';

const query = process.argv[2] ?? '可塑性记忆 艾拉';
const count = Number(process.argv[3] ?? 6);
const outDir = join(process.cwd(), '.work', 'selftest-downloads');

let failedChecks = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failedChecks += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

console.log('== 1. 解析器 ==');

// 1a. Bing：构造一段真实形状的结果片段。
{
  const item = {
    purl: 'https://example.com/a',
    murl: 'https://img.example.com/a.jpg',
    turl: 'https://tse1.mm.bing.net/th?id=OIP.x&pid=15.1',
    t: '标题 A',
  };
  const html = `<a class="iusc" style="x" m="${JSON.stringify(item).replace(/"/g, '&quot;')}"><img src=x></a>`;
  const parsed = parseBingHtml(html);
  check('bing: 解析出 1 条', parsed.length === 1, JSON.stringify(parsed));
  check('bing: imageUrl 正确', parsed[0]?.imageUrl === 'https://img.example.com/a.jpg', parsed[0]?.imageUrl);
  check('bing: pageUrl 正确', parsed[0]?.pageUrl === 'https://example.com/a');
}

// 1b. 百度：replaceUrl / objURL 解码 / 代理图退化三条取图分支。
{
  const json = JSON.stringify({
    data: [
      { thumbURL: 'https://img2.baidu.com/it/u=1&f=JPEG', middleURL: 'https://img2.baidu.com/it/u=1&f=JPEG', objURL: '', width: '1200', height: '800', fromPageTitle: '<strong>标题</strong>', fromJumpUrl: 'https://a.example/1' },
      { thumbURL: 'https://img2.baidu.com/it/u=2&f=JPEG', objURL: 'ippr_z2C$qAzdH3FAzdH3Fooo_z&e3Bktstktst_z&e3Bv54AzdH3F', replaceUrl: [{ ObjURL: 'https://i1.hdslb.com/bfs/archive/abc.jpg' }], width: '1920', height: '1080', fromPageTitleEnc: '标题二' },
      { thumbURL: 'https://img2.baidu.com/it/u=3&f=JPEG', width: 0, height: 0 },
      {},
      null,
    ],
  });
  const parsed = parseBaiduJson(json);
  check('baidu: 跳过空行后解析 3 条', parsed.length === 3, String(parsed.length));
  check('baidu: replaceUrl 优先于代理图', parsed[1]?.imageUrl === 'https://i1.hdslb.com/bfs/archive/abc.jpg', parsed[1]?.imageUrl);
  check('baidu: 无原图时标记 proxied', parsed[0]?.proxied === true && parsed[1]?.proxied === false);
  check('baidu: 宽高解析为数字', parsed[1]?.width === 1920 && parsed[1]?.height === 1080);
  check('baidu: 标题去标签', parsed[0]?.title === '标题', parsed[0]?.title);
  check('baidu: 非法 JSON 返回空数组', parseBaiduJson('not json').length === 0);
}

// 1b2. 百度 objURL 解码：权威公开样例、真实载荷、构造向量、拒绝非法载荷。
{
  check('baidu: 明文 objURL 直接通过', decodeBaiduObjUrl('https://a.example/x.jpg') === 'https://a.example/x.jpg');

  // 权威实现的公开样例（https://www.cnblogs.com/zoe233/p/8335065.html ）。
  const sample =
    'ippr_z2C$qAzdH3FAzdH3Ffl_z&e3Bftgwt42_z&e3BvgAzdH3F4omlaAzdH3Faa8W3ZyEpymRmx3Y1p7bb&mla';
  check(
    'baidu: 公开样例解码正确',
    decodeBaiduObjUrl(sample) === 'http://s9.sinaimg.cn/mw690/001WjZyEty6R6xjYdtu88&690',
    String(decodeBaiduObjUrl(sample)),
  );

  // 实测取自百度 acjson 响应的真实载荷（ipt 前缀 + 串替换 + 字符映射）。
  const real =
    'ipprf_z2C$qAzdH3FAzdH3Ft8_z&e3Bi1fsk_z&e3Bv54AzdH3FkufAzdH3Fw6vitejAzdH3Fjb0kjcvbcv1mvdjw0mblddun8n1ckl1vwk1na0mw_z&e3B3r2';
  const realOut = decodeBaiduObjUrl(real);
  check('baidu: 真实载荷解出 https 图床地址', typeof realOut === 'string' && realOut.startsWith('https://') && realOut.includes('hdslb.com'), String(realOut));

  // 没有可解析协议头的载荷必须被拒绝，避免把假地址写进结果。
  check('baidu: 无协议载荷被拒绝', decodeBaiduObjUrl('zzz_xxx') === undefined, String(decodeBaiduObjUrl('zzz_xxx')));
  check('baidu: 空串被拒绝', decodeBaiduObjUrl('') === undefined);
  check('baidu: 非字符串被拒绝', decodeBaiduObjUrl(42) === undefined);
}

// 1c. 360。
{
  const json = JSON.stringify({
    total: 2,
    list: [
      { img: 'https://i0.hdslb.com/bfs/article/x.jpg', thumb: 'https://p0.ssl.qhimgs1.com/t01.jpg', link: 'https://www.bilibili.com/read/cv1', title: '标题', width: '1080', height: '540' },
      { img: '', thumb: 'https://p0.ssl.qhimgs1.com/t02.jpg', width: 'a', height: null },
      null,
    ],
  });
  const parsed = parseSo360Json(json);
  check('360: 解析出 2 条', parsed.length === 2, String(parsed.length));
  check('360: 第二张退化到 thumb', parsed[1]?.imageUrl === 'https://p0.ssl.qhimgs1.com/t02.jpg', parsed[1]?.imageUrl);
  check('360: 非数字宽高被丢弃', parsed[1]?.width === undefined);
}

// 1d. B 站三个解析器。
{
  const articleJson = JSON.stringify({
    code: 0,
    data: {
      result: [
        { id: 46754463, title: '<em>终末地</em> 汤汤 女仆', image_urls: ['//i0.hdslb.com/bfs/article/a.jpg', 'http://i1.hdslb.com/bfs/article/b.png'], cover: '' },
        { id: 123, title: '无图专栏' },
        { id: 'x', title: 'id 不是数字' },
        null,
      ],
    },
  });
  const articles = parseBilibiliArticleJson(articleJson);
  check('bilibili: 专栏解析出正文配图', articles.length === 2, String(articles.length));
  check('bilibili: 协议相对地址被补全', articles[0]?.imageUrl.startsWith('https://i0.hdslb.com'), articles[0]?.imageUrl);
  check('bilibili: 标题去掉高亮标签', articles[0]?.title === '终末地 汤汤 女仆', articles[0]?.title);
  check('bilibili: 出处指向专栏页', articles[0]?.pageUrl === 'https://www.bilibili.com/read/cv46754463', articles[0]?.pageUrl);
  check('bilibili: 无图/非法行被跳过', articles.every((c) => c.imageUrl.includes('hdslb.com')));

  const drawJson = JSON.stringify({
    code: 0,
    data: {
      items: [
        {
          doc_id: 'd1',
          dyn_id: '987654321',
          title: '相册条目',
          pictures: [
            { img_src: 'http://i0.hdslb.com/bfs/new_dyn/one.jpg', img_width: 3000, img_height: 2000 },
            { img_src: '//i0.hdslb.com/bfs/new_dyn/two.jpg', img_width: 0, img_height: 0 },
          ],
        },
        { doc_id: 'd2', pictures: null },
      ],
    },
  });
  const draws = parseBilibiliDrawJson(drawJson);
  check('bilibili: 图文图片集一条多图', draws.length === 2, String(draws.length));
  check('bilibili: 相册图带真实尺寸', draws[0]?.width === 3000 && draws[0]?.height === 2000);
  check('bilibili: 非法尺寸被丢弃', draws[1]?.width === undefined);
  check('bilibili: 出处指向动态', draws[0]?.pageUrl === 'https://t.bilibili.com/987654321', draws[0]?.pageUrl);

  // 视频封面解析器（parseBilibiliVideoJson）**已被移除**：用户要求不使用视频封面，
  // 它就成了没有调用方的死代码。这里改为断言「它不再被导出」，
  // 防止将来又把它加回来却没接线。
  check('bilibili: 视频封面解析器不再导出（用户要求不用视频封面）', providersModule.parseBilibiliVideoJson === undefined);
}

// 1e. 排序：像素面积降序，未知尺寸排后，封面/tier 与代理图降权。
{
  const ranked = rankCandidates([
    { imageUrl: 'a', width: 100, height: 100 },
    { imageUrl: 'b' },
    { imageUrl: 'c', width: 1920, height: 1080 },
  ]);
  check('rank: 最大面积在前', ranked[0]?.imageUrl === 'c', JSON.stringify(ranked.map((r) => r.imageUrl)));
  check('rank: 未知尺寸在最后', ranked[2]?.imageUrl === 'b');

  const mixed = rankCandidates([
    { imageUrl: 'cover', width: 1920, height: 1080, tier: 'cover' },
    { imageUrl: 'real', width: 1280, height: 720 },
    { imageUrl: 'proxy', width: 4000, height: 3000, proxied: true },
  ]);
  check('rank: 低优先封面排最后', mixed[2]?.imageUrl === 'cover', JSON.stringify(mixed.map((r) => r.imageUrl)));
  check('rank: 真实原图排第一', mixed[0]?.imageUrl === 'real');
  check('rank: 代理图排第二', mixed[1]?.imageUrl === 'proxy');
}

// 1e. 文件名清洗。
{
  check('sanitize: 去掉非法字符', sanitizeQuery('a/b:c*d?e"f<g>h|i') === 'a b c d e f g h i', sanitizeQuery('a/b:c*d?e"f<g>h|i'));
  check('sanitize: 空词兜底', sanitizeQuery('   ') === 'picture');
  check('sanitize: 结尾点被去掉', sanitizeQuery('可塑性记忆...') === '可塑性记忆', sanitizeQuery('可塑性记忆...'));
}

console.log('\n== 2. 真实图源查询 ==');
const results = [];
for (const engine of ENGINES) {
  const result = await runEngine(engine, query, { timeoutMs: 25000 });
  results.push(result);
  const sizes = result.candidates.filter((c) => c.width !== undefined).length;
  console.log(`  ${engine.padEnd(9)} 候选 ${String(result.candidates.length).padStart(3)} 条（其中 ${sizes} 条带尺寸）${result.error === undefined ? '' : ` 错误=${result.error}`}`);
  // B 站搜索接口会限流（-412），这是已知的瞬时状态而不是图源失效：
  // 只要不是限流就必须有候选，是限流则只记录、不判失败。
  if (engine === 'bilibili' && /rate limited|-412/.test(String(result.error))) {
    console.log('       （B 站瞬时限流，按已知行为跳过该断言）');
    continue;
  }
  check(`${engine}: 返回候选`, result.candidates.length > 0, result.error ?? '');
}

console.log('\n== 3. 端到端下载 ==');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const seen = new Set();
const candidates = [];
for (const result of results) {
  for (const candidate of result.candidates) {
    if (seen.has(candidate.imageUrl)) continue;
    seen.add(candidate.imageUrl);
    candidates.push(candidate);
  }
}
console.log(`  合并去重后候选：${String(candidates.length)} 条`);
const started = Date.now();
const { files, failures } = await downloadCandidates(candidates, {
  directory: outDir,
  query: sanitizeQuery(query),
  count,
  minPixels: 921600,
  minLongEdge: 1000,
  maxAspectRatio: 2.6,
  minBytes: 4096,
  concurrency: 6,
  timeoutMs: 30000,
});
console.log(`  下载完成：成功 ${String(files.length)} 张，失败/淘汰 ${String(failures.length)} 条，用时 ${String(Date.now() - started)} ms`);
const byEngine = {};
for (const file of files) byEngine[file.engine] = (byEngine[file.engine] ?? 0) + 1;
console.log(`  来源分布：${JSON.stringify(byEngine)}`);
for (const failure of failures) console.log(`  - 淘汰 ${failure.engine} ${failure.reason} :: ${failure.url.slice(0, 110)}`);
const reasonCounts = {};
for (const failure of failures) {
  const key = `${failure.engine}: ${failure.reason.replace(/\(.*\)/, '').trim()}`;
  reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
}
console.log(`  失败/淘汰归类：${JSON.stringify(reasonCounts, null, 1)}`);

check('下载: 拿到至少 1 张', files.length > 0);
check('下载: 不超过请求张数', files.length <= count, String(files.length));

// 每一张都回读校验：字节存在、签名与解析尺寸一致、文件大小与记录一致。
for (const file of files) {
  const info = await stat(file.path);
  const bytes = new Uint8Array(await readFile(file.path));
  const mediaType = sniffImageMediaType(bytes);
  const size = imageSize(bytes, mediaType);
  const ok =
    info.size === file.bytes &&
    mediaType === file.mediaType &&
    size?.width === file.width &&
    size?.height === file.height;
  check(`落盘 ${file.fileName} (${String(file.width)}x${String(file.height)}, ${String(file.bytes)}B, ${file.engine})`, ok,
    `stat=${String(info.size)} sniff=${String(mediaType)} size=${JSON.stringify(size)}`);
}

console.log(`\n目录：${outDir}`);
console.log(`\n断言失败数：${String(failedChecks)}`);
process.exit(failedChecks === 0 ? 0 : 1);
