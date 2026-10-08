/* qr.js — gerador de QR Code (ISO/IEC 18004), sem dependências.
 *
 * Existe porque o plugin roda num iframe sem acesso à rede: não dá para puxar
 * biblioteca de CDN nem chamar API de geração. Cobre o modo byte (UTF-8), que
 * é o que um link precisa, nas versões 1 a 40 e nos quatro níveis de correção.
 *
 * A saída é a matriz de módulos; quem desenha é quem chama — no plugin, vira um
 * único path vetorial.
 */
(function (root) {
  'use strict';

  // Codewords totais por versão (dados + correção). Tabela 1 da norma.
  var TOTAL_CODEWORDS = [
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
    404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
    1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
    2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
  ];

  /**
   * Por versão e nível: [codewords de correção por bloco, blocos do grupo 1,
   * blocos do grupo 2]. Os blocos do grupo 2 levam um codeword de dado a mais.
   */
  var BLOCKS = {
    L: [
      [7, 1, 0], [10, 1, 0], [15, 1, 0], [20, 1, 0], [26, 1, 0],
      [18, 2, 0], [20, 2, 0], [24, 2, 0], [30, 2, 0], [18, 2, 2],
      [20, 4, 0], [24, 2, 2], [26, 4, 0], [30, 3, 1], [22, 5, 1],
      [24, 5, 1], [28, 1, 5], [30, 5, 1], [28, 3, 4], [28, 3, 5],
      [28, 4, 4], [28, 2, 7], [30, 4, 5], [30, 6, 4], [26, 8, 4],
      [28, 10, 2], [30, 8, 4], [30, 3, 10], [30, 7, 7], [30, 5, 10],
      [30, 13, 3], [30, 17, 0], [30, 17, 1], [30, 13, 6], [30, 12, 7],
      [30, 6, 14], [30, 17, 4], [30, 4, 18], [30, 20, 4], [30, 19, 6]
    ],
    M: [
      [10, 1, 0], [16, 1, 0], [26, 1, 0], [18, 2, 0], [24, 2, 0],
      [16, 4, 0], [18, 4, 0], [22, 2, 2], [22, 3, 2], [26, 4, 1],
      [30, 1, 4], [22, 6, 2], [22, 8, 1], [24, 4, 5], [24, 5, 5],
      [28, 7, 3], [28, 10, 1], [26, 9, 4], [26, 3, 11], [26, 3, 13],
      [26, 17, 0], [28, 17, 0], [28, 4, 14], [28, 6, 14], [28, 8, 13],
      [28, 19, 4], [28, 22, 3], [28, 3, 23], [28, 21, 7], [28, 19, 10],
      [28, 2, 29], [28, 10, 23], [28, 14, 21], [28, 14, 23], [28, 12, 26],
      [28, 6, 34], [28, 29, 14], [28, 13, 32], [28, 40, 7], [28, 18, 31]
    ],
    Q: [
      [13, 1, 0], [22, 1, 0], [18, 2, 0], [26, 2, 0], [18, 2, 2],
      [24, 4, 0], [18, 2, 4], [22, 4, 2], [20, 4, 4], [24, 6, 2],
      [28, 4, 4], [26, 4, 6], [24, 8, 4], [20, 11, 5], [30, 5, 7],
      [24, 15, 2], [28, 1, 15], [28, 17, 1], [26, 17, 4], [30, 15, 5],
      [28, 17, 6], [30, 7, 16], [30, 11, 14], [30, 11, 16], [30, 7, 22],
      [28, 28, 6], [30, 8, 26], [30, 4, 31], [30, 1, 37], [30, 15, 25],
      [30, 42, 1], [30, 10, 35], [30, 29, 19], [30, 44, 7], [30, 39, 14],
      [30, 46, 10], [30, 49, 10], [30, 48, 14], [30, 43, 22], [30, 34, 34]
    ],
    H: [
      [17, 1, 0], [28, 1, 0], [22, 2, 0], [16, 4, 0], [22, 2, 2],
      [28, 4, 0], [26, 4, 1], [26, 4, 2], [24, 4, 4], [28, 6, 2],
      [24, 3, 8], [28, 7, 4], [22, 12, 4], [24, 11, 5], [24, 11, 7],
      [30, 3, 13], [28, 2, 17], [28, 2, 19], [26, 9, 16], [28, 15, 10],
      [30, 19, 6], [24, 34, 0], [30, 16, 14], [30, 30, 2], [30, 22, 13],
      [30, 33, 4], [30, 12, 28], [30, 11, 31], [30, 19, 26], [30, 23, 25],
      [30, 23, 28], [30, 19, 35], [30, 11, 46], [30, 59, 1], [30, 22, 41],
      [30, 2, 64], [30, 24, 46], [30, 42, 32], [30, 10, 67], [30, 20, 61]
    ]
  };

  // Centros dos padrões de alinhamento, por versão (versão 1 não tem).
  var ALIGNMENT = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];

  var ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };      // codificação do nível no formato

  // ------------------------------------------------------------- GF(256)

  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;                  // polinômio primitivo da norma
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** Polinômio gerador de grau `degree`, para a correção Reed-Solomon. */
  function generatorPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /** Codewords de correção de um bloco de dados. */
  function ecCodewords(data, count) {
    var gen = generatorPoly(count);
    var rest = new Array(data.length + count).fill(0);
    for (var i = 0; i < data.length; i++) rest[i] = data[i];

    for (var p = 0; p < data.length; p++) {
      var factor = rest[p];
      if (factor === 0) continue;
      for (var g = 0; g < gen.length; g++) {
        rest[p + g] ^= gfMul(gen[g], factor);
      }
    }
    return rest.slice(data.length);
  }

  // --------------------------------------------------------- codificação

  function utf8Bytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.codePointAt(i);
      if (c > 0xffff) i++;                        // par substituto já consumido
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
                 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  function dataCodewordCount(version, level) {
    var b = BLOCKS[level][version - 1];
    return TOTAL_CODEWORDS[version - 1] - b[0] * (b[1] + b[2]);
  }

  /** Bits do indicador de tamanho no modo byte: 8 até a versão 9, senão 16. */
  function lengthBits(version) { return version < 10 ? 8 : 16; }

  function smallestVersion(byteLength, level, minVersion) {
    for (var v = minVersion || 1; v <= 40; v++) {
      var capacity = dataCodewordCount(v, level) * 8 - 4 - lengthBits(v);
      if (byteLength * 8 <= capacity) return v;
    }
    return null;
  }

  function buildCodewords(bytes, version, level) {
    var bits = [];
    function push(value, count) {
      for (var i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }

    push(4, 4);                                   // modo byte
    push(bytes.length, lengthBits(version));
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capacity = dataCodewordCount(version, level) * 8;
    push(0, Math.min(4, capacity - bits.length));  // terminador
    while (bits.length % 8) bits.push(0);

    var codewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      codewords.push(byte);
    }
    // preenchimento alternado da norma até encher a capacidade
    var padding = [0xec, 0x11];
    for (var p = 0; codewords.length < capacity / 8; p++) {
      codewords.push(padding[p % 2]);
    }
    return codewords;
  }

  /** Divide em blocos, calcula a correção e intercala como manda a norma. */
  function interleave(codewords, version, level) {
    var spec = BLOCKS[level][version - 1];
    var ecPerBlock = spec[0], g1 = spec[1], g2 = spec[2];
    var totalBlocks = g1 + g2;
    var perBlock = Math.floor(codewords.length / totalBlocks);

    var dataBlocks = [], ecBlocks = [], offset = 0;
    for (var b = 0; b < totalBlocks; b++) {
      var size = perBlock + (b >= g1 ? 1 : 0);
      var block = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ecPerBlock));
    }

    var out = [];
    var maxData = perBlock + (g2 ? 1 : 0);
    for (var i = 0; i < maxData; i++) {
      for (var d = 0; d < totalBlocks; d++) {
        if (i < dataBlocks[d].length) out.push(dataBlocks[d][i]);
      }
    }
    for (var e = 0; e < ecPerBlock; e++) {
      for (var k = 0; k < totalBlocks; k++) out.push(ecBlocks[k][e]);
    }
    return out;
  }

  // -------------------------------------------------------------- matriz

  function makeMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) {
      m.push({ row: new Int8Array(size).fill(-1) });  // -1 = módulo ainda livre
    }
    return m;
  }

  function placeFinder(m, size, top, left) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var y = top + r, x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        var dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[y].row[x] = dark ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, size, version) {
    var centers = ALIGNMENT[version - 1];
    for (var i = 0; i < centers.length; i++) {
      for (var j = 0; j < centers.length; j++) {
        var cy = centers[i], cx = centers[j];
        if (m[cy].row[cx] !== -1) continue;       // não pisa nos localizadores
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            m[cy + r].row[cx + c] = dark ? 1 : 0;
          }
        }
      }
    }
  }

  function placeTiming(m, size) {
    for (var i = 8; i < size - 8; i++) {
      var dark = i % 2 === 0 ? 1 : 0;
      if (m[6].row[i] === -1) m[6].row[i] = dark;
      if (m[i].row[6] === -1) m[i].row[6] = dark;
    }
  }

  /** Reserva as áreas de formato e versão, para o zigue-zague não usá-las. */
  function reserveFormat(m, size, version) {
    for (var i = 0; i < 9; i++) {
      if (m[8].row[i] === -1) m[8].row[i] = 0;
      if (m[i].row[8] === -1) m[i].row[8] = 0;
    }
    for (var j = 0; j < 8; j++) {
      if (m[8].row[size - 1 - j] === -1) m[8].row[size - 1 - j] = 0;
      if (m[size - 1 - j].row[8] === -1) m[size - 1 - j].row[8] = 0;
    }
    m[size - 8].row[8] = 1;                       // módulo escuro, sempre presente

    if (version >= 7) {
      for (var v = 0; v < 18; v++) {
        var r = Math.floor(v / 3), c = v % 3;
        m[size - 11 + c].row[r] = 0;
        m[r].row[size - 11 + c] = 0;
      }
    }
  }

  function placeData(m, size, codewords) {
    var bitIndex = 0;
    var direction = -1;
    var row = size - 1;

    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                       // a coluna de timing é pulada
      while (true) {
        for (var i = 0; i < 2; i++) {
          var x = col - i;
          if (m[row].row[x] === -1) {
            var bit = 0;
            if (bitIndex < codewords.length * 8) {
              bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
            }
            m[row].row[x] = bit;
            bitIndex++;
          }
        }
        row += direction;
        if (row < 0 || row >= size) {
          row -= direction;
          direction = -direction;
          break;
        }
      }
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  /** Marca quais módulos são de função, e portanto não recebem máscara. */
  function functionMap(size, version) {
    var m = makeMatrix(size);
    placeFinder(m, size, 0, 0);
    placeFinder(m, size, 0, size - 7);
    placeFinder(m, size, size - 7, 0);
    placeAlignment(m, size, version);
    placeTiming(m, size);
    reserveFormat(m, size, version);
    var map = [];
    for (var r = 0; r < size; r++) {
      map.push(Array.from(m[r].row, function (v) { return v !== -1; }));
    }
    return map;
  }

  function applyMask(matrix, isFunction, maskIndex) {
    var size = matrix.length;
    var out = matrix.map(function (row) { return row.slice(); });
    var mask = MASKS[maskIndex];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!isFunction[r][c] && mask(r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  /** Penalidade da norma: escolhe a máscara que deixa o código mais legível. */
  function penalty(m) {
    var size = m.length, score = 0;

    function runScore(run) { return run >= 5 ? 3 + (run - 5) : 0; }

    for (var r = 0; r < size; r++) {
      var runV = 1, runH = 1;
      for (var c = 1; c < size; c++) {
        runH = m[r][c] === m[r][c - 1] ? runH + 1 : (score += runScore(runH), 1);
        runV = m[c][r] === m[c - 1][r] ? runV + 1 : (score += runScore(runV), 1);
      }
      score += runScore(runH) + runScore(runV);
    }

    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }

    var padrao = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var invertido = padrao.slice().reverse();
    for (var i = 0; i < size; i++) {
      for (var j = 0; j + 11 <= size; j++) {
        var linha = true, coluna = true, linhaInv = true, colunaInv = true;
        for (var k = 0; k < 11; k++) {
          if (m[i][j + k] !== padrao[k]) linha = false;
          if (m[j + k][i] !== padrao[k]) coluna = false;
          if (m[i][j + k] !== invertido[k]) linhaInv = false;
          if (m[j + k][i] !== invertido[k]) colunaInv = false;
        }
        if (linha) score += 40;
        if (coluna) score += 40;
        if (linhaInv) score += 40;
        if (colunaInv) score += 40;
      }
    }

    var dark = 0;
    for (var a = 0; a < size; a++) {
      for (var b = 0; b < size; b++) dark += m[a][b];
    }
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // BCH(15,5) do formato, com a máscara fixa da norma.
  function formatBits(level, maskIndex) {
    var data = (ECC_BITS[level] << 3) | maskIndex;
    var rest = data << 10;
    for (var i = 14; i >= 10; i--) {
      if ((rest >> i) & 1) rest ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rest) ^ 0x5412;
  }

  // BCH(18,6) da versão, presente a partir da versão 7.
  function versionBits(version) {
    var rest = version << 12;
    for (var i = 17; i >= 12; i--) {
      if ((rest >> i) & 1) rest ^= 0x1f25 << (i - 12);
    }
    return (version << 12) | rest;
  }

  function placeFormat(m, size, level, maskIndex) {
    var bits = formatBits(level, maskIndex);
    for (var i = 0; i < 15; i++) {
      var bit = (bits >> i) & 1;
      // cópia junto ao localizador superior esquerdo
      if (i < 6) m[i][8] = bit;
      else if (i === 6) m[7][8] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
      // cópia espelhada, nos outros dois cantos
      if (i < 8) m[8][size - 1 - i] = bit;
      else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = 1;
  }

  function placeVersion(m, size, version) {
    if (version < 7) return;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  /**
   * Gera o QR Code.
   *
   * @param {string} text
   * @param {object} [opt]  { level: 'L'|'M'|'Q'|'H', minVersion: number }
   * @returns {{size:number, version:number, level:string, mask:number,
   *            modules:number[][]}}  modules[y][x] = 1 quando escuro
   */
  function encode(text, opt) {
    opt = opt || {};
    var level = opt.level || 'M';
    if (!BLOCKS[level]) throw new Error('Nível de correção inválido: ' + level);

    var bytes = utf8Bytes(String(text));
    if (!bytes.length) throw new Error('Nada para codificar.');

    var version = smallestVersion(bytes.length, level, opt.minVersion);
    if (!version) {
      throw new Error('Texto longo demais para um QR Code no nível ' + level +
        ' (' + bytes.length + ' bytes).');
    }

    var codewords = interleave(buildCodewords(bytes, version, level), version, level);
    var size = version * 4 + 17;

    var work = makeMatrix(size);
    placeFinder(work, size, 0, 0);
    placeFinder(work, size, 0, size - 7);
    placeFinder(work, size, size - 7, 0);
    placeAlignment(work, size, version);
    placeTiming(work, size);
    reserveFormat(work, size, version);
    placeData(work, size, codewords);

    var base = [];
    for (var r = 0; r < size; r++) base.push(Array.from(work[r].row));
    var isFunction = functionMap(size, version);

    // A norma manda escolher a máscara de menor penalidade.
    // forceMask existe para os testes compararem com uma implementação de
    // referência módulo a módulo, sem a escolha atrapalhar.
    var best = null;
    var from = opt.forceMask != null ? opt.forceMask : 0;
    var to = opt.forceMask != null ? opt.forceMask : 7;
    for (var mi = from; mi <= to; mi++) {
      var candidate = applyMask(base, isFunction, mi);
      placeFormat(candidate, size, level, mi);
      placeVersion(candidate, size, version);
      var score = penalty(candidate);
      if (!best || score < best.score) best = { score: score, mask: mi, modules: candidate };
    }

    return {
      size: size,
      version: version,
      level: level,
      mask: best.mask,
      modules: best.modules
    };
  }

  /**
   * Converte a matriz num único path SVG: cada módulo escuro vira um subpath
   * quadrado. Um path só, em vez de milhares de retângulos, é o que mantém o
   * QR leve como vetor dentro do Figma.
   *
   * @param {object} qr        resultado de encode()
   * @param {number} moduleSize  tamanho do módulo nas unidades do desenho
   * @param {number} [quiet=4]   margem obrigatória, em módulos
   */
  function toPath(qr, moduleSize, quiet) {
    quiet = quiet == null ? 4 : quiet;
    var parts = [];
    for (var y = 0; y < qr.size; y++) {
      var x = 0;
      while (x < qr.size) {
        if (!qr.modules[y][x]) { x++; continue; }
        var run = 1;
        while (x + run < qr.size && qr.modules[y][x + run]) run++;  // junta módulos vizinhos
        var x0 = (x + quiet) * moduleSize;
        var y0 = (y + quiet) * moduleSize;
        var x1 = x0 + run * moduleSize;
        var y1 = y0 + moduleSize;
        // Só M, L e Z: o parser de vectorPaths do Figma recusa as formas
        // abreviadas h e v, e falha o nó inteiro se encontrar uma.
        parts.push('M' + fmt(x0) + ' ' + fmt(y0) +
                   'L' + fmt(x1) + ' ' + fmt(y0) +
                   'L' + fmt(x1) + ' ' + fmt(y1) +
                   'L' + fmt(x0) + ' ' + fmt(y1) + 'Z');
        x += run;
      }
    }
    return parts.join('');
  }

  function fmt(v) {
    return String(Math.round(v * 1000) / 1000);
  }

  /** Lado total do desenho, já com as duas margens. */
  function totalSize(qr, moduleSize, quiet) {
    quiet = quiet == null ? 4 : quiet;
    return (qr.size + quiet * 2) * moduleSize;
  }

  root.QR = {
    encode: encode,
    toPath: toPath,
    totalSize: totalSize,
    _internals: { ecCodewords: ecCodewords, formatBits: formatBits, versionBits: versionBits,
                  penalty: penalty,
                  capacity: function (version, level) {
                    return { data: dataCodewordCount(version, level),
                             total: TOTAL_CODEWORDS[version - 1],
                             blocks: BLOCKS[level][version - 1] };
                  } }
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
