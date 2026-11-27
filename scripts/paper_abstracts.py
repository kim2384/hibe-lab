"""논문 초록·키워드 자동 채우기.

논문(DOI)마다 초록과 키워드를 찾아 data/pub-abstracts.json 에 저장합니다. 찾는 순서:
  1) 저장소에 올린 논문 PDF(관리 화면 업로드, pubs 11번째 값)에서 Abstract / Keywords 부분을 읽음
  2) 인터넷에 공개된(오픈 액세스) PDF를 내려받아 같은 방식으로 읽음
  3) PDF가 없으면 Crossref → OpenAlex → Semantic Scholar 에 공개된 초록(키워드는 없을 수 있음)
이미 저장된 항목은 더 좋은 출처(PDF)를 찾았을 때만 바꿉니다. 직접 고친 항목("src": "manual")은 건드리지 않습니다.
GitHub Actions(.github/workflows/paper-pages.yml)가 논문 목록이 바뀔 때와 매주 실행합니다.
로컬에서 PDF 파일로 직접 채울 때: python scripts/paper_abstracts.py --pdf <DOI> <파일.pdf>
"""
import html, io, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "pub-abstracts.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
RANK = {"manual": 3, "pdf": 2, "api": 1}

HEAD_ABS = re.compile(r"(?is)^\s*(?:a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|abstract|summary)\b\s*[:.—–-]?\s*")
HEAD_KW = re.compile(r"(?is)(?:key\s?words?|k\s?e\s?y\s?w\s?o\s?r\s?d\s?s?|index terms)\s*[:：.—–-]?\s*")
STOP_BLOCK = re.compile(r"(?is)^\s*(?:(?:1|I)\.?\s+introduction|introduction\b|key\s?words?\b|k\s?e\s?y\s?w\s?o\s?r\s?d|index terms|a\s?r\s?t\s?i\s?c\s?l\s?e\s+i\s?n\s?f\s?o|article history|highlights\b|nomenclature\b|\*\s*corresponding|citation:|received[: ]|https?://|ⓒ|©|copyright)")


def clean(s):
    s = s.replace("­", "")
    s = re.sub(r"(?<=\w)-[ \t]+\n\s*(?=\w)", "-", s)   # 줄 끝 진짜 하이픈(semi-automated)은 붙여서 유지
    s = re.sub(r"(?<=[a-z])-\n(?=[a-z])", "", s)       # 줄바꿈용 하이픈은 지움
    s = re.sub(r"\s*\n\s*", " ", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def split_kw(chunk):
    chunk = chunk.strip()
    parts = re.split(r"[;,·•]", clean(chunk)) if re.search(r"[;,·•]", chunk) else chunk.split("\n")
    return [p.strip().rstrip(".").strip() for p in parts if 1 < len(p.strip()) < 80]


CUT = re.compile(r"(?im)^\s*(?:key\s?words?|index terms|key innovations|practical implications|highlights)\b")
INTRO_LINE = re.compile(r"(?im)^\s*(?:(?:1|I)\.?\s+)?introduction\s*$")
INTRO = re.compile(r"(?is)^\s*(?:(?:1|I)\.?\s+)?introduction\b")


def kw_block(bl, h):
    """키워드 제목 아래(또는 옆 단)의 짧은 줄 묶음."""
    near = [b for b in bl if b is not h and 0 <= b[1] - h[3] < 30 or (b is not h and abs(b[1] - h[1]) < 3 and b[0] > h[2])]
    for b in sorted(near, key=lambda b: (b[1], b[0])):
        lines = [x for x in b[4].split("\n") if x.strip()]
        if lines and max(len(x) for x in lines) < 60 and not STOP_BLOCK.match(b[4]):
            return b[4]
    return ""


def from_blocks(blocks):
    """한 쪽의 글 덩어리(좌표 포함)에서 초록·키워드 뽑기. 두 단 편집도 같은 단만 따라감."""
    bl = sorted([b for b in blocks if b[4].strip()], key=lambda b: (b[1], b[0]))
    ab, kw = "", []
    for h in bl:
        m = HEAD_ABS.match(h[4]) or re.search(r"(?im)^\s*(?:a\s?b\s?s\s?t\s?r\s?a\s?c\s?t|abstract)\s*[:.]?\s*$", h[4])
        if not m:
            continue
        rest = h[4][m.end():]
        rest = re.sub(r"(?is)^\s*k\s?e\s?y\s?w\s?o\s?r\s?d\s?s?\s*", "", rest)
        parts, bottom = [rest], h[3]
        col = [b for b in bl if b is not h and abs(b[0] - h[0]) < 20 and b[1] >= h[1] - 2]
        for b in sorted(col, key=lambda b: b[1]):
            if b[1] - bottom > 40 or STOP_BLOCK.match(b[4]) or b[4].lstrip().startswith("•"):
                break
            parts.append(b[4])
            bottom = b[3]
        txt = "\n".join(parts)
        i_end = INTRO_LINE.search(txt)
        if i_end:
            txt = txt[: i_end.start()]
        e = CUT.search(txt)
        if e:
            if re.match(r"(?i)\s*(?:key\s?words?|index terms)", txt[e.start():]):
                kw = split_kw(re.split(r"\n\s*\n", HEAD_KW.sub("", txt[e.start():], count=1).strip())[0])
            txt = txt[: e.start()]
        ab = clean(txt)
        if len(ab) >= 200:
            break
        ab = ""
    if not ab:  # 'Abstract' 제목이 없는 논문(T&F 등): 서론 바로 앞의 긴 문단
        intro = next((b for b in bl if INTRO.match(b[4]) and len(b[4]) < 40), None)
        if intro:
            prev = [b for b in bl if b[3] <= intro[1] + 2 and len(clean(b[4])) >= 300 and not STOP_BLOCK.match(b[4])]
            if prev:
                ab = clean(max(prev, key=lambda b: b[3])[4])
    if not kw:
        for h in bl:
            m = HEAD_KW.search(h[4])
            if not m or m.start() > 40:
                continue
            chunk = h[4][m.end():]
            if len(chunk.strip()) < 3:
                chunk = kw_block(bl, h)
            kw = split_kw(chunk)
            if kw:
                break
    return ab, kw[:12]


def page_blocks(doc, i):
    """i쪽 글 덩어리 + 다음 쪽 글 덩어리를 이어 붙임(초록이 다음 쪽으로 넘어가는 경우). 머리말·꼬리말은 뺌."""
    h = doc[i].rect.height
    cur = [b for b in doc[i].get_text("blocks") if b[4].strip() and b[1] < h * 0.9 and not (b[1] > h * 0.8 and len(b[4]) < 250 and STOP_BLOCK.match(b[4]))]
    if i + 1 >= len(doc) or not cur:
        return cur
    nxt = [b for b in doc[i + 1].get_text("blocks") if b[4].strip() and h * 0.07 < b[1] < h * 0.9]
    if not nxt:
        return cur
    shift = max(b[3] for b in cur) - min(b[1] for b in nxt) + 5
    return cur + [(b[0], b[1] + shift, b[2], b[3] + shift, b[4]) + tuple(b[5:]) for b in nxt]


def from_pdf(data):
    import pymupdf
    doc = pymupdf.open(stream=data, filetype="pdf")
    kw0 = []
    for i in range(min(5, len(doc))):
        ab, kw = from_blocks(page_blocks(doc, i))
        if ab:
            return ab, kw or kw0
        kw0 = kw0 or kw
    return "", kw0


def get(url, accept="*/*", timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def from_api(doi):
    q = urllib.parse.quote(doi, safe="/")
    try:
        w = json.loads(get("https://api.crossref.org/works/" + q, "application/json"))["message"]
        a = w.get("abstract") or ""
        if a:
            a = clean(html.unescape(re.sub(r"<[^>]+>", " ", a)))
            a = re.sub(r"^(Abstract|ABSTRACT)\s*", "", a)
            if len(a) > 200:
                return a, []
    except Exception as e:  # noqa: BLE001
        print(f"  crossref 실패: {e}")
    try:
        w = json.loads(get("https://api.openalex.org/works/doi:" + q, "application/json"))
        inv = w.get("abstract_inverted_index") or {}
        if inv:
            pos = sorted((i, word) for word, idx in inv.items() for i in idx)
            a = " ".join(word for _, word in pos)
            if len(a) > 200:
                return a, []
    except Exception as e:  # noqa: BLE001
        print(f"  openalex 실패: {e}")
    try:
        w = json.loads(get(f"https://api.semanticscholar.org/graph/v1/paper/DOI:{q}?fields=abstract", "application/json"))
        a = w.get("abstract") or ""
        if len(a) > 200:
            return a.strip(), []
    except Exception as e:  # noqa: BLE001
        print(f"  semantic scholar 실패: {e}")
    return "", []


def pubs():
    """{DOI(없으면 PDF 경로): 저장소 PDF 경로}."""
    out = {}
    text = (ROOT / "index.html").read_text(encoding="utf-8")
    m = re.search(r"\n  pubs: \[(.*?)\n  \],", text, re.S)
    rows = json.loads("[" + m.group(1) + "]") if m else []
    cj = ROOT / "content" / "pubs.json"
    if cj.exists():
        for p in json.loads(cj.read_text(encoding="utf-8")):
            rows.append(["", "", "", "", "", p.get("doi", ""), "", "", "", "", p.get("pdf", "")])
    for r in rows:
        doi = str(r[5] if len(r) > 5 else "").strip()
        pdf = str(r[10]) if len(r) > 10 and r[10] else ""
        key = doi if doi.startswith("10.") else pdf   # DOI가 없는 학회 발표는 올린 PDF 경로로
        if key:
            out[key] = pdf or out.get(key, "")
    return out


def save(data):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(dict(sorted(data.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def put(data, doi, ab, kw, src):
    old = data.get(doi) or {}
    if not ab or RANK.get(old.get("src"), 0) > RANK[src]:
        return False
    if old.get("src") == src and old.get("abs"):
        return False
    data[doi] = {"abs": ab, "kw": kw or old.get("kw", []), "src": src}
    return True


def main():
    data = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if sys.argv[1:2] == ["--pdf"]:
        doi, path = sys.argv[2], sys.argv[3]
        ab, kw = from_pdf(Path(path).read_bytes())
        print(doi, "→", ab[:100], kw)
        if ab:
            data[doi] = {"abs": ab, "kw": kw, "src": "pdf"}
            save(data)
        return
    sys.path.insert(0, str(Path(__file__).parent))
    changed = 0
    for doi, pdf in pubs().items():
        cur = data.get(doi) or {}
        if RANK.get(cur.get("src"), 0) >= RANK["pdf"]:
            continue
        if not doi.startswith("10.") and not pdf:
            continue
        print(doi)
        ab, kw = "", []
        if pdf and not pdf.startswith("http") and (ROOT / pdf).exists():
            ab, kw = from_pdf((ROOT / pdf).read_bytes())
            if put(data, doi, ab, kw, "pdf"):
                changed += 1
                continue
        if not doi.startswith("10."):
            continue
        try:
            from paper_pages import candidates
            for u in candidates(doi):
                try:
                    b = get(u, "application/pdf")
                    if b[:4] == b"%PDF":
                        ab, kw = from_pdf(b)
                        if ab:
                            break
                except Exception as e:  # noqa: BLE001
                    print(f"  PDF 실패 {u}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"  PDF 후보 실패: {e}")
        if put(data, doi, ab, kw, "pdf"):
            changed += 1
            continue
        if cur.get("src") == "api":
            continue
        ab, kw = from_api(doi)
        if put(data, doi, ab, kw, "api"):
            changed += 1
    save(data)
    print(f"바뀐 논문 {changed}건")


if __name__ == "__main__":
    main()
