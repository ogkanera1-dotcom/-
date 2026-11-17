const MAX_TOPIC_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_OUTPUT_TOKENS = 250;
const DAILY_LIMIT = 5;
const TEN_MINUTE_LIMIT = 2;
const WINDOW_MS = 10 * 60 * 1000;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const OPENAI_URL = "https://api.openai.com/v1/responses";

let jwksCache;
let jwksCacheExpiresAt = 0;

function corsHeaders(origin, env) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, env),
    },
  });
}

function errorResponse(code, message, status, origin, env, usage) {
  return jsonResponse({
    status: "error",
    error: { code, message },
    ...(usage ? { usage } : {}),
  }, status, origin, env);
}

function jstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const fields = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return \`\${fields.year}-\${fields.month}-\${fields.day}\`;
}

function nextJstMidnightIso(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day + 1) - 9 * 60 * 60 * 1000,
  ).toISOString();
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeBase64UrlJson(value) {
  return JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(value)),
  );
}

async function getAccessJwks(teamDomain, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCacheExpiresAt > now) {
    return jwksCache;
  }

  const response = await fetch(
    \`https://\${teamDomain}/cdn-cgi/access/certs\`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error("Access signing keys unavailable");

  const data = await response.json();
  if (!Array.isArray(data.keys)) {
    throw new Error("Invalid Access signing keys");
  }

  jwksCache = data.keys;
  jwksCacheExpiresAt = Date.now() + JWKS_CACHE_MS;
  return jwksCache;
}

async function verifyAccessIdentity(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAIL) {
    throw new Error("Access configuration is incomplete");
  }

  const token = request.headers.get("CF-Access-Jwt-Assertion");
  if (!token) return null;

  const segments = token.split(".");
  if (segments.length !== 3) return null;

  let header;
  let claims;
  try {
    header = decodeBase64UrlJson(segments[0]);
    claims = decodeBase64UrlJson(segments[1]);
  } catch {
    return null;
  }

  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expectedIssuer = \`https://\${env.ACCESS_TEAM_DOMAIN}\`;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (
    claims.iss !== expectedIssuer ||
    !audiences.includes(env.ACCESS_AUD) ||
    typeof claims.exp !== "number" ||
    claims.exp <= nowSeconds ||
    (typeof claims.nbf === "number" && claims.nbf > nowSeconds) ||
    claims.email !== env.ALLOWED_EMAIL ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0
  ) {
    return null;
  }

  let jwks = await getAccessJwks(env.ACCESS_TEAM_DOMAIN);
  let jwk = jwks.find(
    (key) => key.kid === header.kid && key.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") &&
      (!key.use || key.use === "sig"),
  );

  if (!jwk) {
    jwks = await getAccessJwks(env.ACCESS_TEAM_DOMAIN, true);
    jwk = jwks.find(
      (key) => key.kid === header.kid && key.kty === "RSA" &&
        (!key.alg || key.alg === "RS256") &&
        (!key.use || key.use === "sig"),
    );
  }
  if (!jwk) return null;

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  try {
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlToBytes(segments[2]),
      new TextEncoder().encode(\`\${segments[0]}.\${segments[1]}\`),
    );
    return valid ? { subject: claims.sub } : null;
  } catch {
    return null;
  }
}

async function readBodyWithinLimit(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new Error("invalid_utf8");
  }
}

async function requestQuota(env, subject, action) {
  const objectId = env.QUOTAS.idFromName(subject);
  const stub = env.QUOTAS.get(objectId);
  const response = await stub.fetch(
    \`https://quota.internal/\${action}\`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Quota service failed");
  return response.json();
}

function extractOutputText(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.output)
  ) {
    throw new Error("invalid_upstream_response");
  }

  const textParts = [];
  for (const item of payload.output) {
    if (!item || typeof item !== "object") {
      throw new Error("invalid_upstream_response");
    }
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) {
      throw new Error("invalid_upstream_response");
    }

    for (const content of item.content) {
      if (!content || typeof content !== "object") {
        throw new Error("invalid_upstream_response");
      }
      if (content.type === "output_text") {
        if (typeof content.text !== "string") {
          throw new Error("invalid_upstream_response");
        }
        textParts.push(content.text);
      }
    }
  }

  const text = textParts.join("\\n").trim();
  if (!text) throw new Error("invalid_upstream_response");
  return text;
}

async function handleRequest(request, env) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    if (!origin || origin !== env.ALLOWED_ORIGIN) {
      return new Response(null, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin, env),
        "Cache-Control": "no-store",
      },
    });
  }

  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return errorResponse(
      "origin_denied",
      "このサイトからのアクセスは許可されていません。",
      403,
      origin,
      env,
    );
  }

  let identity;
  try {
    identity = await verifyAccessIdentity(request, env);
  } catch (error) {
    console.error("Access verification unavailable", error);
    return errorResponse(
      "auth_unavailable",
      "認証を確認できません。時間をおいて再試行してください。",
      503,
      origin,
      env,
    );
  }
  if (!identity) {
    return errorResponse(
      "unauthorized",
      "Cloudflare Accessで認証してください。",
      401,
      origin,
      env,
    );
  }

  if (request.method === "GET" && url.pathname === "/api/usage") {
    try {
      const usage = await requestQuota(env, identity.subject, "status");
      return jsonResponse({ status: "ok", usage }, 200, origin, env);
    } catch (error) {
      console.error("Quota status unavailable", error);
      return errorResponse(
        "quota_unavailable",
        "利用状況を確認できません。会議は開始できません。",
        503,
        origin,
        env,
      );
    }
  }

  if (request.method !== "POST" || url.pathname !== "/api/meeting") {
    return errorResponse(
      "not_found",
      "このAPIは利用できません。",
      404,
      origin,
      env,
    );
  }

  const contentType = (request.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(
      "unsupported_media_type",
      "JSON形式でリクエストしてください。",
      415,
      origin,
      env,
    );
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(
      "request_too_large",
      "リクエストは8 KB以内にしてください。",
      413,
      origin,
      env,
    );
  }

  let rawBody;
  try {
    rawBody = await readBodyWithinLimit(request);
  } catch (error) {
    const tooLarge = error.message === "request_too_large";
    return errorResponse(
      tooLarge ? "request_too_large" : "invalid_body",
      tooLarge
        ? "リクエストは8 KB以内にしてください。"
        : "リクエスト本文を読み取れませんでした。",
      tooLarge ? 413 : 400,
      origin,
      env,
    );
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse(
      "invalid_json",
      "リクエスト形式が正しくありません。",
      400,
      origin,
      env,
    );
  }

  if (
    !body ||
    typeof body.topic !== "string" ||
    body.topic.trim().length === 0
  ) {
    return errorResponse(
      "invalid_topic",
      "会議テーマを入力してください。",
      400,
      origin,
      env,
    );
  }

  const topic = body.topic.trim();
  if (topic.length > MAX_TOPIC_CHARS) {
    return errorResponse(
      "topic_too_long",
      "会議テーマは500文字以内にしてください。",
      400,
      origin,
      env,
    );
  }

  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) {
    return errorResponse(
      "service_not_configured",
      "WorkerのAI設定が完了していません。",
      503,
      origin,
      env,
    );
  }

  let usage;
  try {
    usage = await requestQuota(env, identity.subject, "reserve");
  } catch (error) {
    console.error("Quota reservation unavailable", error);
    return errorResponse(
      "quota_unavailable",
      "利用上限を確認できないため、AIを呼び出しませんでした。",
      503,
      origin,
      env,
    );
  }

  if (!usage.allowed) {
    const dailyLimit = usage.reason === "daily_limit";
    return errorResponse(
      usage.reason,
      dailyLimit
        ? "本日の会議上限に達しました。日本時間の0時にリセットされます。"
        : "10分間の利用上限に達しました。少し待ってから再試行してください。",
      429,
      origin,
      env,
      usage,
    );
  }

  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${env.OPENAI_API_KEY}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        instructions:
          "あなたはルイトAI AUTO TALKの会議参加者ChatGPTです。会議テーマについて日本語で具体的かつ簡潔に意見を述べてください。",
        input: topic,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    console.error("OpenAI request failed", error);
    return errorResponse(
      "upstream_unavailable",
      "AIへの接続に失敗しました。利用回数は消費済みとして扱います。",
      502,
      origin,
      env,
      usage,
    );
  }

  if (!upstream.ok) {
    console.error("OpenAI returned status", upstream.status);
    return errorResponse(
      "upstream_error",
      "AIサービスがエラーを返しました。利用回数は消費済みとして扱います。",
      502,
      origin,
      env,
      usage,
    );
  }

  let result;
  try {
    result = await upstream.json();
  } catch (error) {
    console.error("OpenAI JSON parsing failed", error);
    return errorResponse(
      "invalid_upstream_response",
      "AIの応答を読み取れませんでした。利用回数は消費済みです。",
      502,
      origin,
      env,
      usage,
    );
  }

  let text;
  try {
    text = extractOutputText(result);
  } catch {
    return errorResponse(
      "invalid_upstream_response",
      "AIの応答形式が正しくありません。利用回数は消費済みです。",
      502,
      origin,
      env,
      usage,
    );
  }

  return jsonResponse({
    status: "ok",
    messages: [{ speaker: "chatgpt", text }],
    usage: {
      ...usage,
      inputTokens: Number.isFinite(result?.usage?.input_tokens)
        ? result.usage.input_tokens
        : null,
      outputTokens: Number.isFinite(result?.usage?.output_tokens)
        ? result.usage.output_tokens
        : null,
    },
  }, 200, origin, env);
}

export class QuotaCounter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);
    if (
      request.method !== "POST" ||
      !["status", "reserve"].includes(action)
    ) {
      return new Response("Not found", { status: 404 });
    }

    try {
      const result = await this.storage.transaction(async () => {
        const now = Date.now();
        const today = jstDateKey(new Date(now));
        let record = await this.storage.get("quota");

        if (!record || record.date !== today) {
          record = { date: today, dailyCount: 0, recent: [] };
        }

        record.recent = Array.isArray(record.recent)
          ? record.recent.filter(
              (timestamp) =>
                Number.isSafeInteger(timestamp) &&
                timestamp > now - WINDOW_MS,
            )
          : [];

        if (action === "reserve") {
          if (record.dailyCount >= DAILY_LIMIT) {
            await this.storage.put("quota", record);
            return {
              allowed: false,
              reason: "daily_limit",
              dailyRemaining: 0,
              shortWindowRemaining: Math.max(
                0,
                TEN_MINUTE_LIMIT - record.recent.length,
              ),
              resetsAt: nextJstMidnightIso(today),
            };
          }

          if (record.recent.length >= TEN_MINUTE_LIMIT) {
            await this.storage.put("quota", record);
            return {
              allowed: false,
              reason: "rate_limit",
              dailyRemaining: Math.max(
                0,
                DAILY_LIMIT - record.dailyCount,
              ),
              shortWindowRemaining: 0,
              resetsAt: nextJstMidnightIso(today),
            };
          }

          record.dailyCount += 1;
          record.recent.push(now);
        }

        await this.storage.put("quota", record);
        return {
          allowed: true,
          dailyUsed: record.dailyCount,
          dailyRemaining: Math.max(
            0,
            DAILY_LIMIT - record.dailyCount,
          ),
          shortWindowRemaining: Math.max(
            0,
            TEN_MINUTE_LIMIT - record.recent.length,
          ),
          resetsAt: nextJstMidnightIso(today),
        };
      });

      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("Quota storage transaction failed", error);
      return Response.json(
        { error: "quota_unavailable" },
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled Worker error", error);
      return errorResponse(
        "internal_error",
        "サーバー側でエラーが発生しました。",
        500,
        request.headers.get("Origin"),
        env,
      );
    }
  },
};
