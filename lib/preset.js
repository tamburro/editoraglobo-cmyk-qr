/* preset.js — presets de fechamento de arquivo.
 *
 * Cada preset é a tradução de um .joboptions do InDesign para as opções que este
 * plugin conhece. Ficam declarados aqui, num lugar só, para que o que a UI
 * aplica e o que a documentação promete não possam divergir.
 */
(function (root) {
  'use strict';

  /**
   * O fechamento da editora, traduzido do .joboptions do InDesign e do .csf do
   * Photoshop. É um só de propósito: quem fecha a arte não escolhe padrão de
   * impressão, segue o da casa.
   */
  var ACTIVE = {
    id: 'edg-jornal',
    label: 'Editora Globo — jornal',
    source: 'Photoshop Papel Jornal.csf + preset do InDesign',
    profiles: {
      // As imagens são separadas pelo perfil do Photoshop da editora...
      separation: 'SWOP (Jornal), 30%, GCR, Carregado',
      // ...e o PDF declara a condição de impressão do preset do InDesign.
      outputIntent: 'US Newsprint (SNAP 2007)'
    },
    settings: {
      format: 'pdfx',                   // PDFX1a:2001 + CompatibilityLevel 1.3
      dpi: 300,                         // ColorImageResolution 300, sem downsample
      intent: 1,                        // colorimétrica relativa, o padrão da Adobe em impressão
      bg: 'ffffff',                     // PDF/X não tem transparência: compõe sobre branco
      embedIcc: true
    },
    // Papel jornal não segura muita tinta somada; acima disso borra.
    inkLimit: 240,
    summary: [
      'PDF/X-1a:2001 (PDF 1.3), sem transparência',
      'Imagem DeviceCMYK a 300 DPI, sem reamostragem',
      'Separação: SWOP (Jornal), 30%, GCR, Carregado',
      'OutputIntent do PDF: US Newsprint (SNAP 2007)',
      'TrimBox = BleedBox = MediaBox · Trapped False'
    ]
  };

  /**
   * Tintas de uso corrente em jornal, todas dentro do limite de tinta.
   * São o atalho para trocar a cor de um objeto sem digitar número.
   */
  var INKS = [
    { name: 'Branco',           cmyk: [0, 0, 0, 0] },
    { name: 'Preto de texto',   cmyk: [0, 0, 0, 1] },
    { name: 'Preto reforçado',  cmyk: [0.4, 0.3, 0.3, 1] },
    { name: 'Cinza 50%',        cmyk: [0, 0, 0, 0.5] },
    { name: 'Cinza 20%',        cmyk: [0, 0, 0, 0.2] },
    { name: 'Ciano',            cmyk: [1, 0, 0, 0] },
    { name: 'Magenta',          cmyk: [0, 1, 0, 0] },
    { name: 'Amarelo',          cmyk: [0, 0, 1, 0] },
    { name: 'Vermelho',         cmyk: [0, 1, 1, 0] },
    { name: 'Azul',             cmyk: [1, 0.6, 0, 0.1] },
    { name: 'Verde',            cmyk: [1, 0, 1, 0] },
    { name: 'Laranja',          cmyk: [0, 0.5, 1, 0] }
  ];

  /** Soma das tintas em %, que é o que a gráfica limita. */
  function totalInk(cmyk) {
    return Math.round((cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3]) * 100);
  }

  /**
   * Confere se o estado atual atende ao preset.
   *
   * O perfil tem dois papéis, e eles podem ser perfis diferentes: um separa os
   * pixels (é o que vira tinta) e outro é declarado no OutputIntent do PDF
   * (é a condição de impressão que o arquivo diz atender).
   *
   * @param {object} preset
   * @param {object} current
   *   { separationName, outputIntentName, hasSeparation, hasOutputIntent, dpi, format }
   * @returns {{ok:boolean, problems:string[], warnings:string[]}}
   */
  function validate(preset, current) {
    var problems = [], warnings = [];
    if (!preset || !preset.settings) return { ok: true, problems: problems, warnings: warnings };
    var wanted = preset.profiles || {};

    if (!current.hasSeparation) {
      problems.push('Falta o perfil de separação' +
        (wanted.separation ? ' (' + wanted.separation + ')' : '') + '.');
    }
    if (preset.settings.format === 'pdfx' && !current.hasOutputIntent) {
      problems.push('Falta o perfil do OutputIntent' +
        (wanted.outputIntent ? ' (' + wanted.outputIntent + ')' : '') + '.');
    }

    if (wanted.separation && current.hasSeparation && current.separationName &&
        normalize(current.separationName) !== normalize(wanted.separation)) {
      warnings.push('A separação está em "' + current.separationName + '", e o preset pede "' +
        wanted.separation + '". Muda a tinta que vai para a chapa.');
    }
    if (preset.settings.format === 'pdfx' && wanted.outputIntent && current.hasOutputIntent &&
        current.outputIntentName &&
        normalize(current.outputIntentName) !== normalize(wanted.outputIntent)) {
      warnings.push('O OutputIntent está em "' + current.outputIntentName + '", e o preset pede "' +
        wanted.outputIntent + '".');
    }

    if (preset.settings.dpi && current.dpi && current.dpi < preset.settings.dpi) {
      warnings.push('O preset pede ' + preset.settings.dpi + ' DPI e está em ' + current.dpi + '.');
    }
    if (preset.settings.format && current.format && current.format !== preset.settings.format) {
      warnings.push('O preset gera ' + (preset.settings.format === 'pdfx' ? 'PDF/X-1a' : 'TIFF') +
        ' e o formato foi trocado à mão.');
    }
    return { ok: !problems.length, problems: problems, warnings: warnings };
  }

  function normalize(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  root.Presets = {
    active: ACTIVE,
    inks: INKS,
    totalInk: totalInk,
    validate: validate
  };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
