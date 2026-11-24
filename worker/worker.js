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
      const [state, enc] = cookie(req, "hibe_oauth").split(".");
      const origin = decodeURIComponent(enc || "");
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
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const repo = token ? await gh(`/repos/${env.GITHUB_REPO}`, token) : null;
      const perm = repo?.ok ? (await repo.json()).permissions : null;
      if (!perm?.push) return json({ error: "관리자만 사용할 수 있습니다." }, 403, h);

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

    return html("hibe lab 관리자 로그인 중계 서버입니다.");
  },
};
