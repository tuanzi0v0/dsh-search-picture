/**
 * 萌娘百科 imageinfo 为什么解析不出 URL？直接打印原始返回。
 */
import { BROWSER_UA } from '../src/util.js';

const MOE = 'https://zh.moegirl.org.cn/api.php';

async function raw(label, url) {
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  console.log(`\n--- ${label} ---`);
  console.log(`HTTP ${String(res.status)}  ${String(text.length)}B`);
  console.log(text.slice(0, 900));
  return text;
}

// 1) 单个本地文件
await raw('imageinfo: File:PLASTIC MEMORIES.jpg', `${MOE}?action=query&titles=${encodeURIComponent('File:PLASTIC MEMORIES.jpg')}&prop=imageinfo&iiprop=url&format=json`);
await new Promise((r) => setTimeout(r, 500));

// 2) 多文件（用 | 分隔）
await raw('imageinfo 多文件', `${MOE}?action=query&titles=${encodeURIComponent('File:PLASTIC MEMORIES.jpg|File:PM-Logo.png')}&prop=imageinfo&iiprop=url|size&format=json`);
await new Promise((r) => setTimeout(r, 500));

// 3) 用 generator=images 一步到位
await raw('generator=images + imageinfo', `${MOE}?action=query&generator=images&titles=${encodeURIComponent('可塑性记忆')}&gimlimit=10&prop=imageinfo&iiprop=url|size&format=json`);
await new Promise((r) => setTimeout(r, 500));

// 4) 试试不带 iiprop
await raw('imageinfo 无 iiprop', `${MOE}?action=query&titles=${encodeURIComponent('File:PM-Logo.png')}&prop=imageinfo&format=json`);
