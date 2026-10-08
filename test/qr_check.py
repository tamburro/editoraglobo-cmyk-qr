"""Confere o gerador de QR do plugin contra implementações de referência.

Três provas:
  1. a tabela de blocos (versão × nível) precisa bater com o segno nas 160
     combinações — um erro ali produziria código inválido numa versão rara;
  2. a função de penalidade precisa dar a mesma nota que a do pacote `qrcode`
     nas 8 máscaras, que é o que decide qual máscara é escolhida;
  3. cada código gerado precisa ser lido de volta pelo detector do OpenCV,
     em todos os níveis e numa faixa larga de versões.

Nota: as três implementações escolhem máscaras diferentes em alguns casos,
porque divergem sobre avaliar o símbolo com ou sem os bits de formato. A norma
manda avaliar o símbolo completo, que é o que este gerador faz. Por isso a
comparação módulo a módulo com uma biblioteca específica não é usada como
critério — o critério é o código ser lido.

Uso:
    python test/qr_check.py
"""
import json
import os
import random
import subprocess
import sys

import cv2
import numpy as np
import qrcode.util as qrutil
import segno
from segno import consts as segno_consts

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

NIVEIS = ["L", "M", "Q", "H"]
NIVEL_SEGNO = {
    "L": segno_consts.ERROR_LEVEL_L,
    "M": segno_consts.ERROR_LEVEL_M,
    "Q": segno_consts.ERROR_LEVEL_Q,
    "H": segno_consts.ERROR_LEVEL_H,
}

falhas = 0


def check(nome, ok, extra=""):
    global falhas
    if not ok:
        falhas += 1
    print(f"  {'ok  ' if ok else 'FALHA'} {nome}" + (f" — {extra}" if extra else ""))


def node(script, **env_extra):
    env = dict(os.environ, **env_extra)
    saida = subprocess.run(
        ["node", "-e", script], cwd=ROOT, capture_output=True,
        text=True, encoding="utf-8", env=env, check=True
    )
    return json.loads(saida.stdout)


# ------------------------------------------------------- 1. tabela de blocos

print("Tabela de blocos (versão × nível)")
CAPACIDADE = """
const {QR}=require("./lib/qr.js");
const out={};
for (const nivel of ["L","M","Q","H"]) {
  out[nivel]=[];
  for (let v=1; v<=40; v++) out[nivel].push(QR._internals.capacity(v, nivel));
}
console.log(JSON.stringify(out));
"""
meu_cap = node(CAPACIDADE)
divergencias = []
for nivel in NIVEIS:
    for versao in range(1, 41):
        ref = segno_consts.SYMBOL_CAPACITY[versao][NIVEL_SEGNO[nivel]]
        meu = meu_cap[nivel][versao - 1]["data"] * 8
        if ref != meu:
            divergencias.append(f"{nivel}v{versao}: {meu} vs {ref}")
check("as 160 combinações batem com o segno", not divergencias,
      "; ".join(divergencias[:5]))


# ---------------------------------------------------------- 2. penalidade

print("Escolha da máscara")
PENALIDADES = """
const {QR}=require("./lib/qr.js");
const out=[];
for (let m=0;m<8;m++){
  const qr=QR.encode(process.env.QR_TEXT,{level:process.env.QR_LEVEL,forceMask:m});
  out.push({mask:m, score:QR._internals.penalty(qr.modules), modules:qr.modules});
}
console.log(JSON.stringify(out));
"""
for texto, nivel in [("x", "H"), ("https://clubeoglobo.com.br", "M")]:
    cands = node(PENALIDADES, QR_TEXT=texto, QR_LEVEL=nivel)
    iguais = all(
        c["score"] == qrutil.lost_point([[bool(v) for v in row] for row in c["modules"]])
        for c in cands
    )
    check(f'penalidade igual à referência nas 8 máscaras ({texto[:24]})', iguais)

    escolhida = node(
        'const {QR}=require("./lib/qr.js");'
        'const qr=QR.encode(process.env.QR_TEXT,{level:process.env.QR_LEVEL});'
        'console.log(JSON.stringify({mask:qr.mask}));',
        QR_TEXT=texto, QR_LEVEL=nivel
    )["mask"]
    melhor = min(cands, key=lambda c: c["score"])["mask"]
    check(f'escolhe a máscara de menor penalidade ({texto[:24]})', escolhida == melhor,
          f"escolhida {escolhida}, melhor {melhor}")


# ------------------------------------------------------- 3. leitura de volta

def desenhar(modules, escala=6, quiet=4):
    lado = len(modules)
    total = (lado + quiet * 2) * escala
    img = np.full((total, total), 255, dtype=np.uint8)
    for y, linha in enumerate(modules):
        for x, v in enumerate(linha):
            if v:
                img[(y + quiet) * escala:(y + quiet + 1) * escala,
                    (x + quiet) * escala:(x + quiet + 1) * escala] = 0
    return img


GERAR = """
const {QR}=require("./lib/qr.js");
const qr=QR.encode(process.env.QR_TEXT,{level:process.env.QR_LEVEL});
console.log(JSON.stringify({version:qr.version,size:qr.size,mask:qr.mask,modules:qr.modules}));
"""

print("Leitura de volta (OpenCV)")
detector = cv2.QRCodeDetector()
random.seed(20240818)

ALFABETO = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&'()*+,;=%"
casos = [
    ("https://clubeoglobo.com.br", "M"),
    ("https://clubeoglobo.com.br/promocao/meia-pagina-top-10?utm_source=jornal", "Q"),
    ("http://a.bc", "L"),
    ("Acentuação, ç e emoji 😀", "M"),
    ("x", "H"),
]
# links de tamanhos variados, para varrer versões baixas, médias e altas
for tamanho in (30, 80, 150, 300, 600, 1000):
    for nivel in NIVEIS:
        corpo = "".join(random.choice(ALFABETO) for _ in range(tamanho))
        casos.append(("https://clubeoglobo.com.br/" + corpo, nivel))

versoes = set()
falhas_leitura = []
detector_cego = []
for texto, nivel in casos:
    qr = node(GERAR, QR_TEXT=texto, QR_LEVEL=nivel)
    versoes.add(qr["version"])
    lido, *_ = detector.detectAndDecode(desenhar(qr["modules"]))
    if lido == texto:
        continue

    # O detector do OpenCV falha sozinho em versões muito altas. Só é defeito do
    # gerador se o código do segno, no mesmo caso, for lido.
    ref = segno.make(texto, error=nivel, mode="byte", micro=False, boost_error=False)
    ref_modules = [[int(v) for v in linha] for linha in ref.matrix]
    ref_lido, *_ = detector.detectAndDecode(desenhar(ref_modules))
    if ref_lido == texto:
        falhas_leitura.append(f'[{nivel}] v{qr["version"]}: o meu não foi lido, o do segno sim')
    else:
        detector_cego.append(f'[{nivel}] v{qr["version"]}')

check(f"{len(casos)} códigos gerados e lidos de volta", not falhas_leitura,
      "; ".join(falhas_leitura[:4]))
print(f"        versões exercitadas: {min(versoes)} a {max(versoes)}")
if detector_cego:
    print(f"        {len(detector_cego)} caso(s) que nem a referência decodifica "
          f"(limite do OpenCV): {', '.join(detector_cego)}")


# ----------------------------------------------------------- 4. path vetorial

print("Path vetorial")
PATH = """
const {QR}=require("./lib/qr.js");
const qr=QR.encode("https://clubeoglobo.com.br",{level:"M"});
const d=QR.toPath(qr, 4, 4);
console.log(JSON.stringify({
  size: qr.size,
  total: QR.totalSize(qr, 4, 4),
  subpaths: (d.match(/M/g)||[]).length,
  escuros: qr.modules.flat().filter(Boolean).length,
  amostra: d.slice(0, 60)
}));
"""
p = node(PATH)
check("um subpath por corrida de módulos, não por módulo",
      0 < p["subpaths"] < p["escuros"],
      f'{p["subpaths"]} subpaths para {p["escuros"]} módulos escuros')
check("tamanho total inclui as duas margens",
      p["total"] == (p["size"] + 8) * 4, f'{p["total"]}')
check("path começa com um comando de movimento", p["amostra"].startswith("M"))

print()
if falhas:
    print(f"{falhas} verificação(ões) falharam.")
    sys.exit(1)
print("QR conferido: tabelas, máscara e leitura.")
