const MAX_TOPIC_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_OUTPUT_TOKENS = 250;
const DAILY_LIMIT = 5;
const TEN_MINUTE_LIMIT = 2;
const WINDOW_MS = 10 * 60 * 1000;
const OPENAI_URL = "https://api.openai.com/v1/responses";

let jwksCache;
let jwksCacheExpiresAt = 0;

function jsonResponse(data, status, origin, env, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    ...extraHeaders,
  });
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(code, message, status, origin, env, usage) {
  return jsonResponse({
    status: "error",
    error: { code, message },
    ...(usage ? { usage } : {}),
  }, status, origin, env);
}

function jstDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function getJwks(teamDomain) {
  const now = Date.now();
  if (jwksCache && jwksCacheExpiresAt > now) return jwksCache;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Access signing keys unavailable");
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Invalid Access signing keys");
  jwksCache = data.keys;
  jwksCacheExpiresAt = now + 5 * 60 * 1000;
  return jwksCache;
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeBase64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function authenticatedIdentity(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    throw new Error("Access configuration is incomplete");
  }
  const token = request.headers.get("CF-Access-Jwt-Assertion");
  if (!token) return null;

  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const header = decodeBase64UrlJson(segments[0]);
  const claims = decodeBase64UrlJson(segments[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = Math.floor(Date.now() / 1000);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(env.ACCESS_AUD)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now) return null;
  if (claims.email !== env.ALLOWED_EMAIL || typeof claims.sub !== "string") return null;

  const jwks = await getJwks(env.ACCESS_TEAM_DOMAIN);
  const jwk = jwks.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) return null;
  const publicKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const signedData = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", publicKey, base64UrlToBytes(segments[2]), signedData,
  );
  return valid ? { subject: claims.sub } : null;
}

async function quotaRequest(env, subject, action) {
  const objectId = env.QUOTAS.idFromName(subject);
  const stub = env.QUOTAS.get(objectId);
  const response = await stub.fetch(`https://quota.internal/${action}`, { method: "POST" });
  if (!response.ok) throw new Error("Quota service failed");
  return response.json();
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const text = [];
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") text.push(content.text);
    }
  }
  return text.join("\n").trim();
}

async function handleRequest(request, env) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    if (!origin || origin !== env.ALLOWED_ORIGIN) {
      return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      },
    });
  }

  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return errorResponse("origin_denied", "このサイトからのアクセスは許可されていません。", 403, origin, env);
  }

  if (!env.OPENAI_API_KEY) {
    return errorResponse("service_not_configured", "WorkerのAPI設定が完了していません。", 503, origin, env);
  }

  let identity;
  try {
    identity = await authenticatedIdentity(request, env);
  } catch (error) {
    console.error("Access verification unavailable", error);
    return errorResponse("auth_unavailable", "認証を確認できません。時間をおいて再試行してください。", 503, origin, env);
  }
  if (!identity) return errorResponse("unauthorized", "Cloudflare Accessで認証してください。", 401, origin, env);

  if (request.method === "GET" && url.pathname === "/api/usage") {
    try {
      const usage = await quotaRequest(env, identity.subject, "status");
      return jsonResponse({ status: "ok", usage }, 200, origin, env);
    } catch (error) {
      console.error("Quota status unavailable", error);
      return errorResponse("quota_unavailable", "利用状況を確認できません。会議は開始できません。", 503, origin, env);
    }
  }

  if (request.method !== "POST" || url.pathname !== "/api/meeting") {
    return errorResponse("not_found", "このAPIは利用できません。", 404, origin, env);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse("request_too_large", "リクエストは8 KB以内にしてください。", 413, origin, env);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return errorResponse("request_too_large", "リクエストは8 KB以内にしてください。", 413, origin, env);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("invalid_json", "リクエスト形式が正しくありません。", 400, origin, env);
  }
  if (!body || typeof body.topic !== "string" || body.topic.trim().length === 0) {
    return errorResponse("invalid_topic", "会議テーマを入力してください。", 400, origin, env);
  }
  const topic = body.topic.trim();
  if (topic.length > MAX_TOPIC_CHARS) {
    return errorResponse("topic_too_long", "会議テーマは500文字以内にしてください。", 400, origin, env);
  }

  let usage;
  try {
    usage = await quotaRequest(env, identity.subject, "reserve");
  } catch (error) {
    console.error("Quota reservation unavailable", error);
    return errorResponse("quota_unavailable", "利用上限を確認できないため、会議を開始しませんでした。", 503, origin, env);
  }
  if (!usage.allowed) {
    const code = usage.reason === "daily_limit" ? "daily_limit" : "rate_limit";
    const message = usage.reason === "daily_limit"
      ? "本日の会議上限に達しました。日本時間の0時にリセットされます。"
      : "10分間の利用上限に達しました。少し待ってから再試行してください。";
    return errorResponse(code, message, 429, origin, env, usage);
  }

  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: "あなたはルイトAI AUTO TALKの会議参加者ChatGPTです。会議テーマについて日本語で具体的かつ簡潔に意見を述べてください。",
        input: topic,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    console.error("OpenAI request failed", error);
    return errorResponse("upstream_unavailable", "AIへの接続に失敗しました。利用回数は安全のため消費済みとして扱います。", 502, origin, env, usage);
  }

  if (!upstream.ok) {
    console.error("OpenAI returned status", upstream.status);
    return errorResponse("upstream_error", "AIサービスがエラーを返しました。利用回数は安全のため消費済みとして扱います。", 502, origin, env, usage);
  }

  let result;
  try {
    result = await upstream.json();
  } catch {
    return errorResponse("invalid_upstream_response", "AIの応答を読み取れませんでした。利用回数は消費済みです。", 502, origin, env, usage);
  }
  const text = extractOutputText(result);
  if (!text) {
    return errorResponse("empty_upstream_response", "AIから発言を取得できませんでした。利用回数は消費済みです。", 502, origin, env, usage);
  }

  return jsonResponse({
    status: "ok",
    messages: [{ speaker: "chatgpt", text }],
    usage: {
      ...usage,
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
    },
  }, 200, origin, env);
}

export class QuotaCounter {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    if (request.method !== "POST" || !["status", "reserve"].includes(action)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const result = await this.storage.transaction(async (txn) => {
        const now = Date.now();
        const today = jstDateKey(new Date(now));
        let record = await txn.get("quota");
        if (!record || record.date !== today) record = { date: today, dailyCount: 0, recent: [] };
        record.recent = record.recent.filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp > now - WINDOW_MS);

        if (action === "reserve") {
          if (record.dailyCount >= DAILY_LIMIT) {
            await txn.put("quota", record);
            return { allowed: false, reason: "daily_limit", dailyRemaining: 0, shortWindowRemaining: Math.max(0, TEN_MINUTE_LIMIT - record.recent.length), resetsAt: `${today}T00:00:00+09:00` };
          }
          if (record.recent.length >= TEN_MINUTE_LIMIT) {
            await txn.put("quota", record);
            return { allowed: false, reason: "rate_limit", dailyRemaining: Math.max(0, DAILY_LIMIT - record.dailyCount), shortWindowRemaining: 0, resetsAt: `${today}T00:00:00+09:00` };
          }
          record.dailyCount += 1;
          record.recent.push(now);
          await txn.put("quota", record);
        } else {
          await txn.put("quota", record);
        }
        return {
          allowed: true,
          dailyUsed: record.dailyCount,
          dailyRemaining: Math.max(0, DAILY_LIMIT - record.dailyCount),
          shortWindowRemaining: Math.max(0, TEN_MINUTE_LIMIT - record.recent.length),
          resetsAt: `${today}T00:00:00+09:00`,
        };
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("Quota storage transaction failed", error);
      return new Response(JSON.stringify({ error: "quota_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled Worker error", error);
      const origin = request.headers.get("Origin");
      return errorResponse("internal_error", "サーバー側でエラーが発生しました。", 500, origin, env);
    }
  },
};
