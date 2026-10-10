// Confirm the new output carries the direct image URL (provenance) alongside the source page.
const { formatSearchOutput } = await import('../src/host.js');

const sample = {
  query: '测试',
  directory: 'C:\\ws\\downloads',
  images: [{
    path: 'C:\\ws\\downloads\\a-01.jpg',
    fileName: 'a-01.jpg',
    mediaType: 'image/jpeg',
    bytes: 279834,
    width: 2398,
    height: 1798,
    sourceUrl: 'https://i2.hdslb.com/bfs/archive/xxxx.jpg',
    pageUrl: 'https://www.bilibili.com/video/BV172SCByEr9',
    engine: 'baidu',
    attachment: { attachmentId: 'a', mediaType: 'image/jpeg', bytes: 1, width: 1, height: 1 },
  }],
  searched: [],
  failures: [],
  notes: '',
  servedBy: ['baidu'],
};

const text = formatSearchOutput(sample);
console.log(text);
console.log('\n包含直链：', text.includes('https://i2.hdslb.com/bfs/archive/xxxx.jpg'));
console.log('包含出处：', text.includes('https://www.bilibili.com/video/BV172SCByEr9'));
process.exit(text.includes('直链：') ? 0 : 1);
