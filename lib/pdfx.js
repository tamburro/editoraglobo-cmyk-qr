/* pdfx.js — gravador de PDF/X-1a:2001 de uma página com a imagem CMYK.
 *
 * Segue o preset "Adobe InDesign PDF Preset Editora Globo":
 *   PDF 1.3 · PDF/X-1a:2001 · sem transparência · sem downsampling
 *   OutputIntent com o perfil ICC de destino embutido
 *   TrimBox = BleedBox = MediaBox (offsets zerados no preset)
 *
 * Diferença consciente: o preset recomprime imagens com DCTEncode (JPEG). Aqui a
 * imagem vai em FlateDecode — sem perda, permitido em PDF 1.3 e em PDF/X-1a.
 */
(function (root) {
  'use strict';

  function bytesOf(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /** Escapa texto para string literal PDF, mantendo só ASCII imprimível. */
  function pdfString(s) {
    var clean = String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '-');
    return '(' + clean.replace(/([\\()])/g, '\\$1') + ')';
  }

  function pdfDate(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var tz = -d.getTimezoneOffset();
    var sign = tz >= 0 ? '+' : '-';
    tz = Math.abs(tz);
    return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      sign + p(Math.floor(tz / 60)) + "'" + p(tz % 60) + "'";
  }

  /** ID do documento: 16 bytes em hexa, exigido pelo PDF/X. */
  function documentId(seed) {
    var hex = '';
    for (var i = 0; i < 16; i++) {
      var v = (Math.floor(Math.sin(seed + i * 977) * 4294967296) >>> 0) & 0xff;
      hex += (v < 16 ? '0' : '') + v.toString(16);
    }
    return hex;
  }

  function xmp(title, condition, created) {
    return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
      ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      '  <rdf:Description rdf:about=""\n' +
      '    xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"\n' +
      '    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"\n' +
      '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n' +
      '    xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '   <pdfx:GTS_PDFXVersion>PDF/X-1:2001</pdfx:GTS_PDFXVersion>\n' +
      '   <pdfx:GTS_PDFXConformance>PDF/X-1a:2001</pdfx:GTS_PDFXConformance>\n' +
      '   <pdf:Trapped>False</pdf:Trapped>\n' +
      '   <xmp:CreateDate>' + created + '</xmp:CreateDate>\n' +
      '   <xmp:CreatorTool>editoraglobo-cmyk-qr (Figma)</xmp:CreatorTool>\n' +
      '   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">' +
      String(title).replace(/[<&>]/g, '') + '</rdf:li></rdf:Alt></dc:title>\n' +
      '   <dc:format>application/pdf</dc:format>\n' +
      '   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">' +
      String(condition).replace(/[<&>]/g, '') + '</rdf:li></rdf:Alt></dc:description>\n' +
      '  </rdf:Description>\n' +
      ' </rdf:RDF>\n' +
      '</x:xmpmeta>\n<?xpacket end="w"?>';
  }

  /**
   * @param {object} o
   * @param {number} o.width           pixels
   * @param {number} o.height          pixels
   * @param {Uint8Array} o.imageData   imagem CMYK já comprimida (ver `filter`)
   * @param {string} [o.filter='FlateDecode']
   * @param {Uint8Array} o.icc         perfil CMYK do OutputIntent (obrigatório em PDF/X)
   * @param {Uint8Array} [o.iccCompressed] mesmo perfil em Flate, se disponível
   * @param {number} [o.dpi=300]
   * @param {string} [o.title]
   * @param {string} [o.outputCondition] nome do perfil, ex. 'US Newsprint (SNAP 2007)'
   * @returns {Uint8Array}
   */
  function writePdfX1a(o) {
    if (!o.icc || !o.icc.length) {
      throw new Error('PDF/X-1a exige o perfil ICC de destino (OutputIntent).');
    }
    var dpi = o.dpi || 300;
    var filter = o.filter || 'FlateDecode';
    // 1 pt = 1/72". A página fica exatamente do tamanho físico da imagem.
    var pageW = o.width * 72 / dpi;
    var pageH = o.height * 72 / dpi;
    var round = function (v) { return Math.round(v * 1000) / 1000; };
    var now = new Date();
    var condition = o.outputCondition || 'Unknown';
    var title = o.title || 'Sem titulo';

    var objects = [];                                // objects[i] = corpo do objeto i+1
    function add(body) { objects.push(body); return objects.length; }

    var catalogNum = add(null);                      // reservado: precisa referenciar filhos
    var pagesNum = add(null);
    var pageNum = add(null);
    var contentNum = add(null);
    var imageNum = add(null);
    var iccNum = add(null);
    var intentNum = add(null);
    var metaNum = add(null);
    var infoNum = add(null);

    var content = 'q\n' + round(pageW) + ' 0 0 ' + round(pageH) + ' 0 0 cm\n/Im0 Do\nQ\n';
    var meta = xmp(title, condition, now.toISOString().replace(/\.\d+Z$/, 'Z'));

    var iccStream = o.iccCompressed || o.icc;
    var iccFilter = o.iccCompressed ? '/Filter /FlateDecode ' : '';

    objects[catalogNum - 1] = {
      dict: '<< /Type /Catalog /Pages ' + pagesNum + ' 0 R ' +
            '/OutputIntents [' + intentNum + ' 0 R] /Metadata ' + metaNum + ' 0 R >>'
    };
    objects[pagesNum - 1] = {
      dict: '<< /Type /Pages /Kids [' + pageNum + ' 0 R] /Count 1 >>'
    };
    objects[pageNum - 1] = {
      // TrimBox e BleedBox são obrigatórios em PDF/X; o preset zera os offsets.
      dict: '<< /Type /Page /Parent ' + pagesNum + ' 0 R ' +
            '/MediaBox [0 0 ' + round(pageW) + ' ' + round(pageH) + '] ' +
            '/TrimBox [0 0 ' + round(pageW) + ' ' + round(pageH) + '] ' +
            '/BleedBox [0 0 ' + round(pageW) + ' ' + round(pageH) + '] ' +
            '/Resources << /XObject << /Im0 ' + imageNum + ' 0 R >> /ProcSet [/PDF /ImageC] >> ' +
            '/Contents ' + contentNum + ' 0 R >>'
    };
    objects[contentNum - 1] = { dict: '<< /Length ' + content.length + ' >>', stream: bytesOf(content) };
    objects[imageNum - 1] = {
      dict: '<< /Type /XObject /Subtype /Image /Name /Im0 ' +
            '/Width ' + o.width + ' /Height ' + o.height + ' ' +
            '/ColorSpace /DeviceCMYK /BitsPerComponent 8 ' +
            '/Filter /' + filter + ' /Length ' + o.imageData.length + ' >>',
      stream: o.imageData
    };
    objects[iccNum - 1] = {
      dict: '<< /N 4 ' + iccFilter + '/Length ' + iccStream.length + ' >>',
      stream: iccStream
    };
    objects[intentNum - 1] = {
      dict: '<< /Type /OutputIntent /S /GTS_PDFX ' +
            '/OutputConditionIdentifier ' + pdfString(condition) + ' ' +
            '/OutputCondition ' + pdfString(condition) + ' ' +
            '/RegistryName () /Info ' + pdfString(condition) + ' ' +
            '/DestOutputProfile ' + iccNum + ' 0 R >>'
    };
    objects[metaNum - 1] = {
      dict: '<< /Type /Metadata /Subtype /XML /Length ' + meta.length + ' >>',
      stream: bytesOf(meta)
    };
    objects[infoNum - 1] = {
      dict: '<< /Title ' + pdfString(title) +
            ' /Creator ' + pdfString('editoraglobo-cmyk-qr (Figma)') +
            ' /Producer ' + pdfString('editoraglobo-cmyk-qr (Figma)') +
            ' /CreationDate ' + pdfString(pdfDate(now)) +
            ' /ModDate ' + pdfString(pdfDate(now)) +
            ' /GTS_PDFXVersion ' + pdfString('PDF/X-1:2001') +
            ' /GTS_PDFXConformance ' + pdfString('PDF/X-1a:2001') +
            ' /Trapped /False >>'
    };

    // ---- serialização
    var chunks = [];
    var length = 0;
    function push(u8) { chunks.push(u8); length += u8.length; }
    function pushText(s) { push(bytesOf(s)); }

    // O comentário binário avisa as ferramentas de que o arquivo não é texto.
    pushText('%PDF-1.3\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    var offsets = new Array(objects.length + 1).fill(0);
    for (var i = 0; i < objects.length; i++) {
      offsets[i + 1] = length;
      var obj = objects[i];
      pushText((i + 1) + ' 0 obj\n' + obj.dict + '\n');
      if (obj.stream) {
        pushText('stream\n');
        push(obj.stream);
        pushText('\nendstream\n');
      }
      pushText('endobj\n');
    }

    var xrefStart = length;
    var xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (var j = 1; j <= objects.length; j++) {
      xref += String(offsets[j]).padStart(10, '0') + ' 00000 n \n';
    }
    var id = documentId(now.getTime() % 100000 + o.width);
    xref += 'trailer\n<< /Size ' + (objects.length + 1) +
            ' /Root ' + catalogNum + ' 0 R /Info ' + infoNum + ' 0 R ' +
            '/ID [<' + id + '> <' + id + '>] >>\n' +
            'startxref\n' + xrefStart + '\n%%EOF\n';
    pushText(xref);

    var out = new Uint8Array(length);
    var p = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], p); p += chunks[c].length; }
    return out;
  }

  root.PdfX = { writePdfX1a: writePdfX1a, _internals: { pdfDate: pdfDate, pdfString: pdfString } };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
