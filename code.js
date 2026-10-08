/* code.js — thread principal do plugin (sandbox do Figma).
 * Responsabilidades: ler a seleção, mandar miniaturas, gravar/ler as cores CMYK
 * escolhidas à mão e exportar PNG na resolução de pixels certa.
 * A conversão de cor e a gravação do TIFF/PDF acontecem na UI (iframe), onde
 * existem canvas, ImageBitmap, CompressionStream e download.
 */

figma.showUI(__html__, { width: 460, height: 760, themeColors: true });

// O Figma trata 1px de canvas como 1pt (72 DPI). Para exportar "a 300 DPI"
// mantendo o tamanho físico, a imagem precisa de dpi/72 vezes mais pixels.
var FIGMA_DPI = 72;

// Teto do canvas do browser, onde a conversão acontece.
var MAX_DIMENSION = 16384;

// Chave de pluginData onde fica a tinta exata de cada objeto. Por ser pluginData,
// a escolha viaja junto com o arquivo e sobrevive ao fechar o plugin.
var CMYK_KEY = 'exactCmyk';

var THUMB_WIDTH = 120;

// Onde o perfil ICC carregado à mão fica guardado entre sessões. É por máquina
// (clientStorage), não por arquivo: o perfil é da gráfica, não da arte.
var PROFILE_KEYS = { separation: 'iccProfile', outputIntent: 'iccProfileOutputIntent' };

var EXPORTABLE = {
  FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, GROUP: 1, SECTION: 1,
  RECTANGLE: 1, ELLIPSE: 1, POLYGON: 1, STAR: 1, VECTOR: 1, LINE: 1, TEXT: 1,
  BOOLEAN_OPERATION: 1, SLICE: 1
};

// Nós que aceitam preenchimento sólido, ou seja, que podem receber cor exata.
function acceptsFill(node) {
  return 'fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills);
}

function readExactCmyk(node) {
  try {
    var raw = node.getPluginData(CMYK_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || !parsed.cmyk || parsed.cmyk.length !== 4) return null;
    return parsed;                                  // { cmyk: [0..1 x4], rgb: [0..255 x3] }
  } catch (e) {
    return null;
  }
}

/** Cor do preenchimento sólido do nó, em 0..255, ou null se não houver. */
function solidFillRgb(node) {
  if (!acceptsFill(node) || !node.fills.length) return null;
  var fill = node.fills[node.fills.length - 1];     // o de cima é o que se vê
  if (fill.type !== 'SOLID' || fill.visible === false) return null;
  return [
    Math.round(fill.color.r * 255),
    Math.round(fill.color.g * 255),
    Math.round(fill.color.b * 255)
  ];
}

function describe(node) {
  var exact = readExactCmyk(node);
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(node.width * 100) / 100,
    height: Math.round(node.height * 100) / 100,
    exportable: !!EXPORTABLE[node.type],
    fillable: acceptsFill(node),
    fillRgb: solidFillRgb(node),
    exactCmyk: exact ? exact.cmyk : null
  };
}

function sendSelection() {
  var selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selection',
    nodes: selection.map(describe),
    figmaDpi: FIGMA_DPI
  });
  sendThumbnails(selection);
}

/** Miniaturas vão em mensagens separadas: a lista não espera pelo render. */
function sendThumbnails(nodes) {
  nodes.forEach(function (node) {
    if (!EXPORTABLE[node.type] || node.width < 1 || node.height < 1) return;
    node.exportAsync({
      format: 'PNG',
      constraint: { type: 'WIDTH', value: Math.min(THUMB_WIDTH, Math.round(node.width)) }
    }).then(function (bytes) {
      figma.ui.postMessage({ type: 'thumb', id: node.id, bytes: bytes });
    }).catch(function () {
      /* miniatura é enfeite: se falhar, a lista segue sem ela */
    });
  });
}

figma.on('selectionchange', sendSelection);

figma.ui.onmessage = function (msg) {
  if (msg.type === 'ready') {
    sendSelection();
    return sendStoredProfile();
  }

  if (msg.type === 'saveProfile') return saveProfile(msg);

  if (msg.type === 'export') {
    return exportNodes(msg).catch(function (err) {
      figma.ui.postMessage({ type: 'error', message: String(err && err.message || err) });
    });
  }

  if (msg.type === 'insertQr') return insertQr(msg);
  if (msg.type === 'applyCmyk') return applyCmyk(msg);
  if (msg.type === 'clearCmyk') return clearCmyk(msg);

  if (msg.type === 'notify') {
    return figma.notify(msg.message, { error: !!msg.error, timeout: msg.timeout || 3000 });
  }

  if (msg.type === 'close') figma.closePlugin(msg.message);
};

// ------------------------------------------------------------ perfil salvo

/** Devolve à UI os perfis guardados na última sessão, se houver. */
function sendStoredProfile() {
  var roles = Object.keys(PROFILE_KEYS);
  return Promise.all(roles.map(function (role) {
    return figma.clientStorage.getAsync(PROFILE_KEYS[role]).then(function (stored) {
      if (stored && stored.base64) {
        figma.ui.postMessage({
          type: 'storedProfile', role: role, base64: stored.base64, name: stored.name
        });
      }
    });
  })).catch(function () {
    /* sem perfil guardado, a UI segue pedindo o arquivo */
  });
}

function saveProfile(msg) {
  var key = PROFILE_KEYS[msg.role] || PROFILE_KEYS.separation;
  return figma.clientStorage.setAsync(key, {
    base64: msg.base64, name: msg.name
  }).catch(function (err) {
    // Estourar a cota não pode derrubar a exportação; o perfil só não persiste.
    figma.ui.postMessage({
      type: 'profileNotSaved',
      message: String(err && err.message || err)
    });
  });
}

// -------------------------------------------------------------- cores exatas

/**
 * Marca os nós com uma tinta CMYK exata: o preenchimento na tela vira a
 * simulação RGB dessa tinta (calculada na UI pelo perfil) e o valor CMYK fica
 * guardado para a exportação usar sem passar pela conversão.
 */
function applyCmyk(msg) {
  var rgb = msg.rgb;                                // 0..255
  var payload = JSON.stringify({ cmyk: msg.cmyk, rgb: rgb });
  var applied = 0, skipped = 0;

  var jobs = (msg.ids || []).map(function (id) {
    return figma.getNodeByIdAsync(id).then(function (node) {
      if (!node) return;
      if (!acceptsFill(node)) { skipped++; return; }
      node.fills = [{
        type: 'SOLID',
        color: { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 },
        opacity: 1
      }];
      node.setPluginData(CMYK_KEY, payload);
      applied++;
    });
  });

  return Promise.all(jobs).then(function () {
    var pct = msg.cmyk.map(function (v) { return Math.round(v * 100); }).join('/');
    figma.notify(applied
      ? applied + ' objeto(s) em CMYK ' + pct + (skipped ? ' · ' + skipped + ' sem preenchimento' : '')
      : 'Nenhum objeto selecionado aceita preenchimento sólido.', { error: !applied });
    sendSelection();
  });
}

function clearCmyk(msg) {
  var jobs = (msg.ids || []).map(function (id) {
    return figma.getNodeByIdAsync(id).then(function (node) {
      if (node) node.setPluginData(CMYK_KEY, '');
    });
  });
  return Promise.all(jobs).then(function () {
    figma.notify('Cor exata removida.');
    sendSelection();
  });
}

// ------------------------------------------------------------------- QR code

/**
 * Insere o QR como um nó vetorial: um path só, com um subpath por corrida de
 * módulos. Nada de milhares de retângulos — assim o código escala sem perder
 * definição e sai vetorial no PDF.
 *
 * As duas cores já entram marcadas: o desenho em preto 100% e o fundo em papel
 * (0/0/0/0), para a exportação não separar o preto em quatro tintas.
 */
function insertQr(msg) {
  var lado = msg.size;                              // em unidades do Figma (1 = 1pt)

  var frame = figma.createFrame();
  frame.name = 'QR ' + msg.label;
  frame.resize(lado, lado);
  frame.fills = [{ type: 'SOLID', color: rgbToFigma(msg.paperRgb) }];
  frame.setPluginData(CMYK_KEY, JSON.stringify({ cmyk: [0, 0, 0, 0], rgb: msg.paperRgb }));
  frame.clipsContent = false;
  frame.constrainProportions = true;

  var vetor = figma.createVector();
  vetor.name = 'QR (preto 100%)';
  vetor.vectorPaths = [{ windingRule: 'NONZERO', data: msg.path }];
  vetor.fills = [{ type: 'SOLID', color: rgbToFigma(msg.inkRgb) }];
  vetor.strokes = [];
  vetor.setPluginData(CMYK_KEY, JSON.stringify({ cmyk: [0, 0, 0, 1], rgb: msg.inkRgb }));

  frame.appendChild(vetor);
  vetor.x = 0;
  vetor.y = 0;
  vetor.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };

  var centro = figma.viewport.center;
  frame.x = Math.round(centro.x - lado / 2);
  frame.y = Math.round(centro.y - lado / 2);

  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.notify('QR code inserido: ' + msg.label);
  sendSelection();
}

function rgbToFigma(rgb) {
  return { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
}

/** Junta as cores exatas do nó e de tudo que está dentro dele. */
function collectOverrides(node) {
  var found = [];
  var seen = {};

  function visit(n) {
    var exact = readExactCmyk(n);
    if (!exact) return;
    var key = exact.rgb.join(',');
    if (seen[key]) return;
    seen[key] = 1;
    found.push(exact);
  }

  visit(node);
  if ('findAll' in node) node.findAll(function (child) { visit(child); return false; });
  return found;
}

// ---------------------------------------------------------------- exportação

/**
 * Largura final em pixels de um nó, conforme o modo escolhido na UI.
 * Fica aqui, e não na UI, para que os dois lados nunca discordem.
 *
 * physical: mantém o tamanho físico, multiplicando pelo dpi/72 do Figma
 * native:   usa os pixels do próprio nó, só marcando o DPI no arquivo
 * width:    largura fixa informada pelo usuário
 */
function targetWidthFor(node, msg) {
  if (msg.sizeMode === 'width') return Math.round(msg.customWidth || node.width);
  if (msg.sizeMode === 'native') return Math.round(node.width);
  return Math.round(node.width * (msg.dpi || 300) / FIGMA_DPI);
}

/**
 * Exporta cada nó pedido em PNG já no número de pixels final.
 * Usa constraint WIDTH em vez de SCALE porque scale é limitado a 4x e
 * 300 DPI exige 4,1667x.
 */
function exportNodes(msg) {
  var ids = msg.ids || [];

  return ids.reduce(function (chain, id) {
    return chain.then(function () {
      return figma.getNodeByIdAsync(id).then(function (node) {
        if (!node) throw new Error('Nó ' + id + ' não existe mais na página.');

        var targetWidth = targetWidthFor(node, msg);
        var targetHeight = Math.round(targetWidth * node.height / node.width);

        if (targetWidth < 1 || targetHeight < 1) {
          throw new Error('Dimensão calculada inválida para "' + node.name + '".');
        }
        // A UI já barra isso, mas exportar 380 MP trava o Figma antes de chegar lá.
        if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
          throw new Error('"' + node.name + '" ficaria em ' + targetWidth + '×' + targetHeight +
            ' px, acima do limite de ' + MAX_DIMENSION + ' px por lado.');
        }

        figma.ui.postMessage({
          type: 'progress', id: id, name: node.name,
          phase: 'export', pixels: targetWidth + '×' + targetHeight
        });

        return node.exportAsync({
          format: 'PNG',
          constraint: { type: 'WIDTH', value: targetWidth }
        }).then(function (bytes) {
          figma.ui.postMessage({
            type: 'image',
            id: id,
            name: node.name,
            bytes: bytes,
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            dpi: msg.dpi,
            overrides: collectOverrides(node)
          });
        }, function (err) {
          throw new Error('Falha ao exportar "' + node.name + '" em ' +
            targetWidth + '×' + targetHeight + 'px: ' + (err && err.message || err));
        });
      });
    });
  }, Promise.resolve()).then(function () {
    figma.ui.postMessage({ type: 'export-done' });
  });
}
