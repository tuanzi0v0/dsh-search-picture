// Call the real decodeBaiduObjUrl on the three vectors and print the raw pipeline state.
const { decodeBaiduObjUrl } = await import('../src/providers.js');

const vectors = [
  ['public-http', 'ippr_z2C$qAzdH3FAzdH3Ffl_z&e3Bftgwt42_z&e3BvgAzdH3F4omlaAzdH3Faa8W3ZyEpymRmx3Y1p7bb&mla'],
  ['real-ipt', 'ipprf_z2C$qAzdH3FAzdH3Ft8_z&e3Bi1fsk_z&e3Bv54AzdH3FkufAzdH3Fw6vitejAzdH3Fjb0kjcvbcv1mvdjw0mblddun8n1ckl1vwk1na0mw_z&e3B3r2'],
  ['synth-http', 'ippr_z2C$qwkkAzdH3F9mmAzdH3F7mdn'],
  ['synth-https', 'ipprf_z2C$qwkkAzdH3F9mmAzdH3F7mdn'],
  ['plain', 'https://a.example/x.jpg'],
  ['garbage', 'zzz_xxx'],
];

for (const [label, input] of vectors) {
  console.log(`${label.padEnd(12)} -> ${String(decodeBaiduObjUrl(input))}`);
}
