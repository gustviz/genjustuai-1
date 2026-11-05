import test from "node:test";
import assert from "node:assert/strict";
import chatHandler, { readChatConfig, sanitizeMessages, stripThinking } from "../api/chat.js";

const KEY = "gsk_test_key_do_not_leak";
const ENV_KEYS = ["LLM_BASE_URL", "LLM_API_KEY", "GROQ_API_KEY", "LLM_MODEL", "CHAT_PROXY_TOKEN"];

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

async function withEnv(env, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function post(body, headers = {}) {
  return { method: "POST", headers, body };
}

const okReply = (content) => new Response(JSON.stringify({
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}), { status: 200, headers: { "content-type": "application/json" } });

test("GET without key on Groq is missing_config", async () => {
  await withEnv({}, async () => {
    const res = mockRes();
    await chatHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "missing_config" });
  });
});

test("GET with key reports the server model only", async () => {
  await withEnv({ GROQ_API_KEY: KEY }, async () => {
    const res = mockRes();
    await chatHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!JSON.stringify(res.body).includes(KEY));
  });
});

test("local Qwen base URL works without a key", async () => {
  await withEnv({ LLM_BASE_URL: "https://meu-tunel.example/v1", LLM_MODEL: "qwen3:8b" }, async () => {
    assert.equal(readChatConfig().configured, true);
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return okReply("Oi, Lina."); };
    const res = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen.url, "https://meu-tunel.example/v1/chat/completions");
    assert.equal(seen.init.headers.authorization, undefined);
    assert.equal(JSON.parse(seen.init.body).model, "qwen3:8b");
  });
});

test("POST forwards with server key, forces server model, caps max_tokens", async () => {
  await withEnv({ GROQ_API_KEY: KEY, LLM_MODEL: "openai/gpt-oss-120b" }, async () => {
    let sent;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return okReply("Olá!"); };
    const res = mockRes();
    await chatHandler(post({
      model: "algum-modelo-caro",
      max_tokens: 99999,
      messages: [{ role: "system", content: "Você é o Corvo." }, { role: "user", content: "oi" }],
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.choices[0].message.content, "Olá!");
    assert.equal(res.body.usage.total_tokens, 15);
    assert.equal(sent.url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(sent.init.headers.authorization, `Bearer ${KEY}`);
    const payload = JSON.parse(sent.init.body);
    assert.equal(payload.model, "openai/gpt-oss-120b");
    assert.equal(payload.max_tokens, 1024);
    assert.ok(!JSON.stringify(res.body).includes(KEY));
  });
});

test("Qwen <think> block is removed from the reply", async () => {
  await withEnv({ GROQ_API_KEY: KEY }, async () => {
    globalThis.fetch = async () => okReply("<think>raciocínio interno</think>\n\nBoa noite.");
    const res = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), res);
    assert.equal(res.body.choices[0].message.content, "Boa noite.");
  });
  assert.equal(stripThinking("<think>sem fim"), "");
});

test("token is enforced when CHAT_PROXY_TOKEN is set", async () => {
  await withEnv({ GROQ_API_KEY: KEY, CHAT_PROXY_TOKEN: "quest-123" }, async () => {
    globalThis.fetch = async () => okReply("ok");
    const denied = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), denied);
    assert.equal(denied.statusCode, 401);
    const allowed = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }, { "x-genjutsu-token": "quest-123" }), allowed);
    assert.equal(allowed.statusCode, 200);
  });
});

test("invalid messages are rejected before calling the LLM", async () => {
  await withEnv({ GROQ_API_KEY: KEY }, async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return okReply("x"); };
    for (const messages of [undefined, [], [{ role: "tool", content: "x" }], [{ role: "system", content: "só system" }]]) {
      const res = mockRes();
      await chatHandler(post({ messages }), res);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: "invalid_messages" });
    }
    assert.equal(called, false);
  });
});

test("upstream errors never leak the provider body", async () => {
  await withEnv({ GROQ_API_KEY: KEY }, async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401 });
    const res = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "missing_config" });

    globalThis.fetch = async () => new Response("{}", { status: 429 });
    const limited = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), limited);
    assert.equal(limited.statusCode, 429);

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    const down = mockRes();
    await chatHandler(post({ messages: [{ role: "user", content: "oi" }] }), down);
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.body, { error: "llm_unreachable" });
  });
});

test("sanitizeMessages keeps the last 40 and trims long content", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `m${i}` }));
  const out = sanitizeMessages(many);
  assert.equal(out.length, 40);
  assert.equal(out[0].content, "m20");
  assert.equal(sanitizeMessages([{ role: "user", content: "x".repeat(9000) }])[0].content.length, 6000);
});
