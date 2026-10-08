"""Confronta a conversão ICC do plugin com o littleCMS (via Pillow/ImageCms).

Uso:
    node test/test.js <perfil.icc>          # gera test/samples.json
    python test/compare_lcms.py <perfil.icc>

Também valida os TIFFs gravados por test.js abrindo-os com o Pillow.
"""
import json
import os
import sys

from PIL import Image, ImageCms

HERE = os.path.dirname(os.path.abspath(__file__))


def compare_conversion(profile_path, intent):
    with open(os.path.join(HERE, "samples.json"), encoding="utf-8") as fh:
        samples = json.load(fh)

    srgb = ImageCms.createProfile("sRGB")
    cmyk = ImageCms.getOpenProfile(profile_path)
    transform = ImageCms.buildTransform(srgb, cmyk, "RGB", "CMYK", renderingIntent=intent)

    src = Image.new("RGB", (len(samples), 1))
    src.putdata([tuple(round(c * 255) for c in s["rgb"]) for s in samples])
    ref = list(ImageCms.applyTransform(src, transform).getdata())

    diffs = []
    for sample, expected in zip(samples, ref):
        got = [round(c * 255) for c in sample["cmyk"]]
        diffs.append(max(abs(g - e) for g, e in zip(got, expected)))

    diffs.sort()
    worst = diffs[-1]
    p95 = diffs[int(len(diffs) * 0.95) - 1]
    mean = sum(diffs) / len(diffs)
    print(f"  amostras: {len(diffs)}")
    print(f"  erro medio  : {mean:5.1f}/255  ({mean / 255 * 100:.1f}%)")
    print(f"  erro p95    : {p95:5.1f}/255  ({p95 / 255 * 100:.1f}%)")
    print(f"  erro maximo : {worst:5.1f}/255  ({worst / 255 * 100:.1f}%)")
    return mean, worst


def check_tiffs():
    for name in ("out-none.tif", "out-packbits.tif"):
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            print(f"  {name}: ausente (rode node test/test.js antes)")
            continue
        with Image.open(path) as im:
            dpi = im.info.get("dpi")
            icc = im.info.get("icc_profile")
            px = im.getpixel((3, 2))
            print(f"  {name}: mode={im.mode} size={im.size} dpi={dpi} "
                  f"icc={len(icc) if icc else 0}B pixel(3,2)={px}")
            assert im.mode == "CMYK", f"{name} nao abriu como CMYK"
            assert dpi and round(dpi[0]) == 300, f"{name} sem 300 dpi"


def check_pdfx():
    """Confere o PDF/X gerado por test.js com o pikepdf (se instalado)."""
    path = os.path.join(HERE, "out-pdfx.pdf")
    if not os.path.exists(path):
        print("  out-pdfx.pdf ausente (rode node test/test.js com um perfil)")
        return
    try:
        import pikepdf
    except ImportError:
        print("  pikepdf nao instalado: pule com `pip install pikepdf`")
        return
    with pikepdf.open(path) as pdf:
        page = pdf.pages[0]
        intent = pdf.Root.OutputIntents[0]
        img = page.Resources.XObject.Im0
        print(f"  versao {pdf.pdf_version} | paginas {len(pdf.pages)}")
        print(f"  MediaBox {list(page.MediaBox)} | TrimBox {list(page.TrimBox)}")
        print(f"  OutputIntent {intent.S} -> {intent.OutputConditionIdentifier}")
        print(f"  perfil N={int(intent.DestOutputProfile.N)} "
              f"({len(intent.DestOutputProfile.read_bytes())} bytes)")
        print(f"  imagem {int(img.Width)}x{int(img.Height)} {img.ColorSpace} "
              f"{int(img.BitsPerComponent)}bpc {img.Filter}")
        assert pdf.pdf_version == "1.3"
        assert str(img.ColorSpace) == "/DeviceCMYK"
        assert int(intent.DestOutputProfile.N) == 4
        assert str(pdf.docinfo["/GTS_PDFXConformance"]) == "PDF/X-1a:2001"
    print("  PDF/X-1a: estrutura valida")


if __name__ == "__main__":
    profile = sys.argv[1] if len(sys.argv) > 1 else None
    print("TIFFs gravados pelo plugin, lidos pelo Pillow:")
    check_tiffs()
    print("\nPDF/X gravado pelo plugin, lido pelo pikepdf:")
    check_pdfx()
    if profile:
        # 1 = colorimetrico relativo, igual ao usado em test.js
        print("\nConversao ICC vs littleCMS (intent relativo):")
        compare_conversion(profile, 1)
