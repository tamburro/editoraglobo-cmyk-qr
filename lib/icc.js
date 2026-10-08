/* icc.js — leitor mínimo de perfis ICC, suficiente para aplicar a tabela B2A
 * (PCS -> CMYK) de perfis de impressão como Coated FOGRA39 ou US Web Coated.
 * Suporta lut8 ('mft1'), lut16 ('mft2') e lutBToA ('mAB '/'mBA ').
 */
(function (root) {
  'use strict';

  function tag(view, off) {
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1),
                               view.getUint8(off + 2), view.getUint8(off + 3));
  }

  /**
   * @param {ArrayBuffer} buf
   * @returns {{size:number, version:number, deviceClass:string, dataSpace:string,
   *            pcs:string, description:string, tags:Object, raw:Uint8Array}}
   */
  function parse(buf) {
    var u8 = new Uint8Array(buf);
    var v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 132) throw new Error('Arquivo ICC muito pequeno.');
    if (tag(v, 36) !== 'acsp') throw new Error('Assinatura "acsp" ausente: não é um perfil ICC.');

    var profile = {
      size: v.getUint32(0),
      version: v.getUint8(8),
      deviceClass: tag(v, 12),
      dataSpace: tag(v, 16).trim(),
      pcs: tag(v, 20).trim(),
      description: '',
      tags: {},
      raw: u8
    };

    var count = v.getUint32(128);
    for (var i = 0; i < count; i++) {
      var o = 132 + i * 12;
      if (o + 12 > u8.length) break;
      profile.tags[tag(v, o)] = { offset: v.getUint32(o + 4), size: v.getUint32(o + 8) };
    }
    profile.description = readDescription(v, u8, profile.tags['desc']);
    return profile;
  }

  function readDescription(v, u8, t) {
    if (!t) return '';
    try {
      var type = tag(v, t.offset);
      if (type === 'desc') {                       // ICC v2 textDescriptionType
        var len = v.getUint32(t.offset + 8);
        var s = '';
        for (var i = 0; i < len - 1; i++) s += String.fromCharCode(u8[t.offset + 12 + i]);
        return s;
      }
      if (type === 'mluc') {                       // ICC v4
        var recLen = v.getUint32(t.offset + 20);
        var recOff = v.getUint32(t.offset + 24);
        var out = '';
        for (var j = 0; j < recLen; j += 2) out += String.fromCharCode(v.getUint16(t.offset + recOff + j));
        return out;
      }
    } catch (e) { /* descrição é cosmética; perfis com tag malformada seguem válidos */ }
    return '';
  }

  // ------------------------------------------------------------------- curvas

  // 'curv': 0 pontos = identidade, 1 ponto = gama, n pontos = tabela uint16
  function readCurv(v, off) {
    var n = v.getUint32(off + 8);
    if (n === 0) return function (x) { return x; };
    if (n === 1) {
      var gamma = v.getUint16(off + 12) / 256;
      return function (x) { return Math.pow(x < 0 ? 0 : x > 1 ? 1 : x, gamma); };
    }
    var table = new Float64Array(n);
    for (var i = 0; i < n; i++) table[i] = v.getUint16(off + 12 + i * 2) / 65535;
    return makeTableFn(table);
  }

  // 'para': curvas paramétricas ICC v4 (tipos 0..4)
  function readPara(v, off) {
    var fn = v.getUint16(off + 8);
    var nParams = [1, 3, 4, 5, 7][fn];
    var p = [];
    for (var i = 0; i < nParams; i++) p.push(v.getInt32(off + 12 + i * 4) / 65536);
    return function (x) {
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      switch (fn) {
        case 0: return Math.pow(x, p[0]);
        case 1: return x >= -p[2] / p[1] ? Math.pow(p[1] * x + p[2], p[0]) : 0;
        case 2: return x >= -p[2] / p[1] ? Math.pow(p[1] * x + p[2], p[0]) + p[3] : p[3];
        case 3: return x >= p[4] ? Math.pow(p[1] * x + p[2], p[0]) : p[3] * x;
        case 4: return x >= p[4] ? Math.pow(p[1] * x + p[2], p[0]) + p[3] : p[3] * x + p[6];
        default: return x;
      }
    };
  }

  function readCurveAt(v, off) {
    var type = tag(v, off);
    if (type === 'curv') return { fn: readCurv(v, off), size: 12 + v.getUint32(off + 8) * 2 };
    if (type === 'para') {
      var f = v.getUint16(off + 8);
      var n = [1, 3, 4, 5, 7][f];
      return { fn: readPara(v, off), size: 12 + n * 4 };
    }
    throw new Error('Tipo de curva não suportado: ' + type);
  }

  function makeTableFn(table) {
    var n = table.length, last = n - 1;
    return function (x) {
      if (!(x > 0)) return table[0];
      if (x >= 1) return table[last];
      var f = x * last, i = f | 0, d = f - i;
      return table[i] + (table[i + 1] - table[i]) * d;
    };
  }

  // --------------------------------------------------------------------- CLUT

  /**
   * Interpolação multilinear num CLUT de `nIn` entradas e `nOut` saídas,
   * com `grid` nós por eixo.
   */
  function makeClut(values, grid, nIn, nOut) {
    var strides = new Array(nIn);
    var s = nOut;
    for (var i = nIn - 1; i >= 0; i--) { strides[i] = s; s *= grid; }
    var last = grid - 1;
    var corners = 1 << nIn;
    var idx = new Array(nIn), frac = new Array(nIn);

    return function (input, out) {
      for (var k = 0; k < nIn; k++) {
        var x = input[k];
        x = x < 0 ? 0 : x > 1 ? 1 : x;
        var f = x * last, i0 = f | 0;
        if (i0 >= last) i0 = last > 0 ? last - 1 : 0;
        idx[k] = i0;
        frac[k] = last === 0 ? 0 : f - i0;
      }
      for (var o = 0; o < nOut; o++) out[o] = 0;
      for (var c = 0; c < corners; c++) {
        var w = 1, base = 0;
        for (var b = 0; b < nIn; b++) {
          var up = (c >> b) & 1;
          var pos = idx[b] + up;
          if (pos > last) pos = last;
          w *= up ? frac[b] : 1 - frac[b];
          base += pos * strides[b];
        }
        if (w === 0) continue;
        for (var oo = 0; oo < nOut; oo++) out[oo] += values[base + oo] * w;
      }
      return out;
    };
  }

  // ------------------------------------------------------------ lut8 / lut16

  function readLut(v, off) {
    var type = tag(v, off);
    if (type === 'mft1') return readMft(v, off, 8);
    if (type === 'mft2') return readMft(v, off, 16);
    if (type === 'mAB ' || type === 'mBA ') return readMAB(v, off);
    throw new Error('Tipo de tabela não suportado: ' + type);
  }

  function readMft(v, off, bits) {
    var nIn = v.getUint8(off + 8);
    var nOut = v.getUint8(off + 9);
    var grid = v.getUint8(off + 10);

    var matrix = [];
    for (var m = 0; m < 9; m++) matrix.push(v.getInt32(off + 12 + m * 4) / 65536);

    var p, nInEntries, nOutEntries, read, step;
    if (bits === 8) {
      nInEntries = 256; nOutEntries = 256;
      p = off + 48;
      step = 1;
      read = function (o) { return v.getUint8(o) / 255; };
    } else {
      nInEntries = v.getUint16(off + 48);
      nOutEntries = v.getUint16(off + 50);
      p = off + 52;
      step = 2;
      read = function (o) { return v.getUint16(o) / 65535; };
    }

    var inCurves = [];
    for (var i = 0; i < nIn; i++) {
      var t = new Float64Array(nInEntries);
      for (var e = 0; e < nInEntries; e++) t[e] = read(p + (i * nInEntries + e) * step);
      inCurves.push(makeTableFn(t));
    }
    p += nIn * nInEntries * step;

    var clutCount = Math.pow(grid, nIn) * nOut;
    var values = new Float64Array(clutCount);
    for (var c = 0; c < clutCount; c++) values[c] = read(p + c * step);
    p += clutCount * step;

    var outCurves = [];
    for (var j = 0; j < nOut; j++) {
      var t2 = new Float64Array(nOutEntries);
      for (var e2 = 0; e2 < nOutEntries; e2++) t2[e2] = read(p + (j * nOutEntries + e2) * step);
      outCurves.push(makeTableFn(t2));
    }

    var clut = makeClut(values, grid, nIn, nOut);
    var identity = isIdentity3x3(matrix);
    var tmpIn = new Array(nIn), tmpOut = new Array(nOut);

    return {
      nIn: nIn, nOut: nOut, legacy16: bits === 16,
      apply: function (input) {
        var x = input;
        // A matriz do mft só tem efeito quando o PCS é XYZ; em Lab é identidade.
        if (!identity && nIn === 3) {
          x = [
            matrix[0] * input[0] + matrix[1] * input[1] + matrix[2] * input[2],
            matrix[3] * input[0] + matrix[4] * input[1] + matrix[5] * input[2],
            matrix[6] * input[0] + matrix[7] * input[1] + matrix[8] * input[2]
          ];
        }
        for (var i2 = 0; i2 < nIn; i2++) tmpIn[i2] = inCurves[i2](x[i2]);
        clut(tmpIn, tmpOut);
        var res = new Array(nOut);
        for (var o = 0; o < nOut; o++) res[o] = outCurves[o](tmpOut[o]);
        return res;
      }
    };
  }

  function isIdentity3x3(m) {
    var expect = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (var i = 0; i < 9; i++) if (Math.abs(m[i] - expect[i]) > 1e-6) return false;
    return true;
  }

  // ---------------------------------------------------------------- lutBToA

  function readMAB(v, off) {
    var nIn = v.getUint8(off + 8);
    var nOut = v.getUint8(off + 9);
    var offB = v.getUint32(off + 12);
    var offMatrix = v.getUint32(off + 16);
    var offM = v.getUint32(off + 20);
    var offCLUT = v.getUint32(off + 24);
    var offA = v.getUint32(off + 28);

    // Em lutBToA a ordem de processamento é B -> matriz -> M -> CLUT -> A.
    var bCurves = offB ? readCurveSet(v, off + offB, nIn) : null;
    var mCurves = offM ? readCurveSet(v, off + offM, nIn) : null;
    var aCurves = offA ? readCurveSet(v, off + offA, nOut) : null;

    var matrix = null;
    if (offMatrix) {
      matrix = [];
      for (var i = 0; i < 12; i++) matrix.push(v.getInt32(off + offMatrix + i * 4) / 65536);
    }

    var clut = null;
    if (offCLUT) {
      var co = off + offCLUT;
      var grid = v.getUint8(co);
      for (var g = 1; g < nIn; g++) {
        if (v.getUint8(co + g) !== grid) throw new Error('CLUT com grade não uniforme não suportado.');
      }
      var precision = v.getUint8(co + 16);
      var total = Math.pow(grid, nIn) * nOut;
      var values = new Float64Array(total);
      for (var c = 0; c < total; c++) {
        values[c] = precision === 1
          ? v.getUint8(co + 20 + c) / 255
          : v.getUint16(co + 20 + c * 2) / 65535;
      }
      clut = makeClut(values, grid, nIn, nOut);
    }

    var tmpOut = new Array(nOut);
    return {
      nIn: nIn, nOut: nOut, legacy16: false,
      apply: function (input) {
        var x = input.slice(0, nIn);
        if (bCurves) for (var i2 = 0; i2 < nIn; i2++) x[i2] = bCurves[i2](x[i2]);
        if (matrix && nIn === 3) {
          x = [
            matrix[0] * x[0] + matrix[1] * x[1] + matrix[2] * x[2] + matrix[9],
            matrix[3] * x[0] + matrix[4] * x[1] + matrix[5] * x[2] + matrix[10],
            matrix[6] * x[0] + matrix[7] * x[1] + matrix[8] * x[2] + matrix[11]
          ];
        }
        if (mCurves) for (var j = 0; j < nIn; j++) x[j] = mCurves[j](x[j]);
        if (clut) { clut(x, tmpOut); x = tmpOut.slice(0, nOut); }
        if (aCurves) for (var k = 0; k < nOut; k++) x[k] = aCurves[k](x[k]);
        return x;
      }
    };
  }

  function readCurveSet(v, off, n) {
    var curves = [], p = off;
    for (var i = 0; i < n; i++) {
      var c = readCurveAt(v, p);
      curves.push(c.fn);
      p += c.size;
      p += (4 - (p % 4)) % 4;                      // cada curva é alinhada em 4 bytes
    }
    return curves;
  }

  // ------------------------------------------------------ transformação final

  var INTENT_TAGS = ['B2A0', 'B2A1', 'B2A2'];

  /**
   * Devolve uma função sRGB(0..1) -> CMYK(0..1) usando a tabela B2A do perfil.
   * @param {object} profile  resultado de parse()
   * @param {number} intent   0 perceptual, 1 colorimétrico relativo, 2 saturação
   * @param {object} Color    módulo color.js (para sRGB -> PCS)
   */
  function makeSrgbToCmyk(profile, intent, Color) {
    if (profile.dataSpace !== 'CMYK') {
      throw new Error('O perfil é ' + profile.dataSpace + ', não CMYK.');
    }
    var name = INTENT_TAGS[intent] || 'B2A0';
    var t = profile.tags[name] || profile.tags['B2A0'] || profile.tags['B2A1'] || profile.tags['B2A2'];
    if (!t) throw new Error('Perfil sem tabela B2A: não serve para converter para CMYK.');

    var v = new DataView(profile.raw.buffer, profile.raw.byteOffset, profile.raw.byteLength);
    var lut = readLut(v, t.offset);
    if (lut.nOut !== 4) throw new Error('A tabela B2A não produz 4 canais.');
    var pcsIsLab = profile.pcs === 'Lab';

    return function (r, g, b) {
      var pcs;
      if (pcsIsLab) {
        var lab = Color.srgbToLabD50(r, g, b);
        pcs = lut.legacy16 ? encodeLabLegacy16(lab) : encodeLabV4(lab);
      } else {
        // XYZ do PCS é u1Fixed15Number: 0..1,99997 mapeado em 0..1
        var xyz = Color.srgbToXyzD50(r, g, b);
        pcs = [xyz[0] / 1.9999695, xyz[1] / 1.9999695, xyz[2] / 1.9999695];
      }
      var out = lut.apply(pcs);
      return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2]), clamp01(out[3])];
    };
  }

  var A2B_TAGS = ['A2B0', 'A2B1', 'A2B2'];

  /**
   * Devolve uma função CMYK(0..1) -> sRGB(0..1) usando a tabela A2B do perfil.
   * É o caminho inverso de makeSrgbToCmyk, usado para mostrar na tela como uma
   * cor CMYK escolhida à mão vai sair impressa.
   */
  function makeCmykToSrgb(profile, intent, Color) {
    if (profile.dataSpace !== 'CMYK') {
      throw new Error('O perfil é ' + profile.dataSpace + ', não CMYK.');
    }
    var name = A2B_TAGS[intent] || 'A2B0';
    var t = profile.tags[name] || profile.tags['A2B0'] || profile.tags['A2B1'] || profile.tags['A2B2'];
    if (!t) throw new Error('Perfil sem tabela A2B.');

    var v = new DataView(profile.raw.buffer, profile.raw.byteOffset, profile.raw.byteLength);
    var lut = readLut(v, t.offset);
    if (lut.nIn !== 4) throw new Error('A tabela A2B não recebe 4 canais.');
    var pcsIsLab = profile.pcs === 'Lab';

    return function (c, m, y, k) {
      var out = lut.apply([c, m, y, k]);
      if (pcsIsLab) {
        var lab = lut.legacy16 ? decodeLabLegacy16(out) : decodeLabV4(out);
        return Color.labD50ToSrgb(lab[0], lab[1], lab[2]);
      }
      return Color.xyzD50ToSrgb(out[0] * 1.9999695, out[1] * 1.9999695, out[2] * 1.9999695);
    };
  }

  function decodeLabLegacy16(v) {
    var k = 65535 / 65280;
    return [v[0] * k * 100, v[1] * k * 255 - 128, v[2] * k * 255 - 128];
  }

  function decodeLabV4(v) {
    return [v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128];
  }

  // Codificação Lab herdada do ICC v2 (mft1/mft2): L 0..100 -> 0..0xFF00
  function encodeLabLegacy16(lab) {
    var k = 65280 / 65535;
    return [
      clamp01(lab[0] / 100 * k),
      clamp01((lab[1] + 128) / 255 * k),
      clamp01((lab[2] + 128) / 255 * k)
    ];
  }

  // Codificação Lab do ICC v4: L 0..100 -> 0..0xFFFF
  function encodeLabV4(lab) {
    return [clamp01(lab[0] / 100), clamp01((lab[1] + 128) / 255), clamp01((lab[2] + 128) / 255)];
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  root.ICC = {
    parse: parse,
    makeSrgbToCmyk: makeSrgbToCmyk,
    makeCmykToSrgb: makeCmykToSrgb,
    _internals: { makeClut: makeClut, readLut: readLut, readCurveAt: readCurveAt }
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
