// Proxy do Corvo para o Quest. O APK não carrega chave: a Vercel guarda LLM_API_KEY / GROQ_API_KEY.
// Fala o formato OpenAI /chat/completions, então serve Groq, OpenRouter, um Ollama/LM Studio
// exposto por túnel ou qualquer servidor compatível rodando Qwen. Contrato em docs/unity-session.md.

const DEFAULT_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 40;
const MAX_CHARS = 6000;
const MAX_TOKENS_CAP = 1024;
const TIMEOUT_MS = 45000;

export function readChatConfig(env = process.env) {
  const baseUrl = String(env.LLM_BASE_URL || DEFAULT_BASE).trim().replace(/\/$/, "");
  const apiKey = String(env.LLM_API_KEY || env.GROQ_API_KEY || "").trim();
  const model = String(env.LLM_MODEL || DEFAULT_MODEL).trim();
  const token = String(env.CHAT_PROXY_TOKEN || "").trim();
  // Groq exige chave. Um servidor local (Ollama via túnel) pode rodar sem.
  const keyRequired = baseUrl.includes("api.groq.com") || baseUrl.includes("openrouter.ai");
  return { baseUrl, apiKey, model, token, configured: Boolean(baseUrl && model && (apiKey || !keyRequired)) };
}

function cors(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-genjutsu-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendError(res, status, error) {
  res.status(status).json({ error });
}

function readBody(req) {
  const body = req.body;
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

export function sanitizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const tail = input.slice(-MAX_MESSAGES);
  const out = [];
  for (const item of tail) {
    const role = String(item?.role || "");
    if (!ROLES.has(role)) return null;
    const content = typeof item?.content === "string" ? item.content : "";
    if (!content.trim()) continue;
    out.push({ role, content: content.slice(0, MAX_CHARS) });
  }
  if (!out.some((m) => m.role === "user")) return null;
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const config = readChatConfig();

  if (req.method === "GET") {
    if (!config.configured) {
      sendError(res, 503, "missing_config");
      return;
    }
    res.status(200).json({ ok: true, model: config.model });
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 405, "method_not_allowed");
    return;
  }

  if (config.token && req.headers?.["x-genjutsu-token"] !== config.token) {
    sendError(res, 401, "unauthorized");
    return;
  }

  if (!config.configured) {
    sendError(res, 503, "missing_config");
    return;
  }

  const body = readBody(req);
  const messages = sanitizeMessages(body?.messages);
  if (!messages) {
    sendError(res, 400, "invalid_messages");
    return;
  }

  // O modelo é sempre o da Vercel: o cliente não escolhe um modelo caro.
  const payload = {
    model: config.model,
    messages,
    temperature: clampNumber(body?.temperature, 0, 1.5, 0.7),
    max_tokens: Math.round(clampNumber(body?.max_tokens, 16, MAX_TOKENS_CAP, 512)),
    stream: false,
  };

  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  let upstream;
  try {
    upstream = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    sendError(res, error?.name === "TimeoutError" ? 504 : 503, error?.name === "TimeoutError" ? "llm_timeout" : "llm_unreachable");
    return;
  }

  let json = null;
  try {
    json = await upstream.json();
  } catch {
    json = null;
  }

  if (!upstream.ok) {
    if (upstream.status === 429) sendError(res, 429, "rate_limited");
    else if (upstream.status === 401 || upstream.status === 403) sendError(res, 503, "missing_config");
    else sendError(res, 502, "llm_error");
    return;
  }

  const content = stripThinking(json?.choices?.[0]?.message?.content);
  if (!content) {
    sendError(res, 502, "empty_reply");
    return;
  }

  // Mesmo formato OpenAI: o GroqClient.cs do Unity lê sem mudar o parser.
  res.status(200).json({
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: {
      prompt_tokens: json?.usage?.prompt_tokens ?? 0,
      completion_tokens: json?.usage?.completion_tokens ?? 0,
      total_tokens: json?.usage?.total_tokens ?? 0,
    },
    model: config.model,
  });
}
