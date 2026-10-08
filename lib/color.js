/* color.js — conversões de espaço de cor e LUT acelerada.
 * Sem dependências. Usado tanto no browser (inlined em ui.html) quanto em node (testes).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- sRGB -> XYZ

  // sRGB (IEC 61966-2-1) -> linear
  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  // sRGB linear -> XYZ D65, já adaptado para D50 (Bradford). Matriz pré-multiplicada:
  // M = Bradford(D65->D50) * sRGB_D65
  var RGB_TO_XYZ_D50 = [
    0.4360747, 0.3850649, 0.1430804,
    0.2225045, 0.7168786, 0.0606169,
    0.0139322, 0.0971045, 0.7141733
  ];

  var D50 = { X: 0.9642, Y: 1.0, Z: 0.8249 };

  function f_lab(t) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  }

  /** sRGB 0..1 -> Lab D50 (L 0..100, a/b ~ -128..127) */
  function srgbToLabD50(r, g, b) {
    var R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    var M = RGB_TO_XYZ_D50;
    var X = M[0] * R + M[1] * G + M[2] * B;
    var Y = M[3] * R + M[4] * G + M[5] * B;
    var Z = M[6] * R + M[7] * G + M[8] * B;
    var fx = f_lab(X / D50.X), fy = f_lab(Y / D50.Y), fz = f_lab(Z / D50.Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  /** sRGB 0..1 -> XYZ D50 (usado quando o PCS do perfil é XYZ) */
  function srgbToXyzD50(r, g, b) {
    var R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    var M = RGB_TO_XYZ_D50;
    return [
      M[0] * R + M[1] * G + M[2] * B,
      M[3] * R + M[4] * G + M[5] * B,
      M[6] * R + M[7] * G + M[8] * B
    ];
  }

  // -------------------------------------------------------------- XYZ -> sRGB

  function invert3x3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [
      (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
    ];
  }

  // invertida em tempo de carga para não depender de números transcritos à mão
  var XYZ_D50_TO_RGB = invert3x3(RGB_TO_XYZ_D50);

  function linearToSrgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  /** XYZ D50 -> sRGB 0..1 (fora de gamut é cortado) */
  function xyzD50ToSrgb(X, Y, Z) {
    var M = XYZ_D50_TO_RGB;
    return [
      linearToSrgb(M[0] * X + M[1] * Y + M[2] * Z),
      linearToSrgb(M[3] * X + M[4] * Y + M[5] * Z),
      linearToSrgb(M[6] * X + M[7] * Y + M[8] * Z)
    ];
  }

  /** Lab D50 -> sRGB 0..1 */
  function labD50ToSrgb(L, a, b) {
    var fy = (L + 16) / 116;
    var fx = fy + a / 500;
    var fz = fy - b / 200;
    var k = 24389 / 27, eps = 216 / 24389;
    var fx3 = fx * fx * fx, fz3 = fz * fz * fz;
    var xr = fx3 > eps ? fx3 : (116 * fx - 16) / k;
    var yr = L > k * eps ? Math.pow((L + 16) / 116, 3) : L / k;
    var zr = fz3 > eps ? fz3 : (116 * fz - 16) / k;
    return xyzD50ToSrgb(xr * D50.X, yr * D50.Y, zr * D50.Z);
  }

  /**
   * CMYK -> sRGB pela fórmula simples, espelhando naiveRgbToCmyk.
   * Serve de pré-visualização quando não há perfil ICC carregado.
   */
  function naiveCmykToSrgb(c, m, y, k) {
    return [
      clamp01((1 - c) * (1 - k)),
      clamp01((1 - m) * (1 - k)),
      clamp01((1 - y) * (1 - k))
    ];
  }

  // ------------------------------------------------------- conversão sem perfil

  /**
   * RGB -> CMYK pela fórmula clássica, com controle de geração de preto e
   * limite de tinta total. Não é color-managed: serve de fallback quando não há
   * perfil ICC carregado.
   *
   * @param {number} r,g,b   0..1
   * @param {object} opt     { gcr: 0..1, inkLimit: 0..400 }
   * @returns {number[]}     [c,m,y,k] em 0..1
   */
  function naiveRgbToCmyk(r, g, b, opt) {
    var gcr = opt && opt.gcr != null ? opt.gcr : 1;
    var inkLimit = (opt && opt.inkLimit != null ? opt.inkLimit : 300) / 100;

    var c = 1 - r, m = 1 - g, y = 1 - b;
    var kMax = Math.min(c, m, y);
    var k = kMax * gcr;

    if (k < 1) {
      // remove do CMY a parcela que o preto passou a cobrir
      c = (c - k) / (1 - k);
      m = (m - k) / (1 - k);
      y = (y - k) / (1 - k);
    } else {
      c = m = y = 0;
    }

    c = clamp01(c); m = clamp01(m); y = clamp01(y); k = clamp01(k);

    // Limite de tinta total: escala CMY (mantendo K) até caber no limite.
    var total = c + m + y + k;
    if (total > inkLimit) {
      var excess = total - inkLimit;
      var cmy = c + m + y;
      if (cmy > 0) {
        var f = Math.max(0, (cmy - excess) / cmy);
        c *= f; m *= f; y *= f;
      }
    }
    return [c, m, y, k];
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // ------------------------------------------------------------------- LUT 3D

  /**
   * Constrói uma LUT 3D RGB->CMYK amostrando `fn` em uma grade size^3.
   * Aplicar a transformação pixel a pixel (sobretudo a ICC) é caro; amostrar
   * uma vez e interpolar depois é ordens de grandeza mais rápido e visualmente
   * indistinguível com size=33.
   *
   * @param {function(number,number,number): number[]} fn  rgb 0..1 -> cmyk 0..1
   * @param {number} size  nós por eixo (padrão 33)
   * @returns {{size:number, data:Float32Array}}
   */
  function buildRgbToCmykLut(fn, size) {
    size = size || 33;
    var data = new Float32Array(size * size * size * 4);
    var d = size - 1;
    var i = 0;
    for (var ri = 0; ri < size; ri++) {
      var r = ri / d;
      for (var gi = 0; gi < size; gi++) {
        var g = gi / d;
        for (var bi = 0; bi < size; bi++) {
          var out = fn(r, g, bi / d);
          data[i++] = out[0]; data[i++] = out[1]; data[i++] = out[2]; data[i++] = out[3];
        }
      }
    }
    return { size: size, data: data };
  }

  /**
   * Converte um buffer RGBA (Uint8ClampedArray) em CMYK 8-bit intercalado,
   * interpolando trilinearmente na LUT. Alfa é composto sobre `bg` (branco por
   * padrão) porque o TIFF CMYK gerado não carrega canal alfa.
   *
   * @returns {Uint8Array} 4 bytes por pixel, 0 = sem tinta
   */
  function rgbaToCmykWithLut(rgba, lut, bg) {
    var n = rgba.length / 4;
    var out = new Uint8Array(n * 4);
    var size = lut.size, d = size - 1, L = lut.data;
    var bgR = bg ? bg[0] : 1, bgG = bg ? bg[1] : 1, bgB = bg ? bg[2] : 1;

    for (var p = 0; p < n; p++) {
      var o = p * 4;
      var a = rgba[o + 3] / 255;
      var r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255;
      if (a < 1) {
        r = r * a + bgR * (1 - a);
        g = g * a + bgG * (1 - a);
        b = b * a + bgB * (1 - a);
      }

      var rf = r * d, gf = g * d, bf = b * d;
      var r0 = rf | 0, g0 = gf | 0, b0 = bf | 0;
      if (r0 >= d) r0 = d - 1; if (g0 >= d) g0 = d - 1; if (b0 >= d) b0 = d - 1;
      if (r0 < 0) r0 = 0; if (g0 < 0) g0 = 0; if (b0 < 0) b0 = 0;
      var dr = rf - r0, dg = gf - g0, db = bf - b0;

      var s2 = size * size;
      var base = ((r0 * s2) + (g0 * size) + b0) * 4;
      var sR = s2 * 4, sG = size * 4, sB = 4;

      for (var ch = 0; ch < 4; ch++) {
        var i000 = L[base + ch];
        var i001 = L[base + sB + ch];
        var i010 = L[base + sG + ch];
        var i011 = L[base + sG + sB + ch];
        var i100 = L[base + sR + ch];
        var i101 = L[base + sR + sB + ch];
        var i110 = L[base + sR + sG + ch];
        var i111 = L[base + sR + sG + sB + ch];

        var c00 = i000 + (i100 - i000) * dr;
        var c01 = i001 + (i101 - i001) * dr;
        var c10 = i010 + (i110 - i010) * dr;
        var c11 = i011 + (i111 - i011) * dr;
        var c0 = c00 + (c10 - c00) * dg;
        var c1 = c01 + (c11 - c01) * dg;
        var v = c0 + (c1 - c0) * db;

        v = v * 255 + 0.5;
        out[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return out;
  }

  /**
   * Converte RGBA aplicando `fn` diretamente em cada pixel (sem LUT).
   * Usado na conversão sem perfil, onde a fórmula é barata e vale mais ser
   * exata: perto do preto, (c-k)/(1-k) é íngreme e a interpolação erraria.
   *
   * @returns {Uint8Array} 4 bytes por pixel, 0 = sem tinta
   */
  function rgbaToCmykDirect(rgba, fn, bg) {
    var n = rgba.length / 4;
    var out = new Uint8Array(n * 4);
    var bgR = bg ? bg[0] : 1, bgG = bg ? bg[1] : 1, bgB = bg ? bg[2] : 1;

    for (var p = 0; p < n; p++) {
      var o = p * 4;
      var a = rgba[o + 3] / 255;
      var r = rgba[o] / 255, g = rgba[o + 1] / 255, b = rgba[o + 2] / 255;
      if (a < 1) {
        r = r * a + bgR * (1 - a);
        g = g * a + bgG * (1 - a);
        b = b * a + bgB * (1 - a);
      }
      var cmyk = fn(r, g, b);
      for (var c = 0; c < 4; c++) {
        var v = cmyk[c] * 255 + 0.5;
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return out;
  }

  /**
   * Troca, no buffer CMYK já convertido, os pixels cuja cor RGB original bate
   * exatamente com uma cor marcada pelo usuário.
   *
   * É assim que uma cor escolhida a dedo (ex.: 100/0/0/0) chega à chapa com o
   * valor exato: a conversão por perfil arredondaria, e o preenchimento chapado
   * do Figma tem RGB uniforme, então a comparação é confiável no miolo da forma
   * (as bordas antisserrilhadas seguem convertidas normalmente).
   *
   * @param {Uint8ClampedArray} rgba   faixa original
   * @param {Uint8Array} cmyk          saída da conversão, alterada no lugar
   * @param {Array<{rgb:number[], cmyk:number[]}>} overrides  rgb 0..255, cmyk 0..1
   * @returns {number} quantidade de pixels trocados
   */
  function applyExactOverrides(rgba, cmyk, overrides) {
    if (!overrides || !overrides.length) return 0;
    var table = {};
    for (var i = 0; i < overrides.length; i++) {
      var o = overrides[i];
      var key = (o.rgb[0] << 16) | (o.rgb[1] << 8) | o.rgb[2];
      table[key] = [
        Math.round(o.cmyk[0] * 255), Math.round(o.cmyk[1] * 255),
        Math.round(o.cmyk[2] * 255), Math.round(o.cmyk[3] * 255)
      ];
    }
    var hits = 0;
    for (var p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] !== 255) continue;            // só pixels opacos
      var v = table[(rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]];
      if (!v) continue;
      cmyk[p] = v[0]; cmyk[p + 1] = v[1]; cmyk[p + 2] = v[2]; cmyk[p + 3] = v[3];
      hits++;
    }
    return hits;
  }

  root.Color = {
    srgbToLinear: srgbToLinear,
    srgbToLabD50: srgbToLabD50,
    srgbToXyzD50: srgbToXyzD50,
    naiveRgbToCmyk: naiveRgbToCmyk,
    buildRgbToCmykLut: buildRgbToCmykLut,
    rgbaToCmykWithLut: rgbaToCmykWithLut,
    rgbaToCmykDirect: rgbaToCmykDirect,
    xyzD50ToSrgb: xyzD50ToSrgb,
    labD50ToSrgb: labD50ToSrgb,
    naiveCmykToSrgb: naiveCmykToSrgb,
    applyExactOverrides: applyExactOverrides
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
