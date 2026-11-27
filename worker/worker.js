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
//   지원서 양식(Join us)을 쓸 때만:
//   RESEND_API_KEY        메일 발송 서비스 Resend의 API 키         (Secret)
//   TURNSTILE_SECRET      Cloudflare Turnstile(스팸 방지)의 Secret key (Secret)
//   APPLY_TO              지원서를 받을 메일 주소                   (일반 변수, Resend 가입 메일과 같아야 함)
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

// 학생 연구원이 저장할 수 있는 파일: 활동·수상·연구과제·논문 내용과 그 사진
const STUDENT_PATHS = /^(content\/(posts|awards|projects|pubs)\.json|images\/uploads\/(posts|awards|projects|pubs|papers)\/(full\/)?[A-Za-z0-9._-]+\.(webp|png|jpe?g))$/;

const DRAFT_ITEM = {
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
// 한 묶음 자료에 여러 건(예: 학회 프로그램에 실린 논문 여러 편)이 있으면 건마다 초안 하나씩
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", description: "One entry per distinct website item found in the material, in document order", items: DRAFT_ITEM } },
};
const DRAFT_PROMPT = (today, note, allowed) => `You help the admins of the hibe lab website (Prof. Michael (Youngsu) Kim, 김영수, Chung-Ang University, Seoul) turn raw material into a website entry.
Today is ${today}. The attached files are one batch of material: award certificates, event photos, a paper PDF, a funded project's research plan (연구개발계획서), a member's CV or photo, a conference program, etc.
The batch may hold several separate website items (for example a conference program listing several papers by lab members, or certificates for different awards). Return one entry in "items" for each distinct item, in document order, and never merge separate papers or awards into one entry. If the batch is about a single item (e.g. several photos of one event), return exactly one entry. Include only items that involve the hibe lab or Prof. Kim; skip other people's papers in a program. At most 30 entries.
Menus you may choose from: ${allowed.join(", ")}.
- posts (Activities): conference attendance, seminars, outreach, lab events, usually with photos.
- awards (Awards): an award, prize or certificate given to lab members.
- pubs (Publications): a journal paper or conference paper/presentation.
- projects (Projects): a newly funded research project.
- members (Members): a new lab member.
For each entry choose the best menu, then fill only the fields that menu uses and leave all other fields as empty strings.
Use only what the material or the admin's note says. Leave a field empty rather than guessing; say in each entry's "reason" (one Korean sentence) what is missing.
Names of lab members in English sentences use 'Given Family' order (e.g. Kyungmin Kang).
${note ? `Admin's note: ${note}` : ""}`;

const origins = (env) => String(env.SITE_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const cors = (env, req) => {
  const o = req.headers.get("Origin") || "";
  return origins(env).includes(o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" }
    : {};
};
let STATS_READY = false;
async function statsInit(env) {
  if (STATS_READY) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS hits (day TEXT NOT NULL, vid TEXT NOT NULL, page TEXT, ref TEXT, country TEXT, mobile INTEGER)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS hits_day ON hits (day)").run();
  STATS_READY = true;
}
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
  // 학생 명단은 GitHub 아이디 또는 이메일(GitHub 계정에 인증된 이메일)로 등록할 수 있음
  const e = await gh("/user/emails", token);
  const emails = e.ok ? (await e.json().catch(() => [])).filter((x) => x.verified).map((x) => String(x.email).toLowerCase()) : [];
  const hit = (roles.students || []).some((s) => (s.login && String(s.login).toLowerCase() === login.toLowerCase()) || (s.email && emails.includes(String(s.email).toLowerCase())));
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
      go.searchParams.set("scope", "public_repo user:email");
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
      if (me.role === "student" && !STUDENT_PATHS.test(path)) return json({ message: "학생 연구원은 활동·수상·연구과제·논문만 저장할 수 있습니다." }, 403, h);
      if (!env.GITHUB_WRITE_TOKEN) return json({ message: "Worker에 GITHUB_WRITE_TOKEN이 없습니다." }, 501, h);
      const r = await gh(`/repos/${env.GITHUB_REPO}/contents/${path}`, env.GITHUB_WRITE_TOKEN, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `${String(message).slice(0, 200)} [${me.login}]`, content, branch: "main", ...(sha ? { sha } : {}) }),
      });
      return json(await r.json().catch(() => ({})), r.status, h);
    }

    // 6. 방문자 기록: 사이트가 페이지를 열 때마다 보냄 (IP는 저장하지 않고, 날짜별로 바뀌는 익명 ID와 나라만 저장)
    if (url.pathname === "/hit") {
      if (req.method !== "POST" || !env.DB) return new Response(null, { status: 204 });
      const o = (req.headers.get("Origin") || "").replace(/\/$/, "");
      if (!origins(env).includes(o)) return new Response(null, { status: 204 });
      const ua = req.headers.get("User-Agent") || "";
      if (!ua || /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|httpclient/i.test(ua)) return new Response(null, { status: 204 });
      const b = await req.json().catch(() => ({}));
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
      const ip = req.headers.get("CF-Connecting-IP") || "";
      const dg = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${ip}|${ua}|${env.GITHUB_CLIENT_SECRET || "hibe"}`));
      const vid = [...new Uint8Array(dg)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
      let ref = "";
      try { const h = new URL(String(b.r || "")).hostname; if (h && !/github\.io$/.test(h)) ref = h.replace(/^www\./, "").slice(0, 80); } catch {}
      const page = String(b.p || "home").replace(/[^a-z0-9_-]/gi, "").slice(0, 30) || "home";
      const country = String(req.cf?.country || "").slice(0, 2);
      const mobile = /Mobi|Android|iPhone|iPad/i.test(ua) ? 1 : 0;
      try {
        await statsInit(env);
        await env.DB.prepare("INSERT INTO hits (day, vid, page, ref, country, mobile) VALUES (?, ?, ?, ?, ?, ?)").bind(day, vid, page, ref, country, mobile).run();
        if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM hits WHERE day < ?").bind(new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)).run();
      } catch {}
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": o } });
    }

    // 7. 방문자 통계: 관리자만 (학생 연구원 제외)
    if (url.pathname === "/stats") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      const me = await who(req, env);
      if (!me || me.role !== "admin") return json({ error: "관리자만 볼 수 있습니다." }, 403, h);
      if (!env.DB) return json({ error: "nodb" }, 501, h);
      await statsInit(env);
      const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get("days") || "30", 10) || 30));
      const from = new Date(Date.now() + 9 * 3600e3 - (days - 1) * 864e5).toISOString().slice(0, 10);
      const q = (sql) => env.DB.prepare(sql).bind(from).all().then((r) => r.results || []);
      const [daily, pages, countries, refs, dev] = await Promise.all([
        q("SELECT day, COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors, COUNT(DISTINCT CASE WHEN country = 'KR' THEN vid END) AS kr FROM hits WHERE day >= ? GROUP BY day ORDER BY day"),
        q("SELECT page, COUNT(*) AS views FROM hits WHERE day >= ? GROUP BY page ORDER BY views DESC LIMIT 10"),
        q("SELECT country, COUNT(DISTINCT day || vid) AS visitors FROM hits WHERE day >= ? GROUP BY country ORDER BY visitors DESC LIMIT 10"),
        q("SELECT ref, COUNT(DISTINCT day || vid) AS visitors FROM hits WHERE day >= ? AND ref != '' GROUP BY ref ORDER BY visitors DESC LIMIT 8"),
        q("SELECT mobile, COUNT(DISTINCT day || vid) AS visitors FROM hits WHERE day >= ? GROUP BY mobile"),
      ]);
      return json({ from, days, daily, pages, countries, refs, dev }, 200, h);
    }

    // 5. 이미 올린 항목 고치기: 편집 창의 지금 내용과 지시문을 받아, 바꿀 칸만 돌려줌 (저장은 관리자가 확인 후)
    if (url.pathname === "/revise") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "자동 작성이 설정되지 않았습니다 (Worker의 ANTHROPIC_API_KEY)." }, 501, h);
      const me = await who(req, env);
      if (!me) return json({ error: "관리자만 사용할 수 있습니다." }, 403, h);
      const { section = "", item = {}, labels = {}, instruction = "", today = "" } = await req.json().catch(() => ({}));
      const allowed = me.role === "student" ? ["posts", "awards", "pubs", "projects"] : ["posts", "awards", "pubs", "projects", "members"];
      if (!allowed.includes(section)) return json({ error: "이 메뉴는 고칠 수 없습니다." }, 403, h);
      const ins = String(instruction).trim().slice(0, 3000);
      if (!ins) return json({ error: "어떻게 고칠지 적어 주세요." }, 400, h);
      const keys = Object.keys(item).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k) && typeof item[k] === "string").slice(0, 40);
      if (!keys.length) return json({ error: "고칠 내용이 없습니다." }, 400, h);
      const entry = keys.map((k) => `${k} (${String(labels[k] || k).slice(0, 200)}): ${JSON.stringify(String(item[k]).slice(0, 20000))}`).join("\n");
      const schema = {
        type: "object", additionalProperties: false, required: ["reason", "fields"],
        properties: {
          reason: { type: "string", description: "One short Korean sentence: what you changed, or why nothing could be changed" },
          fields: { type: "array", description: "Only the fields you change, each with its complete new value", items: { type: "object", additionalProperties: false, required: ["key", "value"], properties: { key: { type: "string", enum: keys }, value: { type: "string" } } } },
        },
      };
      const prompt = `You edit one existing entry of the hibe lab website (Prof. Michael (Youngsu) Kim, 김영수, Chung-Ang University, Seoul), in the ${section} menu. Today is ${String(today).slice(0, 10)}.
Current entry, one field per line as key (label): value:
${entry}

The admin's request: ${ins}

Apply the request. Return in "fields" only the fields you change, each with its full new value; leave everything else out. Keep each field's language: labels that say 국문 or keys ending in Ko are Korean, 영문 fields are English. For a select field, use one of the option values listed in its label. Do not invent facts that are not in the entry or the request. Names of lab members in English sentences use 'Given Family' order.`;
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema", schema } }, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.status === 429) return json({ error: "잠시 후 다시 시도해 주세요 (요청이 많음)." }, 429, h);
      if (!r.ok) return json({ error: `자동 작성 서비스 오류 (${r.status})` }, 502, h);
      const res = await r.json();
      if (res.stop_reason === "refusal") return json({ error: "이 요청으로는 고치지 못했습니다." }, 422, h);
      const block = (res.content || []).find((b) => b.type === "text");
      try {
        const out = JSON.parse(block.text);
        const fields = {};
        (out.fields || []).forEach((f) => { if (keys.includes(f.key)) fields[f.key] = String(f.value); });
        return json({ fields, reason: String(out.reason || "") }, 200, h);
      } catch { return json({ error: "고친 결과를 읽지 못했습니다." }, 502, h); }
    }

    // 4. 자동 작성: 첨부 파일을 읽고 어느 메뉴에 무엇을 쓸지 제안
    if (url.pathname === "/draft") {
      const h = cors(env, req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "자동 작성이 설정되지 않았습니다 (Worker의 ANTHROPIC_API_KEY)." }, 501, h);
      const me = await who(req, env);
      if (!me) return json({ error: "관리자만 사용할 수 있습니다." }, 403, h);
      const { files = [], note = "", today = "", section = "", pubcat = "", drafts = null } = await req.json().catch(() => ({}));
      const content = [];
      files.slice(0, 12).forEach((f, i) => {
        content.push({ type: "text", text: `File ${i}: ${String(f.name || "").slice(0, 120)}` });
        if (f.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
        else if (/^image\/(jpeg|png|webp|gif)$/.test(f.mime)) content.push({ type: "image", source: { type: "base64", media_type: f.mime, data: f.data } });
        else if (f.text) content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: String(f.text).slice(0, 200000) }, title: f.name });
      });
      if (!content.length && !note) return json({ error: "파일이나 메모를 넣어 주세요." }, 400, h);
      const allowed = me.role === "student" ? ["posts", "awards", "pubs", "projects"] : ["posts", "awards", "pubs", "projects", "members"];
      const force = allowed.includes(section) ? section : "";
      const pc = ["sci", "kci", "intconf", "domconf"].includes(pubcat) ? pubcat : "";
      // 만들어진 초안 고치기: 지금 초안을 함께 보내면, 메모의 '수정 요청'대로 고친 전체 목록을 돌려줌
      if (Array.isArray(drafts) && drafts.length) content.push({ type: "text", text: `These are the current drafts the admin is reviewing (JSON). Revise them according to the admin's 수정 요청 in the note below and return the complete revised list in "items": keep every entry and field the request does not touch exactly as it is, keep the same order, and add, split, merge or drop entries only if the request asks for it. The attached files are the original material, for checking facts.\n${JSON.stringify(drafts.slice(0, 30)).slice(0, 60000)}` });
      content.push({ type: "text", text: DRAFT_PROMPT(String(today).slice(0, 10), String(note).slice(0, 4000), force ? [force] : allowed) + (force ? `\nThe admin chose the ${force} menu: put every entry there.` : "") + (force === "pubs" && pc ? `\nEvery entry is pubcat ${pc}.` : "") });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 32000,
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
        const items = (Array.isArray(out.items) ? out.items : [out]).slice(0, 30);
        items.forEach((it) => { if (force) it.section = force; if (!allowed.includes(it.section)) it.section = allowed[0]; if (force === "pubs" && pc && it.fields) it.fields.pubcat = pc; });
        return json({ items }, 200, h);
      } catch { return json({ error: "자동 작성 결과를 읽지 못했습니다." }, 502, h); }
    }

    // 9. 지원서 (Join us 양식): 스팸 검사(Turnstile) 후 교수님 메일로 보냄. 성적증명서 PDF 첨부
    if (url.pathname === "/apply") {
      const o = (req.headers.get("Origin") || "").replace(/\/$/, "");
      const h = origins(env).includes(o) ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" } : null;
      if (!h) return json({ error: "허용되지 않은 사이트입니다." }, 403, {});
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return json({ error: "POST only" }, 405, h);
      if (!env.RESEND_API_KEY || !env.TURNSTILE_SECRET || !env.APPLY_TO) return json({ error: "지원서 양식이 아직 설정되지 않았습니다." }, 501, h);
      const b = await req.json().catch(() => ({}));
      const s = (v, n) => String(v || "").replace(/\r/g, "").trim().slice(0, n);
      const name = s(b.name, 60), email = s(b.email, 120), aff = s(b.aff, 160), program = s(b.program, 60), intro = s(b.intro, 3000), lang = b.lang === "en" ? "en" : "ko";
      const pdf = String(b.pdf || ""), pdfName = s(b.pdfName, 120).replace(/[^\w.\- ()가-힣]/g, "_") || "transcript.pdf";
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !intro || !pdf) return json({ error: lang === "en" ? "Please fill in all required fields." : "필수 항목을 모두 입력해 주세요." }, 400, h);
      if (pdf.length > 14e6 || !pdf.startsWith("JVBER")) return json({ error: lang === "en" ? "Please attach a PDF under 10 MB." : "10MB 이하 PDF 파일을 첨부해 주세요." }, 400, h);
      const ip = req.headers.get("CF-Connecting-IP") || "";
      const tv = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(b.token || ""), remoteip: ip }) }).then((r) => r.json()).catch(() => ({}));
      if (!tv.success) return json({ error: lang === "en" ? "Spam check failed. Please try again." : "스팸 방지 확인에 실패했습니다. 다시 시도해 주세요." }, 403, h);
      // 같은 곳에서 하루 3번까지 (D1이 연결돼 있을 때만)
      if (env.DB) {
        try {
          const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
          const dg = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`apply|${day}|${ip}`));
          const k = [...new Uint8Array(dg)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS applies (day TEXT NOT NULL, k TEXT NOT NULL)").run();
          const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM applies WHERE day = ? AND k = ?").bind(day, k).first())?.n || 0;
          if (n >= 3) return json({ error: lang === "en" ? "Too many submissions today. Please email us directly." : "오늘은 더 보낼 수 없습니다. 메일로 직접 보내 주세요." }, 429, h);
          await env.DB.prepare("INSERT INTO applies (day, k) VALUES (?, ?)").bind(day, k).run();
          await env.DB.prepare("DELETE FROM applies WHERE day < ?").bind(new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).run();
        } catch {}
      }
      const text = [`이름: ${name}`, `이메일: ${email}`, `소속: ${aff || "-"}`, `희망 과정: ${program || "-"}`, "", "자기소개:", intro, "", `첨부: ${pdfName}`, "", "— hibe lab 홈페이지 Join us 지원서 양식에서 보냄. 이 메일에 답장하면 지원자에게 갑니다."].join("\n");
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "hibe lab 홈페이지 <onboarding@resend.dev>", to: [env.APPLY_TO], reply_to: email, subject: `[hibe lab 지원] ${name}${program ? " / " + program : ""}`, text, attachments: [{ filename: /\.pdf$/i.test(pdfName) ? pdfName : pdfName + ".pdf", content: pdf }] }),
      });
      if (!r.ok) return json({ error: lang === "en" ? "Could not send. Please email us directly." : "보내지 못했습니다. 메일로 직접 보내 주세요." }, 502, h);
      return json({ ok: true }, 200, h);
    }

    return html("hibe lab 관리자 로그인 중계 서버입니다.");
  },
};
