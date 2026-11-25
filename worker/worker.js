// hibe lab 관리자 로그인 중계 (Cloudflare Worker)
// 하는 일 두 가지:
//   1) GitHub 로그인 중계: 홈페이지 관리 화면의 "GitHub로 로그인" → GitHub 승인 → 토큰을 홈페이지 창에 돌려줌
//   2) /summarize: 연구개발계획서(PDF·텍스트)를 Claude로 읽어 Projects 항목을 채움 (저장소 쓰기 권한이 있는 사람만)
// 필요한 설정 (Cloudflare 대시보드 > Workers > 이 Worker > Settings > Variables and Secrets):
//   GITHUB_CLIENT_ID      GitHub OAuth App의 Client ID           (일반 변수)
//   GITHUB_CLIENT_SECRET  GitHub OAuth App의 Client secret       (Secret)
//   SITE_ORIGINS          로그인 허용 사이트 주소, 쉼표로 구분      (일반 변수, 예: https://kim2384.github.io,https://hibe.cau.ac.kr)
//   GITHUB_REPO           내용이 저장되는 저장소                   (일반 변수, 예: kim2384/hibe-lab)
//   ANTHROPIC_API_KEY     계획서 자동 작성을 쓸 때만               (Secret, 선택)
//   GITHUB_WRITE_TOKEN    학생 연구원 저장용 토큰 (fine-grained, 이 저장소 Contents 읽기·쓰기만)   (Secret)
//
// 역할
//   P.I.·관리자: 저장소에 쓰기 권한이 있는 GitHub 계정. 모든 메뉴를 직접 저장.
//   학생 연구원: content/roles.json 의 students 명단에 있는 GitHub 계정. 저장소 권한은 없고,
//                이 Worker(/put)를 거쳐 허용된 메뉴(STUDENT_PATHS)의 파일만 저장할 수 있음.

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "title_ko", "period", "funder", "amount", "role", "desc", "no"],
  properties: {
    title: { type: "string", description: "Official English project title (or a faithful English translation)" },
    title_ko: { type: "string", description: "Korean project title as written in the plan, empty if none" },
    period: { type: "string", description: "Whole research period as 'YYYY.MM – YYYY.MM'; empty if not stated" },
    funder: { type: "string", description: "Funding agency in English, e.g. 'National Research Foundation of Korea'" },
    amount: { type: "string", description: "Total government funding over the whole period as 'KRW 1,234 Million'; empty if not stated" },
    role: { type: "string", enum: ["PI", "Co-PI", ""], description: "Role of Michael (Youngsu) Kim / 김영수 (Chung-Ang University)" },
    no: { type: "string", description: "Project/grant number if stated, else empty" },
    desc: { type: "string", description: "English overview for a lab website, 90-160 words, plain prose" },
  },
};
const PROMPT = `This is a Korean government research and development plan (연구개발계획서).
Fill in the fields for the hibe lab website (Prof. Michael (Youngsu) Kim, 김영수, Chung-Ang University).
- role: "PI" if Kim is the overall principal investigator (연구책임자 / 총괄책임자) of this project, "Co-PI" if Kim leads a sub-project, joint institution or participates (공동연구책임자, 세부책임자, 참여), "" if Kim is not mentioned.
- desc: what the project aims to do, how, and what it delivers. Write for prospective students and collaborators; no budget figures, no bullet points.
- Leave a field empty rather than guessing.`;

// 학생 연구원이 저장할 수 있는 파일: 활동·수상·논문 내용과 그 사진
const STUDENT_PATHS = /^(content\/(posts|awards|pubs)\.json|images\/uploads\/(posts|awards|pubs|papers)\/(full\/)?[A-Za-z0-9._-]+\.(webp|png|jpe?g))$/;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["section", "reason", "fields", "images"],
  properties: {
    section: { type: "string", enum: ["posts", "awards", "pubs", "projects", "members"], description: "Which website menu this material belongs in" },
    reason: { type: "string", description: "One Korean sentence: why this menu, and anything the admin must check or fill in" },
    fields: {
      type: "object",
      additionalProperties: false,
      required: ["date", "title", "text", "news", "newsKo", "cat", "pubcat", "year", "authors", "venue", "doi", "corr", "summary", "role", "period", "funder", "total", "amount", "no", "desc", "title_ko", "name", "group", "mrole", "interests"],
      properties: {
        date: { type: "string", description: "posts/awards: event or award date YYYY-MM-DD; empty if unknown" },
        title: { type: "string", description: "posts: event name; awards: '<award name>, <event/organizer> (<date>)' in the original language of the certificate; pubs: paper title; projects: English project title" },
        text: { type: "string", description: "posts/awards: 1-4 short lines, e.g. '장소: …\n날짜: …' for events, or who received what for awards" },
        news: { type: "string", description: "posts/awards: one English news sentence, e.g. 'Kyungmin Kang won the Best Student Paper Award at ALC2026 in Nagoya, Japan'" },
        newsKo: { type: "string", description: "posts/awards: the same news sentence in Korean" },
        cat: { type: "string", enum: ["conf", "out", ""], description: "posts only: conf = attended a scientific conference, out = outreach, seminar, lab event or other" },
        pubcat: { type: "string", enum: ["sci", "kci", "intconf", "domconf", ""], description: "pubs only: sci = international journal, kci = Korean journal, intconf = international conference, domconf = Korean conference" },
        year: { type: "string", description: "pubs: publication year" },
        authors: { type: "string", description: "pubs: APA style, e.g. 'Kim, J., Lee, H., & Kim, M.'" },
        venue: { type: "string", description: "pubs: journal or conference with volume, issue, pages" },
        doi: { type: "string", description: "pubs: DOI without https://doi.org/" },
        corr: { type: "string", description: "pubs: corresponding author short name if marked, e.g. 'Kim, M.'" },
        summary: { type: "string", description: "pubs: 2-4 sentence English summary" },
        role: { type: "string", enum: ["PI", "Co-PI", ""], description: "projects: PI if Michael (Youngsu) Kim / 김영수 is the overall PI, Co-PI if he leads a sub-project or participates" },
        period: { type: "string", description: "projects: 'YYYY.MM – YYYY.MM'" },
        funder: { type: "string", description: "projects: funding agency in English" },
        total: { type: "string", description: "projects: total funding of the whole project, 'KRW 1,234 Million'" },
        amount: { type: "string", description: "projects: amount allocated to Kim's lab (hibe lab) at Chung-Ang University if stated, 'KRW 123 Million'" },
        no: { type: "string", description: "projects: grant number" },
        desc: { type: "string", description: "projects: English overview, 90-160 words, plain prose, no budget figures" },
        title_ko: { type: "string", description: "projects: Korean title if present" },
        name: { type: "string", description: "members: 'Family, Given' romanized" },
        group: { type: "string", enum: ["Graduate Research Assistants", "Undergraduate Research Assistants", "Alumni", ""] },
        mrole: { type: "string", description: "members: e.g. \"Master's Researcher (1st year)\"" },
        interests: { type: "string", description: "members: research interests, one per line" },
      },
    },
    images: {
      type: "array",
      description: "For each attached image or PDF, in the order given: whether to show it on the website post",
      items: { type: "object", additionalProperties: false, required: ["index", "use"], properties: { index: { type: "integer" }, use: { type: "boolean" } } },
    },
  },
};
const DRAFT_PROMPT = (today, note, allowed) => `You help the admins of the hibe lab website (Prof. Michael (Youngsu) Kim, 김영수, Chung-Ang University, Seoul) turn raw material into a website entry.
Today is ${today}. The attached files are one batch about a single item: award certificates, event photos, a paper PDF, a funded project's research plan (연구개발계획서), a member's CV or photo, etc.
Menus you may choose from: ${allowed.join(", ")}.
- posts (Activities): conference attendance, seminars, outreach, lab events, usually with photos.
- awards (Awards): an award, prize or certificate given to lab members.
- pubs (Publications): a journal paper or conference paper/presentation.
- projects (Projects): a newly funded research project.
- members (Members): a new lab member.
Choose the single best menu, then fill only the fields that menu uses and leave all other fields as empty strings.
Use only what the material or the admin's note says. Leave a field empty rather than guessing; say in "reason" what is missing.
Names of lab members in English sentences use 'Given Family' order (e.g. Kyungmin Kang).
${note ? `Admin's note: ${note}` : ""}`;

const origins = (env) => String(env.SITE_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const cors = (env, req) => {
  const o = req.headers.get("Origin") || "";
  return origins(env).includes(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" }
    : {};
};
const json = (body, status, h) => new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });
const html = (body, extra = {}) => new Response(`<!doctype html><meta charset="utf-8"><title>hibe lab</title><body style="font-family:sans-serif;padding:24px">${body}`, { headers: { "Content-Type": "text/html; charset=utf-8", ...extra } });
const cookie = (req, k) => (req.headers.get("Cookie") || "").split(/;\s*/).map((c) => c.split("=")).find(([n]) => n === k)?.[1] || "";
const gh = (path, token, init = {}) => fetch("https://api.github.com" + path, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "hibe-lab-admin", ...(init.headers || {}) } });

// 로그인한 사람의 역할: "admin"(저장소 쓰기 권한) | "student"(roles.json 명단) | null
async function who(req, env) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const [u, r] = await Promise.all([gh("/user", token), gh(`/repos/${env.GITHUB_REPO}`, token)]);
  if (!u.ok) return null;
  const login = (await u.json()).login || "";
  const perm = r.ok ? (await r.json()).permissions || {} : {};
  if (perm.push) return { login, role: "admin" };
  if (!env.GITHUB_WRITE_TOKEN) return null;
  const f = await gh(`/repos/${env.GITHUB_REPO}/contents/content/roles.json`, env.GITHUB_WRITE_TOKEN, { headers: { Accept: "application/vnd.github.raw+json" } });
  const roles = f.ok ? await f.json().catch(() => ({})) : {};
  const hit = (roles.students || []).some((s) => String(s.login || "").toLowerCase() === login.toLowerCase());
  return hit ? { login, role: "student" } : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 1-1. 로그인 시작: GitHub 승인 화면으로 보냄
    if (url.pathname === "/auth") {
      const origin = (url.searchParams.get("origin") || "").replace(/\/$/, "");
      if (!origins(env).includes(origin)) return html("허용되지 않은 사이트입니다. Worker의 SITE_ORIGINS 설정을 확인해 주세요.");
      const state = crypto.randomUUID();
      const go = new URL("https://github.com/login/oauth/authorize");
      go.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      go.searchParams.set("redirect_uri", `${url.origin}/callback`);
      go.searchParams.set("scope", "public_repo");
      go.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { Location: go.toString(), "Set-Cookie": `hibe_oauth=${state}.${encodeURIComponent(origin)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` } });
    }

    // 1-2. GitHub에서 돌아옴: 코드를 토큰으로 바꿔 홈페이지 창에 전달
    if (url.pathname === "/callback") {
      // 쿠키 값 = state + "." + 주소. 주소 안에도 "."이 있으므로 첫 번째 "."에서만 나눔
      const raw = cookie(req, "hibe_oauth");
      const cut = raw.indexOf(".");
      const state = cut > 0 ? raw.slice(0, cut) : "";
      const origin = cut > 0 ? decodeURIComponent(raw.slice(cut + 1)) : "";
      if (!state || state !== url.searchParams.get("state") || !origins(env).includes(origin)) return html("로그인 확인에 실패했습니다. 창을 닫고 다시 시도해 주세요.");
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code"), redirect_uri: `${url.origin}/callback` }),
      });
      const t = await r.json().catch(() => ({}));
      if (!t.access_token) return html("GitHub 로그인에 실패했습니다. 창을 닫고 다시 시도해 주세요.");
      const msg = JSON.stringify({ hibeGithubToken: t.access_token });
      return html(`로그인되었습니다. 이 창은 곧 닫힙니다.<script>if(window.opener){window.opener.postMessage(${msg},${JSON.stringify(origin)});}window.close();</script>`,
        { "Set-Cookie": "hibe_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax", "Cache-Control": "no-store" });
    }

    // 2. 연구개발계획서 자동 작성
    if (url.pathname === "/summarize") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "계획서 자동 작성이 설정되지 않았습니다 (ANTHROPIC_API_KEY)." }, 501, h);
      if (!(await who(req, env))) return json({ error: "관리자만 사용할 수 있습니다." }, 403, h);

      const { filename = "", mime = "", data = "", text = "" } = await req.json().catch(() => ({}));
      const content = [];
      if (mime === "application/pdf" && data) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      else if (text) content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: filename });
      else return json({ error: "PDF 또는 텍스트 파일을 올려 주세요." }, 400, h);
      content.push({ type: "text", text: PROMPT });

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
          messages: [{ role: "user", content }],
        }),
      });
      if (r.status === 429) return json({ error: "잠시 후 다시 시도해 주세요 (요청이 많음)." }, 429, h);
      if (!r.ok) return json({ error: `요약 서비스 오류 (${r.status})` }, 502, h);
      const res = await r.json();
      if (res.stop_reason === "refusal") return json({ error: "계획서를 요약하지 못했습니다. 다른 파일로 다시 시도해 주세요." }, 422, h);
      const block = (res.content || []).find((b) => b.type === "text");
      if (!block) return json({ error: "요약 결과가 비어 있습니다." }, 502, h);
      try { return json(JSON.parse(block.text), 200, h); } catch { return json({ error: "요약 결과를 읽지 못했습니다." }, 502, h); }
    }

    // 3. 학생 연구원 저장: 허용된 파일만, Worker의 토큰으로 커밋
    if (url.pathname === "/put") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      const me = await who(req, env);
      if (!me) return json({ message: "관리자 명단에 없는 계정입니다." }, 403, h);
      const { path = "", content = "", sha = "", message = "" } = await req.json().catch(() => ({}));
      if (me.role === "student" && !STUDENT_PATHS.test(path)) return json({ message: "학생 연구원은 활동·수상·논문만 저장할 수 있습니다." }, 403, h);
      if (!env.GITHUB_WRITE_TOKEN) return json({ message: "Worker에 GITHUB_WRITE_TOKEN이 없습니다." }, 501, h);
      const r = await gh(`/repos/${env.GITHUB_REPO}/contents/${path}`, env.GITHUB_WRITE_TOKEN, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `${String(message).slice(0, 200)} [${me.login}]`, content, branch: "main", ...(sha ? { sha } : {}) }),
      });
      return json(await r.json().catch(() => ({})), r.status, h);
    }

    // 4. 자동 작성: 첨부 파일을 읽고 어느 메뉴에 무엇을 쓸지 제안
    if (url.pathname === "/draft") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "자동 작성이 설정되지 않았습니다 (Worker의 ANTHROPIC_API_KEY)." }, 501, h);
      const me = await who(req, env);
      if (!me) return json({ error: "관리자만 사용할 수 있습니다." }, 403, h);
      const { files = [], note = "", today = "" } = await req.json().catch(() => ({}));
      const content = [];
      files.slice(0, 12).forEach((f, i) => {
        content.push({ type: "text", text: `File ${i}: ${String(f.name || "").slice(0, 120)}` });
        if (f.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
        else if (/^image\/(jpeg|png|webp|gif)$/.test(f.mime)) content.push({ type: "image", source: { type: "base64", media_type: f.mime, data: f.data } });
        else if (f.text) content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: String(f.text).slice(0, 200000) }, title: f.name });
      });
      if (!content.length && !note) return json({ error: "파일이나 메모를 넣어 주세요." }, 400, h);
      const allowed = me.role === "student" ? ["posts", "awards", "pubs"] : ["posts", "awards", "pubs", "projects", "members"];
      content.push({ type: "text", text: DRAFT_PROMPT(String(today).slice(0, 10), String(note).slice(0, 2000), allowed) });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
          messages: [{ role: "user", content }],
        }),
      });
      if (r.status === 429) return json({ error: "잠시 후 다시 시도해 주세요 (요청이 많음)." }, 429, h);
      if (r.status === 413) return json({ error: "파일이 너무 큽니다. 개수를 줄여 주세요." }, 413, h);
      if (!r.ok) return json({ error: `자동 작성 서비스 오류 (${r.status})` }, 502, h);
      const res = await r.json();
      if (res.stop_reason === "refusal") return json({ error: "이 자료로는 초안을 만들지 못했습니다." }, 422, h);
      const block = (res.content || []).find((b) => b.type === "text");
      try {
        const out = JSON.parse(block.text);
        if (!allowed.includes(out.section)) out.section = allowed[0];
        return json(out, 200, h);
      } catch { return json({ error: "자동 작성 결과를 읽지 못했습니다." }, 502, h); }
    }

    return html("hibe lab 관리자 로그인 중계 서버입니다.");
  },
};
