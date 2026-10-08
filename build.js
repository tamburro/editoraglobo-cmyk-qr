/* build.js — gera ui.html a partir de ui.template.html, embutindo as libs.
 * O Figma carrega a UI de um único arquivo HTML, então não há como usar <script src>.
 * Uso: node build.js
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const template = fs.readFileSync(path.join(root, 'ui.template.html'), 'utf8');

function inline(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return '<script>\n/* ==== ' + file + ' (embutido por build.js — edite o original) ==== */\n' +
         src + '\n</script>';
}

let out = template.replace(/^[ \t]*<!--@include\s+(.+?)\s*-->[ \t]*$/gm, (_, file) => inline(file));

// O perfil ICC embutido é opcional: só existe depois de rodar tools/embed-profile.js.
out = out.replace(/^[ \t]*<!--@include-optional\s+(.+?)\s*-->[ \t]*$/gm, (_, file) => {
  if (!fs.existsSync(path.join(root, file))) {
    console.log('sem ' + file + ' — o preset vai pedir o .icc ao operador');
    return '<!-- ' + file + ' ausente -->';
  }
  return inline(file);
});

if (out.includes('@include')) {
  console.error('Aviso: sobrou um marcador @include não resolvido.');
  process.exit(1);
}

fs.writeFileSync(path.join(root, 'ui.html'), out);
console.log('ui.html gerado (' + (out.length / 1024).toFixed(1) + ' KB)');
