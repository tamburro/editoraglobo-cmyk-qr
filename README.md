# editoraglobo-cmyk-qr

Plugin do Figma da Editora Globo para fechar material impresso. Fecha arquivos a
partir do Figma: exporta em **TIFF CMYK** ou
**PDF/X-1a:2001** a 300 DPI, com conversão por perfil ICC de verdade (US Newsprint
SNAP 2007, Coated FOGRA39, GRACoL…), perfil embutido e cores CMYK exatas por
objeto.

## Instalação

1. No Figma desktop: **Menu → Plugins → Development → Import plugin from manifest…**
2. Aponte para o `manifest.json` desta pasta.
3. O plugin aparece em **Plugins → Development → editoraglobo-cmyk-qr**.

## Uso

1. Selecione o frame (ou vários) no canvas e rode o plugin.
2. Escolha o DPI e o modo de tamanho:
   - **Manter tamanho físico** — multiplica por DPI/72. Um frame de 842×737 pt
     vira 3508×3071 px: o mesmo 297×260 mm, agora a 300 DPI. Use quando o frame
     foi desenhado em medidas reais.
   - **Pixels do Figma (1:1)** — não reamostra nada, só marca o DPI no arquivo.
     Use quando o frame já foi montado em alta (ex.: 5000×4376 px, que a 300 DPI
     dá 423×370 mm).
   - **Largura fixa** — você digita a largura em pixels.
3. Carregue o **perfil ICC** de saída (veja abaixo). Sem perfil, o plugin usa uma
   fórmula RGB→CMYK com GCR e limite de tinta ajustáveis — serve para rascunho,
   não para produção.
4. Escolha o **formato**: TIFF CMYK ou PDF/X-1a:2001.
5. **Converter e baixar**.

A lista de camadas mostra a miniatura de cada seleção, o tamanho e, quando
houver, a tinta exata marcada no objeto.

## Preset da editora: PDF pronto para impressão

Não há preset a escolher: o plugin abre já no fechamento da casa — PDF/X-1a,
300 DPI, intenção colorimétrica relativa, separação e OutputIntent nos perfis
certos. Selecionar a arte e clicar em **Fechar arquivo em PDF/X-1a** basta.

As opções abaixo continuam editáveis para uma exceção pontual, e o painel avisa
quando alguma delas sai do padrão (DPI menor, formato trocado, outro perfil). Se
faltar perfil, o botão barra a exportação.

### Os dois papéis do perfil

O plugin trata separadamente duas coisas que costumam ser confundidas:

| Perfil | O que faz |
| --- | --- |
| **Separação** | converte os pixels de RGB para CMYK. É ele que decide quanta tinta cada ponto recebe, e é ele que vai embutido no TIFF. |
| **OutputIntent** | só é declarado no PDF/X: diz em que condição de impressão aquele arquivo deve ser impresso. Não altera pixel nenhum. |

O preset da Editora Globo usa **perfis diferentes nos dois papéis**, seguindo o
que o fluxo da casa já fazia:

- **separação**: `SWOP (Jornal), 30%, GCR, Carregado`, extraído de
  `Photoshop Papel Jornal.csf` — é o perfil com que as imagens sempre foram
  fechadas no Photoshop;
- **OutputIntent**: `US Newsprint (SNAP 2007)`, que é o que o
  `.joboptions` do InDesign declara.

Vale saber o que isso significa: o PDF declara uma condição de impressão
diferente da que gerou as tintas. É prática corrente quando a imagem vem do
Photoshop e o PDF sai do InDesign, e um preflight rigoroso não reclama disso
(ele confere que existe OutputIntent, não que ele foi usado na separação). Para
mudar isso, os dois perfis estão declarados em `lib/preset.js`.

A diferença entre os dois perfis não é pequena:

| | preto chapado | tom de pele | azul escuro |
| --- | --- | --- | --- |
| SWOP (Jornal) da casa | 49/39/40/**92** | 11/33/**36**/4 | 100/79/8/**4** |
| US Newsprint SNAP 2007 | 51/44/45/**75** | 10/42/**64**/3 | 76/57/24/**58** |

### Embutir o perfil no plugin

Perfis ICC têm licença própria. Neste repositório, que é interno, os perfis da
casa estão versionados para o plugin funcionar assim que alguém clonar — se um
dia este código for publicado fora da Editora Globo, apague `profiles/` e
`lib/profile-embedded.js` antes, e cada equipe embute o seu:

```bash
node tools/embed-profile.js profiles/SWOP-Jornal-30-GCR.icc \
  "C:/Windows/System32/spool/drivers/color/USNewsprintSNAP2007.icc"
node build.js
```

O `ui.html` cresce cerca de 1,8 MB com os dois perfis, e o preset passa a
funcionar sem pedir arquivo nenhum. Para desfazer, apague
`lib/profile-embedded.js` e rode `node build.js` de novo.

O perfil da casa sai de dentro do próprio arquivo de configurações de cor do
Photoshop:

```bash
python tools/extract-csf-profile.py "Photoshop Papel Jornal.csf" profiles/
```

Sem perfis embutidos, o plugin lembra os `.icc` que você carregar — guardados por
máquina em `clientStorage`, não dentro do arquivo do Figma —, então o incômodo é
só na primeira vez.

### O que o preset reproduz

O formato **PDF/X-1a** reproduz o que o preset
`Adobe InDesign PDF Preset Editora Globo.joboptions` pede:

| Preset | O que o plugin gera |
| --- | --- |
| `PDFX1a:2001`, `CompatibilityLevel 1.3` | PDF 1.3 com `GTS_PDFXVersion`/`GTS_PDFXConformance` no Info e no XMP |
| `ColorConversionStrategy /CMYK` | imagem `DeviceCMYK`, 8 bits por canal |
| `PDFXOutputIntentProfile (US Newsprint (SNAP 2007))` | OutputIntent `GTS_PDFX` com esse perfil embutido |
| `DownsampleColorImages false`, `ColorImageResolution 300` | pixels na resolução escolhida, sem reamostragem |
| `PDFXSetBleedBoxToMediaBox true`, offsets zerados | `TrimBox` = `BleedBox` = `MediaBox` |
| `PDFXTrapped /False` | `/Trapped /False` |
| `DefaultRenderingIntent /Default` | colorimétrica relativa, o padrão da Adobe em impressão |

A página sai exatamente do tamanho físico da imagem (pixels ÷ DPI × 72 pt), sem
fontes e sem transparência — o conteúdo é a arte rasterizada, que é o que o
PDF/X-1a espera.

Uma diferença consciente: o preset recomprime imagens com **DCTEncode** (JPEG) e
aqui a imagem vai em **FlateDecode**, que é sem perda e igualmente válido em
PDF 1.3 e PDF/X-1a. O arquivo fica maior; a imagem não perde nada.

O PDF/X exige o perfil: sem `.icc` carregado, o botão avisa em vez de gerar um
arquivo fora da norma.

## Cor do objeto

Clique num objeto da arte e o painel **Cor do objeto** já mostra a cor dele em
CMYK — a tinta marcada, se houver, ou a conversão do preenchimento atual pelo
perfil de separação —, junto com a soma de tinta.

A partir daí:

- **clique numa tinta da paleta** para trocar na hora (branco, preto de texto,
  preto reforçado, cinzas, as quatro tintas puras e as combinações correntes);
- ou **digite C, M, Y e K** e clique em **Aplicar**;
- **Soltar a cor** devolve o objeto à conversão normal.

Todas as tintas da paleta cabem no limite de 240% que o papel jornal segura, e o
contador de tinta fica em laranja se você digitar algo acima disso.

Serve para quando a cor **não pode** ser resultado de conversão: o preto chapado
da manchete, o azul da marca, um fundo que tem de sair em 100% de ciano.

O objeto passa a mostrar na tela a simulação daquela tinta pelo perfil de
separação (via tabela A2B do ICC), e o valor CMYK fica guardado no arquivo, em
`pluginData` — sobrevive a fechar o plugin e viaja junto com o `.fig`.

Na exportação, os pixels que tiverem exatamente aquele RGB saem com a tinta
digitada, sem passar pela conversão. As bordas antisserrilhadas seguem
convertidas normalmente, como tem de ser. O rodapé informa quanto da área saiu
com cor exata.

### Qual perfil usar

O perfil precisa ser CMYK e ter tabela B2A (todo perfil de saída tem). No Windows
eles ficam em `C:\Windows\System32\spool\drivers\color\`:

| Uso | Arquivo |
| --- | --- |
| Jornal (SNAP 2007) | `USNewsprintSNAP2007.icc` |
| Offset revista/couché europeu | `CoatedFOGRA39.icc` |
| Offset couché americano | `CoatedGRACoL2006.icc` |
| Japan Color | `JapanColor2001Coated.icc` |

Cada perfil traz seu próprio limite de tinta: em preto chapado, SNAP 2007 sai em
220% e FOGRA39 em 348%.

O preset do InDesign que está nesta pasta (`Adobe InDesign PDF Preset Editora
Globo.joboptions`) declara **US Newsprint (SNAP 2007)** como perfil de destino —
é esse que casa com o fluxo de impressão do material do Clube O Globo. Com ele,
preto chapado sai em 220% de tinta total; com FOGRA39 sairia em 348%, o que
borraria em papel jornal.

O perfil escolhido é gravado dentro do TIFF (tag ICCProfile), então Photoshop e
InDesign abrem o arquivo já sabendo em que espaço ele está — sem "Missing
Profile", sem reconversão.

## QR code

O painel **QR code** gera o código a partir do link e insere na arte:

1. cole o link;
2. escolha a correção de erro (M serve para quase tudo; Q e H aguentam mais
   sujeira e desgaste, ao custo de um código maior);
3. defina o tamanho impresso em mm;
4. **Inserir QR code**.

O código entra **como vetor** — um único nó com um path, um subpath por corrida
de módulos, não um retângulo por módulo. Escala sem perder definição e sai
vetorial no PDF.

Já entra com as duas cores marcadas: o desenho em **preto 100%** (0/0/0/100) e o
fundo em papel (0/0/0/0), pelo mesmo mecanismo de cor exata do resto do plugin.
Ou seja, o preto do QR não é separado em quatro tintas — vai só na chapa do
preto, que é o que garante o registro e a leitura.

A margem obrigatória de 4 módulos entra junto, e o painel avisa quando o módulo
fica abaixo de 0,6 mm — o ponto em que a tinta fecha o desenho no papel jornal e
o leitor começa a errar. O aviso já diz de quantos milímetros o código precisa
para chegar lá.

O path usa só os comandos `M`, `L` e `Z`: o parser de `vectorPaths` do Figma
recusa as formas abreviadas `h` e `v`, e falha o nó inteiro com
"Invalid command".

O gerador é próprio (`lib/qr.js`), porque o iframe do plugin não acessa a rede:
não dá para puxar biblioteca de CDN nem chamar API. Cobre modo byte (UTF-8),
versões 1 a 40 e os quatro níveis de correção.

## Por que TIFF e não PNG/JPG

O `exportAsync` do Figma só devolve RGB (PNG, JPG, SVG, PDF). Não existe API de
CMYK. O plugin então exporta PNG na resolução final, converte os pixels e grava o
TIFF na mão: baseline, little-endian, `PhotometricInterpretation = 5 (Separated)`,
4 canais de 8 bits, `InkSet = CMYK`, `XResolution/YResolution = DPI` com
`ResolutionUnit = polegada`.

## Como os 300 DPI são obtidos

O Figma trata 1 px de canvas como 1 pt, ou seja, 72 DPI. Para "300 DPI" mantendo
o tamanho físico, a exportação precisa de `300 / 72 = 4,1667×` mais pixels. Como o
parâmetro `scale` do Figma é limitado a 4×, o plugin usa
`constraint: { type: 'WIDTH', value: <pixels> }`, que não tem esse teto.

O DPI gravado no TIFF é o que faz o InDesign colocar a imagem no tamanho físico
certo ao importar.

## Compressão

- **Deflate (padrão)** — sem perda, lida bem com dados CMYK intercalados. Lido por
  Photoshop, InDesign, Illustrator e qualquer RIP moderno.
- **Nenhuma** — máxima compatibilidade com softwares antigos; arquivo grande
  (largura × altura × 4 bytes).
- **PackBits** — só faz sentido em arte muito chapada. Em CMYK intercalado ele
  frequentemente *aumenta* o arquivo, porque o padrão `0,0,0,K` quebra o
  algoritmo. Está aí por compatibilidade.

## Estrutura

```
manifest.json        declaração do plugin
code.js              thread principal: lê a seleção e exporta PNG na resolução final
ui.template.html     fonte da UI (edite este)
ui.html              gerado por build.js — é o que o Figma carrega
build.js             embute lib/*.js no HTML (o Figma exige UI em arquivo único)
lib/color.js         sRGB → Lab/XYZ D50, fórmula RGB→CMYK, LUT 3D
lib/icc.js           leitor de ICC: tabelas B2A (mft1/mft2/mAB), curvas, CLUT
lib/tiff.js          gravador de TIFF CMYK + PackBits + Deflate
lib/pdfx.js          gravador de PDF/X-1a:2001 com OutputIntent
lib/preset.js        presets de fechamento (o .joboptions traduzido) e sua conferência
lib/qr.js            gerador de QR Code (ISO/IEC 18004), saída em path vetorial
tools/embed-profile.js     assa perfis ICC dentro do plugin
tools/extract-csf-profile.py  tira o perfil CMYK de um .csf do Photoshop
profiles/            perfis extraídos (não versionados: cada equipe tem os seus)
test/test.js         suíte em node
test/compare_lcms.py confronto com littleCMS e leitura dos TIFFs pelo Pillow
test/harness.html    roda a UI real num browser, simulando o lado do Figma
```

Depois de mexer em `ui.template.html` ou em `lib/`, rode:

```bash
node build.js
```

## Testes

```bash
node test/test.js "C:/Windows/System32/spool/drivers/color/USNewsprintSNAP2007.icc"
```

Cobre PackBits, Deflate, a estrutura do TIFF, a estrutura do PDF/X (incluindo os
offsets da tabela xref), os presets e sua validação, as cores exatas, a fórmula
sem perfil e a leitura da tabela B2A do perfil informado. A amostragem é feita
com semente fixa: um teste que sorteia entrada não pode falhar por azar.

Para confrontar a conversão com o littleCMS (o motor do Photoshop) e abrir os
TIFFs gerados com o Pillow:

```bash
python test/compare_lcms.py "C:/Windows/System32/spool/drivers/color/CoatedFOGRA39.icc"
```

Isso também abre o PDF/X gerado com o pikepdf e confere OutputIntent, boxes e
espaço de cor.

O QR tem uma verificação à parte, que precisa de bibliotecas de referência:

```bash
pip install segno qrcode opencv-python-headless numpy
python test/qr_check.py
```

Ela confere três coisas: a tabela de blocos nas 160 combinações de versão e
nível contra o segno; a função de penalidade contra a do pacote `qrcode` nas 8
máscaras; e a leitura de volta de 29 códigos, das versões 1 a 36, pelo detector
do OpenCV.

Sobre a máscara: as implementações divergem em alguns casos porque não
concordam se o símbolo deve ser avaliado com ou sem os bits de formato. A norma
manda avaliar o símbolo completo, que é o que este gerador faz — por isso o
critério do teste é o código ser lido, não bater módulo a módulo com uma
biblioteca específica.

Nas últimas medições: contra o Coated FOGRA39, erro médio de 0,3% e máximo de
1,2% (3 níveis em 255) nas três intenções; contra o US Newsprint (SNAP 2007),
médio de 0,5% e máximo de 3,1%, porque a grade desse perfil é mais grossa perto
das bordas de gamut.

Para exercitar a UI fora do Figma, sirva a pasta e abra `test/harness.html`:

```bash
python -m http.server 8731
```

O harness simula o `code.js`, gera uma imagem de teste, intercepta o download e
inspeciona os bytes do TIFF resultante.

## Limites conhecidos

- **Transparência**: TIFF CMYK não carrega alfa aqui. Pixels transparentes são
  compostos sobre o fundo escolhido (branco por padrão).
- **Sem gerenciamento na entrada**: o conteúdo do Figma é tratado como sRGB, que
  é o espaço de trabalho do Figma.
- **Perfil não persiste** entre execuções do plugin — recarregue o `.icc` a cada
  sessão. As cores exatas dos objetos, essas sim, ficam salvas no arquivo.
- **Cor exata é por RGB**: se dois objetos diferentes tiverem exatamente a mesma
  cor de preenchimento e só um tiver tinta marcada, os dois saem com a tinta
  marcada. Diferencie a cor de um deles em um nível de RGB para separá-los.
- **Teto de tamanho**: 16384 px por lado (limite de canvas do browser) e 100 MP
  no total. Acima disso o plugin bloqueia o botão e diz o que fazer, em vez de
  gerar arquivo inválido.

  Isso pega quem combina um frame já montado em alta com **Manter tamanho
  físico**: 5000 px × 300/72 daria 20833 px e não caberia. Nesse caso o modo
  certo é **Pixels do Figma (1:1)**.
