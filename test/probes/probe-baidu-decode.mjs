// Step through the baidu decoder to find where the authoritative sample breaks.
const sample = Buffer.from(process.argv[2], 'base64').toString('utf8');
console.log('input   :', JSON.stringify(sample));

const SEQUENCES = [['_z2C$q', ':'], ['_z&e3B', '.'], ['AzdH3F', '/']];
const MAP = {
  w: 'a', k: 'b', v: 'c', '1': 'd', j: 'e', u: 'f', '2': 'g', i: 'h', t: 'i',
  '3': 'j', h: 'k', s: 'l', '4': 'm', g: 'n', '5': 'o', r: 'p', q: 'q', '6': 'r',
  f: 's', p: 't', '7': 'u', e: 'v', o: 'w', '8': '1', d: '2', n: '3', '9': '4',
  c: '5', m: '6', '0': '7', b: '8', l: '9', a: '0',
};

let text = sample;
if (text.startsWith('ippr')) text = text.slice(4);
console.log('after ippr:', JSON.stringify(text));
for (const [sequence, plain] of SEQUENCES) {
  text = text.split(sequence).join(plain);
  console.log(`after ${JSON.stringify(sequence)} -> ${JSON.stringify(plain)}:`, JSON.stringify(text));
}
let out = '';
for (const char of text) out += MAP[char] ?? char;
console.log('mapped  :', JSON.stringify(out));
console.log('expected:', JSON.stringify('http://s9.sinaimg.cn/mw690/001WjZyEty6R6xjYdtu88&690'));
console.log('equal   :', out === 'http://s9.sinaimg.cn/mw690/001WjZyEty6R6xjYdtu88&690');
