/* test.js — validação das libs puras. Uso: node test/test.js [caminho-do-perfil.icc]
 * Cobre PackBits, estrutura do TIFF, conversão sem perfil e a leitura da tabela B2A.
 */
const fs = require('fs');
const path = require('path');

const { Color } = require('../lib/color.js');
const { ICC } = require('../lib/icc.js');
const { Tiff } = require('../lib/tiff.js');
const { PdfX } = require('../lib/pdfx.js');
const { Presets } = require('../lib/preset.js');
const { QR } = require('../lib/qr.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// Amostragem determinística: sem semente, o pior caso varia a cada rodada e o
// teste passa a acusar azar em vez de regressão.
function makeRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = makeRandom(20240818);
function randByte() { return Math.floor(rand() * 256); }

// ------------------------------------------------------------------ PackBits

function unpackBits(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const n = src[i++];
    if (n < 128) { for (let k = 0; k <= n; k++) out.push(src[i++]); }
    else if (n > 128) { const b = src[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
  }
  return Uint8Array.from(out);
}

console.log('PackBits');
{
  const cases = [
    new Uint8Array([1, 2, 3, 4, 5]),
    new Uint8Array(300).fill(7),
    Uint8Array.from({ length: 1000 }, (_, i) => (i % 17 < 9 ? 42 : i % 251)),
    new Uint8Array(0),
    Uint8Array.from({ length: 5000 }, (_, i) => (i / 200 | 0) % 256)
  ];
  let allOk = true, shrinks = false;
  for (const c of cases) {
    const enc = Tiff.packBits(c);
    const dec = unpackBits(enc);
    if (dec.length !== c.length || dec.some((v, i) => v !== c[i])) allOk = false;
    if (c.length > 100 && enc.length < c.length) shrinks = true;
  }
  check('roundtrip em todos os casos', allOk);
  check('comprime dados repetitivos', shrinks);
}

// ---------------------------------------------------------- conversão simples

console.log('Conversão sem perfil');
{
  const white = Color.naiveRgbToCmyk(1, 1, 1, { gcr: 1, inkLimit: 400 });
  check('branco = sem tinta', white.every(v => near(v, 0, 1e-9)));

  const black = Color.naiveRgbToCmyk(0, 0, 0, { gcr: 1, inkLimit: 400 });
  check('preto com GCR 100% = só K', near(black[3], 1, 1e-9) && black.slice(0, 3).every(v => near(v, 0, 1e-9)));

  const red = Color.naiveRgbToCmyk(1, 0, 0, { gcr: 1, inkLimit: 400 });
  check('vermelho = M+Y', near(red[0], 0, 1e-9) && near(red[1], 1, 1e-9) && near(red[2], 1, 1e-9) && near(red[3], 0, 1e-9));

  const limited = Color.naiveRgbToCmyk(0.05, 0.05, 0.2, { gcr: 0.5, inkLimit: 260 });
  const total = limited.reduce((a, b) => a + b, 0) * 100;
  check('respeita o limite de tinta (260%)', total <= 260.01, 'total=' + total.toFixed(1));

  const noGcr = Color.naiveRgbToCmyk(0.2, 0.4, 0.6, { gcr: 0, inkLimit: 400 });
  check('GCR 0% não gera preto', near(noGcr[3], 0, 1e-9));
}

// ------------------------------------------------------------------ LUT 3D

console.log('LUT 3D');
{
  const opt = { gcr: 1, inkLimit: 400 };
  const lut = Color.buildRgbToCmykLut((r, g, b) => Color.naiveRgbToCmyk(r, g, b, opt), 33);
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 0]);
  const out = Color.rgbaToCmykWithLut(px, lut, [1, 1, 1]);
  check('branco -> 0,0,0,0', out[0] === 0 && out[1] === 0 && out[2] === 0 && out[3] === 0);
  check('preto -> K=255', out[7] === 255 && out[4] === 0);
  check('vermelho -> M=Y=255', out[8] === 0 && out[9] === 255 && out[10] === 255);
  check('alfa 0 compõe sobre o fundo branco', out[12] === 0 && out[15] === 0);

  // O caminho direto é o que roda sem perfil, e tem de ser exato.
  // (A precisão da LUT é medida na seção do ICC, que é onde ela é usada de fato.)
  let directErr = 0;
  for (let i = 0; i < 500; i++) {
    const R = randByte(), G = randByte(), B = randByte();
    const exact = Color.naiveRgbToCmyk(R / 255, G / 255, B / 255, opt);
    const got = Color.rgbaToCmykDirect(new Uint8ClampedArray([R, G, B, 255]),
      (r, g, b) => Color.naiveRgbToCmyk(r, g, b, opt), [1, 1, 1]);
    for (let c = 0; c < 4; c++) directErr = Math.max(directErr, Math.abs(got[c] - Math.round(exact[c] * 255)));
  }
  check('caminho direto bate com a fórmula (<= 1/255)', directErr <= 1, 'max=' + directErr);
}

// -------------------------------------------------------------- TIFF: escrita

function readTiff(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = buf[0] === 0x49;
  if (!le || v.getUint16(2, true) !== 42) throw new Error('cabeçalho inválido');
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  const tags = {};
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = v.getUint16(p, true), type = v.getUint16(p + 2, true), count = v.getUint32(p + 4, true);
    const bytes = SIZE[type] * count;
    const off = bytes <= 4 ? p + 8 : v.getUint32(p + 8, true);
    const vals = [];
    for (let k = 0; k < count; k++) {
      if (type === 3) vals.push(v.getUint16(off + k * 2, true));
      else if (type === 4) vals.push(v.getUint32(off + k * 4, true));
      else if (type === 5) vals.push(v.getUint32(off + k * 8, true) / v.getUint32(off + k * 8 + 4, true));
      else vals.push(v.getUint8(off + k));
    }
    tags[tag] = { type, count, values: vals, offset: off };
  }
  return { tags, nextIfd: v.getUint32(ifd + 2 + n * 12, true) };
}

console.log('TIFF');
{
  const W = 64, H = 40;
  const cmyk = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      cmyk[o] = x * 4 % 256; cmyk[o + 1] = y * 6 % 256; cmyk[o + 2] = 128; cmyk[o + 3] = 20;
    }
  }
  const icc = fs.existsSync(process.argv[2] || '') ? new Uint8Array(fs.readFileSync(process.argv[2])) : null;

  for (const compression of ['none', 'packbits']) {
    const out = Tiff.writeCmykTiff({ width: W, height: H, cmyk, dpi: 300, icc, compression });
    const { tags, nextIfd } = readTiff(out);
    const label = '[' + compression + '] ';
    check(label + 'largura/altura', tags[256].values[0] === W && tags[257].values[0] === H);
    check(label + '4 canais de 8 bits', tags[277].values[0] === 4 && tags[258].values.join() === '8,8,8,8');
    check(label + 'photometric = 5 (CMYK)', tags[262].values[0] === 5);
    check(label + 'compressão declarada', tags[259].values[0] === (compression === 'packbits' ? 32773 : 1));
    check(label + '300 DPI por polegada', tags[282].values[0] === 300 && tags[283].values[0] === 300 && tags[296].values[0] === 2);
    check(label + 'InkSet CMYK', tags[332].values[0] === 1);
    check(label + 'IFD termina em 0', nextIfd === 0);
    check(label + 'tags em ordem crescente', (() => {
      const keys = Object.keys(tags).map(Number);
      return keys.every((k, i) => i === 0 || keys[i - 1] < k);
    })());
    if (icc) check(label + 'ICC embutido com o tamanho certo', tags[34675] && tags[34675].count === icc.length);

    // strips devolvem exatamente os bytes originais
    const stripOffsets = tags[273].values, stripCounts = tags[279].values;
    const rows = tags[278].values[0];
    let decoded = [];
    stripOffsets.forEach((off, i) => {
      const raw = out.subarray(off, off + stripCounts[i]);
      decoded = decoded.concat(Array.from(compression === 'packbits' ? unpackBits(raw) : raw));
    });
    check(label + 'pixels preservados', decoded.length === cmyk.length && decoded.every((v, i) => v === cmyk[i]),
      'rowsPerStrip=' + rows);
    fs.writeFileSync(path.join(__dirname, 'out-' + compression + '.tif'), out);
  }
}

// ----------------------------------------------------------- TIFF: deflate

async function testDeflate() {
  console.log('TIFF deflate');
  const W = 128, H = 96;
  const cmyk = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      cmyk[o] = x % 256; cmyk[o + 1] = y % 256; cmyk[o + 2] = 200; cmyk[o + 3] = y < H / 2 ? 0 : 255;
    }
  }
  if (typeof CompressionStream === 'undefined') {
    console.log('  skip  CompressionStream indisponível neste runtime');
    return;
  }
  const { strips, rowsPerStrip } = await Tiff.deflateStrips(cmyk, W, H);
  const out = Tiff.writeCmykTiff({ width: W, height: H, strips, rowsPerStrip, compression: 'deflate', dpi: 300 });
  const { tags } = readTiff(out);
  check('compressão declarada = 8 (deflate)', tags[259].values[0] === 8);
  check('300 DPI preservado', tags[282].values[0] === 300);
  check('menor que os dados crus', out.length < cmyk.length, out.length + ' vs ' + cmyk.length);

  // descomprime com zlib e confere byte a byte
  const zlib = require('zlib');
  const offsets = tags[273].values, counts = tags[279].values;
  const parts = offsets.map((off, i) => zlib.inflateSync(Buffer.from(out.subarray(off, off + counts[i]))));
  const joined = Buffer.concat(parts);
  check('pixels idênticos após inflate', joined.length === cmyk.length && joined.every((v, i) => v === cmyk[i]));
  fs.writeFileSync(path.join(__dirname, 'out-deflate.tif'), out);
}

// -------------------------------------------------------------------- presets

console.log('Preset da editora')
{
  const edg = Presets.active;
  check('existe um preset ativo, sem escolha', !!edg && !!edg.settings);
  check('gera PDF/X a 300 DPI', edg.settings.format === 'pdfx' && edg.settings.dpi === 300);
  check('separa pelo perfil da casa', /SWOP \(Jornal\)/.test(edg.profiles.separation));
  check('declara SNAP 2007 no OutputIntent', /SNAP 2007/.test(edg.profiles.outputIntent));
  check('os dois papéis são perfis diferentes', edg.profiles.separation !== edg.profiles.outputIntent);

  const completo = {
    hasSeparation: true, hasOutputIntent: true,
    separationName: 'SWOP (Jornal), 30%, GCR, Carregado',
    outputIntentName: 'US Newsprint (SNAP 2007)',
    dpi: 300, format: 'pdfx'
  };
  check('com tudo em ordem, libera sem ressalva', (() => {
    const r = Presets.validate(edg, completo);
    return r.ok && !r.warnings.length;
  })());
  check('sem perfil de separação, barra', !Presets.validate(edg, Object.assign({}, completo, { hasSeparation: false })).ok);
  check('sem OutputIntent em PDF/X, barra', !Presets.validate(edg, Object.assign({}, completo, { hasOutputIntent: false })).ok);
  check('avisa se a separação muda', Presets.validate(edg, Object.assign({}, completo, {
    separationName: 'US Newsprint (SNAP 2007)' })).warnings.some(w => /chapa/.test(w)));
  check('avisa se o DPI cai', Presets.validate(edg, Object.assign({}, completo, { dpi: 150 })).warnings.some(w => /150/.test(w)));

  // A paleta é o atalho de cor: nenhuma tinta dela pode passar do limite do papel
  const acima = Presets.inks.filter(i => Presets.totalInk(i.cmyk) > edg.inkLimit);
  check('paleta inteira dentro do limite de tinta', !acima.length,
    acima.map(i => i.name + ' ' + Presets.totalInk(i.cmyk) + '%').join(', '));
  check('paleta traz preto de texto e reforçado',
    Presets.inks.some(i => i.cmyk.join() === '0,0,0,1') &&
    Presets.inks.some(i => i.cmyk[3] === 1 && i.cmyk[0] > 0));
  check('soma de tinta em %', Presets.totalInk([1, 0.6, 0, 0.1]) === 170);
}

// ------------------------------------------------------------------- QR code

console.log('QR code');
{
  const link = 'https://clubeoglobo.com.br/promocao';
  const qr = QR.encode(link, { level: 'M' });
  check('tamanho é 4*versão+17', qr.size === qr.version * 4 + 17, qr.size + ' v' + qr.version);
  check('escolheu uma das 8 máscaras', qr.mask >= 0 && qr.mask <= 7);

  // os três localizadores têm de estar nos cantos
  const olho = (y, x) => qr.modules[y][x] === 1 && qr.modules[y + 6][x] === 1 &&
                         qr.modules[y + 3][x + 3] === 1 && qr.modules[y + 1][x + 1] === 0;
  check('localizadores nos três cantos',
    olho(0, 0) && olho(0, qr.size - 7) && olho(qr.size - 7, 0));

  // mais correção de erro exige mais espaço para o mesmo texto
  const versoes = ['L', 'M', 'Q', 'H'].map(n => QR.encode(link, { level: n }).version);
  check('nível maior não reduz a versão',
    versoes.every((v, i) => i === 0 || v >= versoes[i - 1]), versoes.join('<='));

  check('texto vazio é recusado', (() => {
    try { QR.encode(''); return false; } catch (e) { return true; }
  })());
  check('nível inválido é recusado', (() => {
    try { QR.encode('x', { level: 'Z' }); return false; } catch (e) { return true; }
  })());
  check('texto grande demais é recusado com mensagem clara', (() => {
    try { QR.encode('a'.repeat(5000), { level: 'H' }); return false; }
    catch (e) { return /longo demais/.test(e.message); }
  })());

  // o path é o que entra no Figma: só comandos que o vetor aceita
  const modulo = 2.5;
  const d = QR.toPath(qr, modulo, 4);
  // O parser de vectorPaths do Figma aceita só M, L, C, Q e Z: um h ou v
  // derruba o nó inteiro com "Invalid command".
  const comandos = [...new Set(d.replace(/[-0-9. ]/g, ''))].join('');
  check('path usa só comandos que o Figma aceita', /^[MLZ]+$/.test(comandos), 'usa: ' + comandos);
  check('agrupa módulos vizinhos num subpath só',
    (d.match(/M/g) || []).length < qr.modules.flat().filter(Boolean).length);
  check('lado total inclui as 4 margens de cada lado',
    QR.totalSize(qr, modulo, 4) === (qr.size + 8) * modulo);

  // a margem obrigatória não pode ter tinta
  const primeiroY = Math.min(...d.match(/M[\d.]+ ([\d.]+)/g).map(m => parseFloat(m.split(' ')[1])));
  check('desenho começa depois da margem', primeiroY >= 4 * modulo, 'y=' + primeiroY);

  // dois textos diferentes não podem gerar a mesma matriz
  const outro = QR.encode(link + '?utm=jornal', { level: 'M' });
  check('conteúdo diferente, matriz diferente',
    JSON.stringify(outro.modules) !== JSON.stringify(qr.modules));
}

// ------------------------------------------------------- cores exatas (override)

console.log('Cores exatas');
{
  const opt = { gcr: 1, inkLimit: 400 };
  const naive = (r, g, b) => Color.naiveRgbToCmyk(r, g, b, opt);
  // 3 pixels: a cor marcada, a mesma cor com alfa parcial, e outra cor
  const rgba = new Uint8ClampedArray([0, 178, 237, 255, 0, 178, 237, 128, 10, 20, 30, 255]);
  const cmyk = Color.rgbaToCmykDirect(rgba, naive, [1, 1, 1]);
  const antes = Array.from(cmyk.subarray(0, 4));
  const hits = Color.applyExactOverrides(rgba, cmyk, [{ rgb: [0, 178, 237], cmyk: [1, 0, 0, 0] }]);

  check('troca o pixel que bate exatamente', cmyk[0] === 255 && cmyk[1] === 0 && cmyk[2] === 0 && cmyk[3] === 0);
  check('a conversão normal daria outra coisa', antes.join() !== '255,0,0,0', antes.join());
  check('não mexe em pixel semitransparente', cmyk[4] !== 255 || cmyk[5] !== 0);
  check('não mexe em outra cor', cmyk[8] !== 255 || cmyk[11] !== 0);
  check('conta só os pixels trocados', hits === 1, 'hits=' + hits);
  check('sem overrides não faz nada', Color.applyExactOverrides(rgba, cmyk, []) === 0);
}

// ------------------------------------------------------------------ PDF/X-1a

function testPdfX(iccBytes) {
  console.log('PDF/X-1a');
  if (!iccBytes) {
    console.log('  skip  precisa de um perfil ICC (passe o caminho como argumento)');
    return;
  }
  const W = 40, H = 30;
  const zlib = require('zlib');
  const cmyk = new Uint8Array(W * H * 4).fill(20);
  const imageData = new Uint8Array(zlib.deflateSync(Buffer.from(cmyk)));
  const pdf = PdfX.writePdfX1a({
    width: W, height: H, dpi: 300, imageData,
    icc: iccBytes, title: 'Teste', outputCondition: 'US Newsprint (SNAP 2007)'
  });
  const text = Buffer.from(pdf).toString('latin1');

  check('cabeçalho PDF 1.3', text.startsWith('%PDF-1.3'));
  // linha 2 do PDF: '%' seguido de bytes altos, que marcam o arquivo como binário
  check('marcador binário na segunda linha', pdf[9] === 0x25 && pdf[10] > 127 && pdf[11] > 127);
  check('termina em %%EOF', text.trimEnd().endsWith('%%EOF'));
  check('OutputIntent GTS_PDFX', /\/S \/GTS_PDFX/.test(text));
  check('DestOutputProfile com N 4', /\/N 4/.test(text));
  check('imagem DeviceCMYK 8 bpc', /\/ColorSpace \/DeviceCMYK/.test(text) && /\/BitsPerComponent 8/.test(text));
  check('chaves GTS no Info', /GTS_PDFXVersion/.test(text) && /GTS_PDFXConformance/.test(text));
  check('Trapped False', /\/Trapped \/False/.test(text));
  check('TrimBox = BleedBox = MediaBox', (() => {
    const m = text.match(/\/MediaBox \[([^\]]+)\]/);
    const t = text.match(/\/TrimBox \[([^\]]+)\]/);
    const b = text.match(/\/BleedBox \[([^\]]+)\]/);
    return m && t && b && m[1] === t[1] && t[1] === b[1];
  })());
  check('página no tamanho físico certo', (() => {
    const m = text.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    return m && Math.abs(+m[1] - W * 72 / 300) < 0.01 && Math.abs(+m[2] - H * 72 / 300) < 0.01;
  })());

  // a xref precisa apontar para o começo de cada objeto, ou o Acrobat recusa
  const xrefPos = +text.slice(text.lastIndexOf('startxref')).split(/\s+/)[1];
  const linhas = text.slice(xrefPos).split('\n');
  const total = +linhas[1].split(' ')[1];
  let offsetsOk = true;
  for (let i = 1; i < total; i++) {
    const off = +linhas[1 + i + 1].slice(0, 10);
    if (!text.slice(off).startsWith(i + ' 0 obj')) { offsetsOk = false; break; }
  }
  check('offsets da xref corretos', offsetsOk, 'startxref=' + xrefPos);
  check('trailer com /ID', /\/ID \[<[0-9a-f]{32}> <[0-9a-f]{32}>\]/.test(text));

  fs.writeFileSync(path.join(__dirname, 'out-pdfx.pdf'), pdf);
}

// ----------------------------------------------------------------- perfil ICC

console.log('ICC');
{
  const profilePath = process.argv[2];
  if (!profilePath || !fs.existsSync(profilePath)) {
    console.log('  skip  nenhum perfil informado (passe o caminho de um .icc como argumento)');
  } else {
    const bytes = new Uint8Array(fs.readFileSync(profilePath));
    const profile = ICC.parse(bytes.buffer);
    check('espaço de dados CMYK', profile.dataSpace === 'CMYK', profile.dataSpace);
    check('tem tabela B2A0', !!profile.tags['B2A0']);
    console.log('        ' + (profile.description || '(sem descrição)') + ' · v' + profile.version + ' · PCS ' + profile.pcs);

    const toCmyk = ICC.makeSrgbToCmyk(profile, 1, Color);

    const white = toCmyk(1, 1, 1);
    check('branco quase sem tinta', white.every(v => v < 0.05), white.map(v => (v * 100).toFixed(1)).join('/'));

    const black = toCmyk(0, 0, 0);
    check('preto usa bastante K', black[3] > 0.7, 'K=' + (black[3] * 100).toFixed(1) + '%');

    const total = black.reduce((a, b) => a + b, 0) * 100;
    check('preto dentro do limite de tinta do perfil (<= 340%)', total <= 340, 'total=' + total.toFixed(0) + '%');

    const cyan = toCmyk(0, 0.6, 0.9);
    check('azul-ciano pede mais C que M/Y', cyan[0] > cyan[1] && cyan[0] > cyan[2],
      cyan.map(v => (v * 100).toFixed(0)).join('/'));

    const yellow = toCmyk(1, 0.95, 0);
    check('amarelo pede sobretudo Y', yellow[2] > 0.8 && yellow[0] < 0.15,
      yellow.map(v => (v * 100).toFixed(0)).join('/'));

    // A LUT 3D é o que roda por pixel quando há perfil: precisa acompanhar a
    // tabela B2A de perto, senão a economia sai cara em cor.
    const lut = Color.buildRgbToCmykLut(toCmyk, 65);
    let lutErr = 0;
    for (let i = 0; i < 2000; i++) {
      const R = randByte(), G = randByte(), B = randByte();
      const exact = toCmyk(R / 255, G / 255, B / 255);
      const got = Color.rgbaToCmykWithLut(new Uint8ClampedArray([R, G, B, 255]), lut, [1, 1, 1]);
      for (let c = 0; c < 4; c++) lutErr = Math.max(lutErr, Math.abs(got[c] / 255 - exact[c]));
    }
    check('LUT 65³ segue a tabela B2A (erro < 2,5%)', lutErr < 0.025,
      'max=' + (lutErr * 100).toFixed(2) + '%');

    // amostras para comparar com littleCMS no script Python
    const samples = [];
    for (let i = 0; i < 64; i++) {
      const r = (i * 37 % 256) / 255, g = (i * 91 % 256) / 255, b = (i * 143 % 256) / 255;
      samples.push({ rgb: [r, g, b], cmyk: toCmyk(r, g, b) });
    }
    fs.writeFileSync(path.join(__dirname, 'samples.json'), JSON.stringify(samples));
    console.log('        samples.json gravado para o confronto com littleCMS');
  }
}

testPdfX(fs.existsSync(process.argv[2] || '') ? new Uint8Array(fs.readFileSync(process.argv[2])) : null);

testDeflate().then(() => {
  console.log(failures ? '\n' + failures + ' verificação(ões) falharam.' : '\nTudo certo.');
  process.exit(failures ? 1 : 0);
});
