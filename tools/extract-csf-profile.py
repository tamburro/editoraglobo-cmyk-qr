"""Tira os perfis ICC de dentro de um .csf (Color Settings do Photoshop).

As configurações de cor do Photoshop carregam os perfis inteiros embutidos —
inclusive perfis CMYK feitos sob medida, que não existem como arquivo solto em
lugar nenhum. Este script extrai cada um para um .icc que o plugin consegue usar.

Uso:
    python tools/extract-csf-profile.py "Photoshop Papel Jornal.csf" profiles/
"""
import os
import re
import sys


def read_description(raw, start):
    """Lê a tag 'desc' do perfil que começa em `start`."""
    ntags = int.from_bytes(raw[start + 128:start + 132], "big")
    for i in range(min(ntags, 128)):
        o = start + 132 + i * 12
        if raw[o:o + 4] != b"desc":
            continue
        off = start + int.from_bytes(raw[o + 4:o + 8], "big")
        length = int.from_bytes(raw[off + 8:off + 12], "big")
        return raw[off + 12:off + 12 + length - 1].decode("latin-1", "ignore")
    return ""


def slug(name):
    return re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9]+", "-", name)).strip("-")


def extract(path, outdir, spaces=("CMYK",)):
    raw = open(path, "rb").read()
    os.makedirs(outdir, exist_ok=True)
    found = []

    for m in re.finditer(b"acsp", raw):
        start = m.start() - 36                       # 'acsp' fica no byte 36 do cabeçalho
        if start < 0:
            continue
        size = int.from_bytes(raw[start:start + 4], "big")
        if not (1024 < size < 8_000_000) or start + size > len(raw):
            continue
        space = raw[start + 16:start + 20].decode("latin-1").strip()
        if space not in spaces:
            continue

        name = read_description(raw, start) or f"perfil-{len(found)}"
        target = os.path.join(outdir, slug(name) + ".icc")
        with open(target, "wb") as fh:
            fh.write(raw[start:start + size])
        found.append((name, space, size, target))

    return found


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    source = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "profiles"

    results = extract(source, outdir)
    if not results:
        print("Nenhum perfil CMYK encontrado em " + source)
        sys.exit(1)
    for name, space, size, target in results:
        print(f"{space}  {size // 1024:5} KB  {name}\n       -> {target}")
