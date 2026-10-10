/**
 * 前置检查：B 站去掉「视频封面」兜底后，专栏正文配图/图文图片集是否仍能独立支撑？
 *
 * 用户要求「B 站搜索的图片不许用人家的视频封面」，所以必须先确认：
 *   1. 专栏搜索（article leg）单独能不能稳定给出候选；
 *   2. 限流恢复后能否连续两次成功（说明不是靠碰运气）；
 *   3. 候选图片的实际分辨率分布（720p/1080p 以上各占多少）。
 */
import { sniffImageMediaType, imageSize } from '../src/image.js';
import { runEngine } from '../src/providers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('=== 只用 article leg（禁用封面兜底）====');
for (const [index, query] of ['终末地', '可塑性记忆 艾拉', '原神 芙宁娜'].entries()) {
  if (index > 0) await sleep(5000); // 避开匿名限流
  const result = await runEngine('bilibili', query, { timeoutMs: 25000 });
  const covers = result.candidates.filter((c) => c.tier === 'cover').length;
  console.log(`  "${query}": 候选 ${String(result.candidates.length)} 条, 其中封面 ${String(covers)} 条, error=${result.error ?? '-'}`);
}

console.log('\n=== 专栏正文配图的实际分辨率分布 ===');
{
  // 直接量真实字节，而不是相信接口给的宽高。
  const result = await runEngine('bilibili', '终末地 角色', { timeoutMs: 25000 });
  const urls = result.candidates.slice(0, 12).map((c) => c.imageUrl);
  console.log(`  取样 ${String(urls.length)} 张：`);
  const buckets = { '>=1920': 0, '>=1280': 0, '<1280': 0, fail: 0 };
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*', referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const type = sniffImageMediaType(bytes);
      const size = type === undefined ? undefined : imageSize(bytes, type);
      if (size === undefined) {
        buckets.fail += 1;
        console.log(`    ? 无法解析 ${String(bytes.length)}B`);
        continue;
      }
      const longEdge = Math.max(size.width, size.height);
      const pixels = size.width * size.height;
      const ratio = longEdge / Math.min(size.width, size.height);
      if (longEdge >= 1920 && pixels >= 921600) buckets['>=1920'] += 1;
      else if (pixels >= 921600) buckets['>=1280'] += 1;
      else buckets['<1280'] += 1;
      console.log(`    ${longEdge >= 1920 ? '1080p+' : pixels >= 921600 ? '720p+' : '低清  '} ${String(size.width)}x${String(size.height)} 比例${ratio.toFixed(1)} ${String(bytes.length)}B`);
    } catch (error) {
      buckets.fail += 1;
      console.log(`    ERR ${error.message}`);
    }
  }
  console.log(`  统计：1080p+ ${String(buckets['>=1920'])}, 720p+ ${String(buckets['>=1280'])}, 低清 ${String(buckets['<1280'])}, 失败 ${String(buckets.fail)}`);
}
