/* embed-profile.js — assa perfis ICC dentro do plugin.
 *
 * Com o perfil embutido, o preset da editora funciona em um clique: quem usa o
 * plugin não precisa achar o .icc no disco nem carregá-lo a cada sessão.
 * Pode receber mais de um perfil; a UI escolhe o que o preset pedir.
 *
 * Uso:
 *   node tools/embed-profile.js perfil1.icc [perfil2.icc ...]
 *   node build.js
 *
 * Para remover, apague lib/profile-embedded.js e rode build.js.
 *
 * Atenção: perfis ICC têm licença própria. Os que vêm com o Creative Cloud ou o
 * Windows podem ser usados no fluxo de quem tem a licença, mas não saem
 * redistribuídos — por isso nenhum perfil vive no repositório, e cada equipe
 * embute o seu.
 */
const fs = require('fs');
const path = require('path');
const { ICC } = require('../lib/icc.js');

const sources = process.argv.slice(2);
if (!sources.length) {
  console.error('Informe ao menos um .icc. Ex.:');
  console.error('  node tools/embed-profile.js profiles/SWOP-Jornal-30-GCR.icc \\');
  console.error('    "C:/Windows/System32/spool/drivers/color/USNewsprintSNAP2007.icc"');
  process.exit(1);
}

const entries = sources.map((source) => {
  const bytes = fs.readFileSync(source);

  // Confere que é mesmo um perfil CMYK utilizável antes de assar no plugin.
  if (bytes.length < 132 || bytes.toString('latin1', 36, 40) !== 'acsp') {
    console.error(source + ': não parece um perfil ICC (assinatura "acsp" ausente).');
    process.exit(1);
  }
  const space = bytes.toString('latin1', 16, 20).trim();
  if (space !== 'CMYK') {
    console.error(source + ': o perfil é ' + space + ', e o preset precisa de CMYK.');
    process.exit(1);
  }
  const profile = ICC.parse(new Uint8Array(bytes).buffer);
  if (!profile.tags['B2A0']) {
    console.error(source + ': perfil sem tabela B2A0, não serve para separar.');
    process.exit(1);
  }

  return {
    name: profile.description || path.basename(source),
    file: path.basename(source),
    bytes,
    base64: bytes.toString('base64')
  };
});

const body = entries.map((e) => `    {
      name: ${JSON.stringify(e.name)},
      file: ${JSON.stringify(e.file)},
      size: ${e.bytes.length},
      base64: '${e.base64}'
    }`).join(',\n');

const out = `/* profile-embedded.js — GERADO por tools/embed-profile.js. Não edite à mão.
 *
${entries.map((e) => ` * ${e.name} (${e.file}, ${(e.bytes.length / 1024).toFixed(0)} KB)`).join('\n')}
 *
 * Ficam embutidos para os presets rodarem sem pedir o .icc ao operador.
 */
(function (root) {
  'use strict';

  var RAW = [
${body}
  ];

  var cache = {};

  function decode(base64) {
    var bin = atob(base64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var list = RAW.map(function (entry, i) {
    return {
      name: entry.name,
      file: entry.file,
      size: entry.size,
      /** @returns {Uint8Array} bytes do perfil, decodificados sob demanda */
      bytes: function () {
        if (!cache[i]) cache[i] = decode(entry.base64);
        return cache[i];
      }
    };
  });

  /** Acha um perfil embutido pelo nome, ignorando pontuação e caixa. */
  function find(name) {
    if (!name) return null;
    var key = normalize(name);
    for (var i = 0; i < list.length; i++) {
      if (normalize(list[i].name) === key) return list[i];
    }
    return null;
  }

  function normalize(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  root.EmbeddedProfiles = { list: list, find: find };
})(typeof module !== 'undefined' && module.exports ? module.exports : (this.CMYKLIB = this.CMYKLIB || {}));
`;

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'profile-embedded.js'), out);
console.log('lib/profile-embedded.js gerado com ' + entries.length + ' perfil(is):');
entries.forEach((e) => {
  console.log('  ' + e.name + ' — ' + (e.bytes.length / 1024).toFixed(0) + ' KB → ' +
              (e.base64.length / 1024).toFixed(0) + ' KB em base64');
});
console.log('Rode `node build.js` para embutir na UI.');
