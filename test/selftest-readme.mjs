/**
 * 任务 3 的收尾：把 README 里**可验证的声明**逐条与源码/运行时比对。
 *
 * 不靠人工阅读（容易漏），而是把「文档说了什么」和「代码实际是什么」都取出来做断言。
 * 任何一条对不上都会列出来。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库根目录，**按脚本自身位置推导**而不是 `process.cwd()`。
 *
 * 原因：这个脚本既可能从仓库根跑（`node test/selftest-readme.mjs`），
 * 也可能从 `test/` 里跑（`node selftest-readme.mjs`）。用 cwd 会在第二种情况下
 * 找不到 `README.md` / `index.js` 而失败——这是实测到的。
 */
const here = dirname(fileURLToPath(import.meta.url));
const ws = here.replace(/[\\/]test$/, '').replace(/[\\/]\.work$/, '');
const read = (rel) => readFileSync(join(ws, rel), 'utf8');

const readme = read('README.md');
const indexSource = read('index.js');
const providersSource = read('src/providers.js');
const downloadSource = read('src/download.js');
const librarySource = read('src/library.js');
const hostSource = read('src/host.js');
const pkg = JSON.parse(read('package.json'));

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label}  ${detail}`);
  }
};

console.log('== A. 配置项：README 是否与 Config 一一对应 ==');
{
  const configBlock = /export const Config = z\.object\(\{(?<body>[\s\S]*?)\n\}\);/.exec(indexSource)?.groups?.body ?? '';
  const codeKeys = [...configBlock.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  // README 配置示例里出现的键
  const yamlBlock = /```yaml(?<body>[\s\S]*?)```/.exec(readme)?.groups?.body ?? '';
  const docKeys = [...yamlBlock.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  console.log(`    代码里有 ${String(codeKeys.length)} 个键：${codeKeys.join(', ')}`);
  console.log(`    文档里写了 ${String(docKeys.length)} 个键：${docKeys.join(', ')}`);
  const missing = codeKeys.filter((k) => !docKeys.includes(k));
  const extra = docKeys.filter((k) => !codeKeys.includes(k));
  check('文档没有漏掉任何配置键', missing.length === 0, `漏：${missing.join(', ')}`);
  check('文档没有编造不存在的配置键', extra.length === 0, `多：${extra.join(', ')}`);
}

console.log('\n== B. 默认值：文档写的数字是否与代码一致 ==');
{
  const pairs = [
    ['count', 6], ['minPixels', 921600], ['minLongEdge', 1000], ['maxAspectRatio', 2.6],
    ['minBytes', 4096], ['concurrency', 6], ['fetchTimeoutMs', 30000], ['searchTimeoutMs', 20000],
  ];
  for (const [key, expected] of pairs) {
    const re = new RegExp(`${key}: z\\.number\\(\\)\\.default\\((\\d+(?:\\.\\d+)?)`);
    const actual = Number(re.exec(indexSource)?.[1]);
    const inDoc = readme.includes(`${key}:`) ;
    check(`${key} 默认值 ${String(expected)}（文档提到=${String(inDoc)}）`, actual === expected, `代码=${String(actual)}`);
  }
  check('maxBytes 默认 12 MiB', indexSource.includes("maxBytes: z.number().default(12 * 1024 * 1024)"));
  check('album 默认空串（=系统图片文件夹）', indexSource.includes("album: z.string().default('')"));
  check('albumName 默认 dsh-search-picture', indexSource.includes("albumName: z.string().default('dsh-search-picture')"));
  check('autoCleanPreview 默认 true', indexSource.includes('autoCleanPreview: z.boolean().default(true)'));
  check('officialSite 默认 false', indexSource.includes('officialSite: z.boolean().default(false)'));
  check('safebooru 默认 true', indexSource.includes('safebooru: z.boolean().default(true)'));
}

console.log('\n== C. 图源：README 的引擎描述是否与代码一致 ==');
{
  const engines = [...(/export const ENGINES = \[(?<body>[^\]]*)\]/.exec(providersSource)?.groups?.body ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  console.log(`    代码 ENGINES = ${engines.join(', ')}`);
  check('4 个并发图源（bing/baidu/so360/bilibili）', JSON.stringify(engines) === JSON.stringify(['bing', 'baidu', 'so360', 'bilibili']), JSON.stringify(engines));
  check('README 写了这 4 个图源', ['Bing', '百度', '360', '哔哩哔哩'].every((n) => readme.includes(n)));
  check('safebooru 不在 ENGINES 里（因为只认标签，单独调用）', !engines.includes('safebooru'));
  check('README 说明 Safebooru 需 tags', readme.includes('tags') && readme.includes('Safebooru'));
  // 视频封面：解析器必须不存在，README 必须说明不用它
  check('视频封面解析器已移除', !providersSource.includes('parseBilibiliVideoJson'));
  check('README 说明「不使用视频封面」', readme.includes('不使用视频封面'));
  // B 站只走 article
  check('B 站只配置了 article 入口', providersSource.includes("search_type=article") && !providersSource.includes('search_type=video'));
}

console.log('\n== D. 排序与清晰度：文档描述是否与实现一致 ==');
{
  check('排序函数存在降权项（代理图/标题图）', downloadSource.includes('penaltyOf') && downloadSource.includes("candidate.proxied === true"));
  check('排序按像素面积降序', /areaB - areaA/.test(downloadSource));
  check('排序含「知乎/B站优先」的并列项', downloadSource.includes('PREFERRED_HOSTS') && downloadSource.includes('zhimg.com'));
  check('README 描述「面积相同时知乎/B站优先」', readme.includes('面积相同时') && readme.includes('知乎/B 站优先'));
  check('下载后三重校验（面积/长边/长宽比）', downloadSource.includes('minPixels') && downloadSource.includes('minLongEdge') && downloadSource.includes('maxAspectRatio'));
  check('README 说明保底 720p 与三重校验', readme.includes('保底 720p') && readme.includes('长边 ≥1000') && readme.includes('长宽比 ≤2.6'));
}

console.log('\n== E. 相册与预览区：行为描述是否与实现一致 ==');
{
  check('library 实现 saveToAlbum', librarySource.includes('export async function saveToAlbum'));
  check('library 实现 pruneStaging（自动清理）', librarySource.includes('export async function pruneStaging'));
  check('host 在搜索时调用 pruneStaging', hostSource.includes('await pruneStaging(root, batch.id)'));
  check('README 说明自动清理且在配置里有开关', readme.includes('自动清理') && readme.includes('autoCleanPreview'));
  check('写入是复制而非移动（saveToAlbum 用 readFile+writeFile）', librarySource.includes('const data = await readFile(from)') && librarySource.includes('await writeFile(to, data)'));
  check('README 说明「复制而非移动」', readme.includes('复制而非移动'));
  check('相册重名追加序号', librarySource.includes('availableName(albumDir, name)'));
  check('README 说明重名追加 -2/-3', readme.includes('-2') && readme.includes('绝不覆盖'));
  check('相册目录解析默认落在 Pictures', hostSource.includes("join(home, 'Pictures')"));
}

console.log('\n== F. 其他文档声明 ==');
{
  check('trace 环境变量名一致', downloadSource.includes('DSH_SEARCH_PICTURE_TRACE') && readme.includes('DSH_SEARCH_PICTURE_TRACE'));
  check('退避间隔一致（2.5/5/7.5s）', providersSource.includes('[2500, 5000, 7500]') && readme.includes('2.5s/5s/7.5s'));
  check('hotlinkFriendly 在代码与文档里都有', downloadSource.includes('isHotlinkFriendly') && hostSource.includes('hotlinkFriendly') && readme.includes('hotlinkFriendly'));
  check('README 不再写死旧版本号', !/dsh-search-picture-0\.\d+\.\d+\.tgz/.test(readme));
  check('README 里引用的版本号与 package.json 一致（若提到）', !readme.includes('0.2.0.tgz'));
  check('package.json 的 files 含 LICENSE 且文件存在', pkg.files.includes('LICENSE') && readFileSync(join(ws, 'LICENSE'), 'utf8').includes('MIT'));
  check('README 提到的 type=article 与 link_draw 都在代码里', providersSource.includes('search_type=article') && providersSource.includes('link_draw'));
}

console.log('\n== G. 新功能：相关站点与水印过滤（README 是否说明） ==');
{
  const relatedSource = read('src/related.js');
  check('代码实现 collectRelatedCandidates', relatedSource.includes('export async function collectRelatedCandidates'));
  check('代码里有萌娘百科站点定义', relatedSource.includes('zh.moegirl.org.cn'));
  check('代码用 opensearch 找词条（list=search 未授权）', relatedSource.includes('action=opensearch'));
  check('代码用 generator=images 取图（prop=imageinfo 未授权）', relatedSource.includes('generator=images'));
  check('代码识别 WAF 拦截页', relatedSource.includes('blocked: true') && relatedSource.includes('startsWith'));
  check('README 说明萌娘百科默认开启', readme.includes('萌娘百科') && readme.includes('relatedSites'));
  check('README 说明 generator=images 这个坑', readme.includes('generator=images') && readme.includes('Unauthorized'));
  check('README 说明 biligame 会被 WAF 拦', readme.includes('biligame') && readme.includes('567'));
  check('代码实现 isWatermarkRisk', downloadSource.includes('export function isWatermarkRisk'));
  check('代码内置图库站黑名单', downloadSource.includes('58pic.com') && downloadSource.includes('gettyimages.com'));
  check('水印候选在下载前被剔除', downloadSource.includes('watermarkBlocked'));
  check('README 说明水印过滤的能力边界', readme.includes('无法通用地判断') || readme.includes('无法通用判断'));
  check('README 说明 watermarkHosts 可追加', readme.includes('watermarkHosts'));
  check('host 把 watermarkHosts 传给下载器', hostSource.includes('watermarkHosts'));
  check('结果里报告水印排除数量', hostSource.includes('不带水印'));
}

console.log('\n== H. 使用说明完整性（防止再次「有功能没用法」） ==');
{
  // 关键：配置示例里声称的键数量必须与代码一致（上一轮就漏过一次）。
  const configBlock = /export const Config = z\.object\(\{(?<body>[\s\S]*?)\n\}\);/.exec(indexSource)?.groups?.body ?? '';
  const codeKeys = [...configBlock.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  const claimed = /一一对应\*\*（共 (\d+) 个）/.exec(readme)?.[1];
  check(`README 声称的键数量（${String(claimed)}）与代码一致（${String(codeKeys.length)}）`, Number(claimed) === codeKeys.length, `claimed=${String(claimed)} code=${String(codeKeys.length)}`);

  // 必须有「怎么用」而不只是「是什么」。
  check('README 有触发方式对照表（query vs tags）', readme.includes('触发方式与 Safebooru 不同'));
  check('README 说明相关站点用 query 检索', readme.includes('每轮都会查'));
  check('README 给了加站点的代码片段', readme.includes('RELATED_SITES') && readme.includes('你的站点'));
  check('README 给了关掉整条通路的方法', readme.includes('relatedSites: []'));
  check('README 给了水印过滤的追加示例', readme.includes('watermarkHosts: [example-watermark-site.com]'));
  check('排障补了「没有匹配的词条」', readme.includes('没有匹配的词条'));
  check('排障补了「被 WAF 拦截」', readme.includes('被 WAF 拦截（HTTP 567）'));
  check('排障补了「候选比预期少」的排查', readme.includes('候选数量比预期少'));
  // 配置示例必须能被正确解析：数组用行内字面量，块序列形式在 JS 配置对象里会配错。
  const yamlBlock = /```yaml(?<body>[\s\S]*?)```/.exec(readme)?.groups?.body ?? '';
  check('relatedSites 在配置示例里是行内数组', /relatedSites: \[moegirl\]/.test(yamlBlock), '必须是 relatedSites: [moegirl]');
}

console.log(`\n断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
