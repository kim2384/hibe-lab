// 연구개발계획서(PDF 또는 텍스트)를 읽어 Projects 카로셀용 과제 개요를 만들어 줍니다.
// 관리자로 로그인한 사람만 부를 수 있습니다.
// 필요한 Secret: ANTHROPIC_API_KEY (Supabase 대시보드 > Edge Functions > Secrets)
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "title_ko", "period", "funder", "amount", "role", "desc", "no"],
  properties: {
    title: { type: "string", description: "Official English project title (or a faithful English translation)" },
    title_ko: { type: "string", description: "Korean project title as written in the plan, empty if none" },
    period: { type: "string", description: "Whole research period as 'YYYY.MM.DD – YYYY.MM' (end month only); empty if not stated" },
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // 로그인한 관리자인지 확인
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: isAdmin, error: adminErr } = await sb.rpc("is_admin");
  if (adminErr || !isAdmin) return json({ error: "관리자만 사용할 수 있습니다." }, 403);

  const { filename = "", mime = "", data = "", text = "" } = await req.json().catch(() => ({}));
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (mime === "application/pdf" && data) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
  } else if (text) {
    content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: filename });
  } else {
    return json({ error: "PDF 또는 텍스트 파일을 올려 주세요." }, 400);
  }
  content.push({ type: "text", text: PROMPT });

  const client = new Anthropic(); // ANTHROPIC_API_KEY
  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "refusal") return json({ error: "계획서를 요약하지 못했습니다. 다른 파일로 다시 시도해 주세요." }, 422);
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return json({ error: "요약 결과가 비어 있습니다." }, 502);
    return json(JSON.parse(block.text));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "잠시 후 다시 시도해 주세요 (요청이 많음)." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `요약 서비스 오류 (${e.status})` }, 502);
    return json({ error: String(e) }, 500);
  }
});
