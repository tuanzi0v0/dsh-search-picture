// Mirror the module's decoder logic exactly, printing internals, to find the divergence.
const MODULE = await import('../src/providers.js');
const { decodeBaiduObjUrl } = MODULE;

const MAP = {
  w: 'a', k: 'b', v: 'c', '1': 'd', j: 'e', u: 'f', '2': 'g', i: 'h', t: 'i',
  '3': 'j', h: 'k', s: 'l', '4': 'm', g: 'n', '5': 'o', r: 'p', q: 'q', '6': 'r',
  f: 's', p: 't', '7': 'u', e: 'v', o: 'w', '8': '1', d: '2', n: '3', '9': '4',
  c: '5', m: '6', '0': '7', b: '8', l: '9', a: '0',
};
const SEQ = [['_z2C$q', ':'], ['_z&e3B', '.'], ['AzdH3F', '/']];
const PROTO = [['ipprf_z2C$q', 'https://'], ['ippr_z2C$q', 'http://']];

function mirror(encoded) {
  let text = encoded;
  for (const [prefix, protocol] of PROTO) {
    if (text.startsWith(prefix)) { text = `${protocol}${text.slice(prefix.length)}`; break; }
  }
  for (const [sequence, plain] of SEQ) text = text.split(sequence).join(plain);
  let out = '';
  for (const char of text) out += MAP[char] ?? char;
  if (/^https?:\/\//u.test(out)) {
    try { return new URL(out).toString(); } catch (e) { return `URLERR:${e.message}:${out}`; }
  }
  return `NOMATCH:${out}`;
}

for (const input of [
  'ippr_z2C$qAzdH3FAzdH3Ffl_z&e3Bftgwt42_z&e3BvgAzdH3F4omlaAzdH3Faa8W3ZyEpymRmx3Y1p7bb&mla',
  'ipprf_z2C$qAzdH3FAzdH3Ft8_z&e3Bi1fsk_z&e3Bv54AzdH3FkufAzdH3Fw6vitejAzdH3Fjb0kjcvbcv1mvdjw0mblddun8n1ckl1vwk1na0mw_z&e3B3r2',
  'ippr_z2C$qwkkAzdH3F9mmAzdH3F7mdn',
  'ipprf_z2C$qwkkAzdH3F9mmAzdH3F7mdn',
]) {
  console.log('mirror  :', mirror(input));
  console.log('module  :', String(decodeBaiduObjUrl(input)));
  console.log('---');
}
