"""논문 첫 페이지 이미지 만들기.

index.html 과 content/pubs.json 에 있는 논문 DOI마다, 인터넷에 공개된(오픈 액세스) PDF가 있으면
내려받아 첫 페이지를 images/papers/<doi>.webp 로 저장하고 data/pub-pages.json 에 기록합니다.
공개 PDF가 없는 논문(구독 저널 등)은 건너뜁니다. 그런 논문은 관리 화면에서 PDF를 올리면 첫 페이지가 만들어집니다.
GitHub Actions(.github/workflows/paper-pages.yml)가 논문 목록이 바뀔 때와 매주 실행합니다.
"""
import io, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "images" / "papers"
MAP = ROOT / "data" / "pub-pages.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
WIDTH = 1000


def dois():
    found = set()
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    m = re.search(r"\n  pubs: \[(.*?)\n  \],", html, re.S)
    if m:
        found.update(re.findall(r'"(10\.\d{4,9}/[^"\s]+)"', m.group(1)))
    cj = ROOT / "content" / "pubs.json"
    if cj.exists():
        for p in json.loads(cj.read_text(encoding="utf-8")):
            if str(p.get("doi", "")).startswith("10."):
                found.add(p["doi"].strip())
    return sorted(found)


def get(url, accept="*/*", timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def candidates(doi):
    urls = []
    try:
        data, _ = get("https://api.openalex.org/works/doi:" + urllib.parse.quote(doi, safe="/"), "application/json")
        w = json.loads(data)
        locs = [w.get("best_oa_location") or {}] + (w.get("locations") or [])
        for loc in locs:
            if loc and loc.get("pdf_url"):
                urls.append(loc["pdf_url"])
    except Exception as e:  # noqa: BLE001
        print(f"  openalex 실패: {e}")
    if doi.startswith("10.1088/"):  # IOP (J. Phys. Conf. Ser.) 는 모두 공개
        urls.append(f"https://iopscience.iop.org/article/{doi}/pdf")
    if doi.startswith("10.26868/"):  # IBPSA Building Simulation 학회 논문집
        urls.append(f"https://publications.ibpsa.org/proceedings/{doi.split('/')[-1]}")
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def abstract_page(doc):
    """표지로 쓸 쪽: 앞 5쪽 중 초록(Abstract)이 시작하는 쪽. IOP 등 첫 쪽이 안내·광고인 경우를 건너뜀."""
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from paper_abstracts import from_blocks, page_blocks
        for i in range(min(5, len(doc))):
            if from_blocks(page_blocks(doc, i))[0]:
                return i
    except Exception as e:  # noqa: BLE001
        print(f"  초록 쪽 찾기 실패: {e}")
    return 0


def render(pdf_bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[abstract_page(doc)]
    zoom = WIDTH / page.rect.width
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=82, method=6)
    return buf.getvalue()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pages = json.loads(MAP.read_text(encoding="utf-8")) if MAP.exists() else {}
    changed = False
    for doi in dois():
        rel = f"images/papers/{re.sub(r'[^A-Za-z0-9._-]+', '_', doi)}-a.webp"   # -a: 초록 쪽 기준(2026-11-27부터)
        if pages.get(doi) == rel and (ROOT / rel).exists():
            continue
        print(doi)
        for url in candidates(doi):
            try:
                data, ctype = get(url, "application/pdf")
            except Exception as e:  # noqa: BLE001
                print(f"  {url} -> {e}")
                continue
            if not data.startswith(b"%PDF"):
                print(f"  {url} -> PDF 아님 ({ctype})")
                continue
            try:
                (ROOT / rel).write_bytes(render(data))
            except Exception as e:  # noqa: BLE001
                print(f"  렌더 실패: {e}")
                continue
            pages[doi] = rel
            changed = True
            print(f"  저장: {rel} ({url})")
            break
        else:
            print("  공개 PDF 없음")
        time.sleep(1)
    if changed:
        MAP.parent.mkdir(parents=True, exist_ok=True)
        MAP.write_text(json.dumps(dict(sorted(pages.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("변경 있음" if changed else "변경 없음")


if __name__ == "__main__":
    sys.exit(main())
