/* tiff.js — gravador de TIFF baseline CMYK (Photometric=5, 8 bits/canal),
 * com DPI em XResolution/YResolution, ICC embutido e compressao opcional.
 * O TIFF é o formato aqui porque PNG/JPEG do Figma são sempre RGB.
 */
(function (root) {
  'use strict';

  var T = {
    NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258,
    Compression: 259, Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277,
    RowsPerStrip: 278, StripByteCounts: 279, XResolution: 282, YResolution: 283,
    PlanarConfiguration: 284, ResolutionUnit: 296, Software: 305, InkSet: 332,
    ICCProfile: 34675
  };
  var TYPE = { SHORT: 3, LONG: 4, RATIONAL: 5, ASCII: 2, UNDEFINED: 7 };
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

  /**
   * Compressão PackBits (TIFF 32773), aplicada linha a linha como manda a spec.
   * @param {Uint8Array} src
   * @returns {Uint8Array}
   */
  function packBits(src) {
    var out = new Uint8Array(src.length + Math.ceil(src.length / 128) + 1);
    var o = 0, i = 0, n = src.length;

    while (i < n) {
      // conta a corrida de bytes iguais a partir de i
      var run = 1;
      while (i + run < n && src[i + run] === src[i] && run < 128) run++;

      if (run >= 2) {
        out[o++] = 257 - run;                      // -(run-1) em complemento de 2
        out[o++] = src[i];
        i += run;
      } else {
        // acumula literais até encontrar uma corrida de 3+ ou estourar 128
        var start = i;
        var lit = 0;
        while (i < n && lit < 128) {
          var r2 = 1;
          while (i + r2 < n && src[i + r2] === src[i] && r2 < 3) r2++;
          if (r2 >= 3) break;
          i++; lit++;
        }
        out[o++] = lit - 1;
        for (var k = 0; k < lit; k++) out[o++] = src[start + k];
      }
    }
    return out.subarray(0, o);
  }

  /** PackBits é aplicado linha a linha, como manda a spec do TIFF. */
  function packBitsRows(strip, bytesPerRow) {
    var chunks = [], total = 0;
    for (var off = 0; off < strip.length; off += bytesPerRow) {
      var enc = packBits(strip.subarray(off, off + bytesPerRow));
      chunks.push(enc);
      total += enc.length;
    }
    var out = new Uint8Array(total), p = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], p); p += chunks[c].length; }
    return out;
  }

  var COMPRESSION_CODE = { none: 1, packbits: 32773, deflate: 8 };

  /** Linhas por strip que mantêm cada strip em ~4 MB, para consumo previsível de memória. */
  function rowsPerStripFor(width) {
    var bytesPerRow = width * 4;
    return Math.max(1, Math.floor(4 * 1024 * 1024 / bytesPerRow) || 1);
  }

  /**
   * Fatia o buffer CMYK em strips ainda sem compressão.
   * @returns {{rowsPerStrip:number, strips:Uint8Array[]}}
   */
  function sliceStrips(data, width, height) {
    var bytesPerRow = width * 4;
    var rows = Math.min(height, rowsPerStripFor(width));
    var strips = [];
    for (var y = 0; y < height; y += rows) {
      var h = Math.min(rows, height - y);
      strips.push(data.subarray(y * bytesPerRow, (y + h) * bytesPerRow));
    }
    return { rowsPerStrip: rows, strips: strips };
  }

  /**
   * Monta o arquivo TIFF.
   *
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {Uint8Array} [o.cmyk]      4 bytes/pixel intercalados, 0 = sem tinta
   * @param {Uint8Array[]} [o.strips]  alternativa a `cmyk`: strips já comprimidas
   * @param {number} [o.rowsPerStrip]  obrigatório junto com `strips`
   * @param {number} [o.dpi=300]
   * @param {Uint8Array} [o.icc]       bytes do perfil a embutir
   * @param {string} [o.compression]   'none' (padrão), 'packbits' ou 'deflate'
   * @param {string} [o.software]
   * @returns {Uint8Array}
   */
  function writeCmykTiff(o) {
    var width = o.width, height = o.height;
    var dpi = o.dpi || 300;
    var compression = o.compression || 'none';
    var code = COMPRESSION_CODE[compression];
    if (!code) throw new Error('Compressão desconhecida: ' + compression);
    var software = o.software || 'editoraglobo-cmyk-qr (Figma)';

    var rowsPerStrip, strips;
    if (o.strips) {
      // Deflate é assíncrono no browser (CompressionStream), então as strips
      // chegam prontas de fora.
      strips = o.strips;
      rowsPerStrip = o.rowsPerStrip;
      if (!rowsPerStrip) throw new Error('rowsPerStrip é obrigatório junto com strips.');
    } else {
      var data = o.cmyk;
      if (!data || data.length < width * height * 4) {
        throw new Error('Buffer CMYK menor que width*height*4.');
      }
      if (compression === 'deflate') {
        throw new Error('Deflate exige strips já comprimidas (use deflateStrips).');
      }
      var sliced = sliceStrips(data, width, height);
      rowsPerStrip = sliced.rowsPerStrip;
      strips = compression === 'packbits'
        ? sliced.strips.map(function (st) { return packBitsRows(st, width * 4); })
        : sliced.strips;
    }
    var nStrips = strips.length;

    // ---- layout: cabeçalho | strips | dados auxiliares | IFD
    var offset = 8;
    var stripOffsets = [], stripCounts = [];
    for (var i = 0; i < nStrips; i++) {
      if (offset % 2) offset++;                    // offsets em posição par (boa prática TIFF)
      stripOffsets.push(offset);
      stripCounts.push(strips[i].length);
      offset += strips[i].length;
    }
    if (offset % 4) offset += 4 - (offset % 4);

    var softwareBytes = asciiz(software);
    var icc = o.icc && o.icc.length ? o.icc : null;

    // blocos auxiliares (valores que não cabem nos 4 bytes da entrada do IFD)
    function reserve(bytes, align) {
      if (align && offset % align) offset += align - (offset % align);
      var at = offset;
      offset += bytes;
      return at;
    }

    var bitsOffset = reserve(8, 2);                             // 4 SHORT
    var stripOffsetsOffset = nStrips > 1 ? reserve(nStrips * 4, 4) : 0;
    var stripCountsOffset = nStrips > 1 ? reserve(nStrips * 4, 4) : 0;
    var xResOffset = reserve(8, 4);
    var yResOffset = reserve(8, 4);
    var softwareOffset = reserve(softwareBytes.length, 2);
    var iccOffset = icc ? reserve(icc.length, 4) : 0;

    if (offset % 4) offset += 4 - (offset % 4);
    var ifdOffset = offset;

    var entries = [
      [T.NewSubfileType, TYPE.LONG, 1, 0],
      [T.ImageWidth, TYPE.LONG, 1, width],
      [T.ImageLength, TYPE.LONG, 1, height],
      [T.BitsPerSample, TYPE.SHORT, 4, bitsOffset],
      [T.Compression, TYPE.SHORT, 1, code],
      [T.Photometric, TYPE.SHORT, 1, 5],           // 5 = Separated (CMYK)
      [T.StripOffsets, TYPE.LONG, nStrips, nStrips > 1 ? stripOffsetsOffset : stripOffsets[0]],
      [T.SamplesPerPixel, TYPE.SHORT, 1, 4],
      [T.RowsPerStrip, TYPE.LONG, 1, rowsPerStrip],
      [T.StripByteCounts, TYPE.LONG, nStrips, nStrips > 1 ? stripCountsOffset : stripCounts[0]],
      [T.XResolution, TYPE.RATIONAL, 1, xResOffset],
      [T.YResolution, TYPE.RATIONAL, 1, yResOffset],
      [T.PlanarConfiguration, TYPE.SHORT, 1, 1],
      [T.ResolutionUnit, TYPE.SHORT, 1, 2],        // 2 = polegada
      [T.Software, TYPE.ASCII, softwareBytes.length, softwareOffset],
      [T.InkSet, TYPE.SHORT, 1, 1]                 // 1 = CMYK
    ];
    if (icc) entries.push([T.ICCProfile, TYPE.UNDEFINED, icc.length, iccOffset]);
    entries.sort(function (a, b) { return a[0] - b[0]; });

    var ifdSize = 2 + entries.length * 12 + 4;
    var total = ifdOffset + ifdSize;

    var buf = new Uint8Array(total);
    var view = new DataView(buf.buffer);

    // cabeçalho little-endian
    buf[0] = 0x49; buf[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifdOffset, true);

    for (var st = 0; st < nStrips; st++) buf.set(strips[st], stripOffsets[st]);

    view.setUint16(bitsOffset, 8, true);
    view.setUint16(bitsOffset + 2, 8, true);
    view.setUint16(bitsOffset + 4, 8, true);
    view.setUint16(bitsOffset + 6, 8, true);

    if (nStrips > 1) {
      for (var k = 0; k < nStrips; k++) {
        view.setUint32(stripOffsetsOffset + k * 4, stripOffsets[k], true);
        view.setUint32(stripCountsOffset + k * 4, stripCounts[k], true);
      }
    }

    // DPI como racional dpi/1
    view.setUint32(xResOffset, dpi, true); view.setUint32(xResOffset + 4, 1, true);
    view.setUint32(yResOffset, dpi, true); view.setUint32(yResOffset + 4, 1, true);

    buf.set(softwareBytes, softwareOffset);
    if (icc) buf.set(icc, iccOffset);

    view.setUint16(ifdOffset, entries.length, true);
    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e];
      var p = ifdOffset + 2 + e * 12;
      view.setUint16(p, entry[0], true);
      view.setUint16(p + 2, entry[1], true);
      view.setUint32(p + 4, entry[2], true);
      var inlineBytes = TYPE_SIZE[entry[1]] * entry[2];
      if (inlineBytes <= 4 && entry[1] === TYPE.SHORT) view.setUint16(p + 8, entry[3], true);
      else view.setUint32(p + 8, entry[3], true);
    }
    view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);

    return buf;
  }

  /**
   * Comprime as strips com Deflate via CompressionStream (formato zlib, que é o
   * que o TIFF Compression=8 espera).
   *
   * @param {function(number):void} [onProgress] recebe 0..1
   * @returns {Promise<{rowsPerStrip:number, strips:Uint8Array[]}>}
   */
  function deflateStrips(data, width, height, onProgress) {
    if (typeof CompressionStream === 'undefined') {
      return Promise.reject(new Error('CompressionStream indisponível neste ambiente.'));
    }
    var sliced = sliceStrips(data, width, height);
    var out = [];
    var chain = Promise.resolve();
    sliced.strips.forEach(function (strip, i) {
      chain = chain.then(function () {
        return deflateBytes(strip).then(function (z) {
          out[i] = z;
          if (onProgress) onProgress((i + 1) / sliced.strips.length);
        });
      });
    });
    return chain.then(function () {
      return { rowsPerStrip: sliced.rowsPerStrip, strips: out };
    });
  }

  function deflateBytes(bytes) {
    var cs = new CompressionStream('deflate');
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Response(cs.readable).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  function asciiz(s) {
    var out = new Uint8Array(s.length + 1);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
  }

  root.Tiff = {
    writeCmykTiff: writeCmykTiff,
    deflateStrips: deflateStrips,
    deflate: deflateBytes,
    sliceStrips: sliceStrips,
    packBits: packBits,
    TAGS: T
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
