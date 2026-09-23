// API da Agroturn: fica entre o site e a planilha.
// Guarda a senha da empresa e a chave de acesso ao SharePoint — nada disso aparece no site.
//
// Rotas:
//   POST /api/login   { email, password } -> { token }
//   POST /api/refresh  (Authorization: Bearer <token>) -> { token }   (renova o login)
//   GET  /api/table    (Authorization: Bearer <token>) -> { headers, rows }
//   POST /api/rows     (Authorization: Bearer <token>) { rows: [[...], ...] } -> { ok: true }

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...cors(env) } });
}

// ---------- Token de sessão (HMAC, sem biblioteca) ----------
// 1 ano, renovado a cada vez que a pessoa abre o site (/api/refresh) — na prática, quem usa o site
// de vez em quando não vê mais a tela de login.
const SESSAO_SEGUNDOS = 365 * 24 * 60 * 60;

function b64url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}
async function assinarToken(email, nome, env) {
  const payload = JSON.stringify({ email, nome, exp: Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS });
  const payloadB64 = b64url(new TextEncoder().encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}
async function verificarToken(token, env) {
  if (!token) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  const key = await hmacKey(env.SESSION_SECRET);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(payloadB64)
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Nome de quem pediu, tirado do e-mail: "victor.martins@..." -> "Victor Martins".
// (O site ainda acerta acentos comparando com a lista de nomes conhecidos.)
function nomeDoEmail(email) {
  const local = String(email).split("@")[0];
  return local
    .split(/[._-]+/)
    .map((p) => p.replace(/\d+/g, ""))
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// ALLOWED_EMAILS: e-mails separados por vírgula. Cada item pode ser só o e-mail
// ("victor.martins@agroturn.com.br") ou "e-mail=Nome" ("victor@agroturn.com.br=Victor Martins")
// quando o e-mail sozinho não dá o nome certo.
function listaEmails(env) {
  return String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((item) => {
      const i = item.indexOf("=");
      const email = (i < 0 ? item : item.slice(0, i)).trim().toLowerCase();
      const nomeExplicito = i < 0 ? "" : item.slice(i + 1).trim();
      return { email, nome: nomeExplicito || nomeDoEmail(email) };
    })
    .filter((e) => e.email);
}

// ---------- Graph (aplicativo, sem usuário logado) ----------
let graphTokenCache = null; // { token, exp }

async function graphToken(env) {
  if (graphTokenCache && graphTokenCache.exp > Date.now() / 1000 + 30) return graphTokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Falha ao autenticar com o Graph: ${res.status} ${await res.text()}`);
  const data = await res.json();
  graphTokenCache = { token: data.access_token, exp: Date.now() / 1000 + data.expires_in };
  return data.access_token;
}

async function graph(env, path, options = {}) {
  const token = await graphToken(env);
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function workbookBase(env) {
  return `/drives/${env.DRIVE_ID}/items/${env.ITEM_ID}/workbook`;
}

let tableNameCache = null;
async function resolveTable(env) {
  if (tableNameCache) return tableNameCache;
  const ws = encodeURIComponent(String(env.WORKSHEET).replace(/'/g, "''"));
  const { value } = await graph(env, `${workbookBase(env)}/worksheets('${ws}')/tables?$select=name`);
  if (!value.length) throw new Error(`Nenhuma tabela encontrada na aba "${env.WORKSHEET}".`);
  return (tableNameCache = value[0].name);
}

// ---------- Rotas ----------
async function handleLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  const emailNorm = String(email || "").trim().toLowerCase();
  const autorizado = listaEmails(env).find((e) => e.email === emailNorm);
  if (password !== env.SHARED_PASSWORD || !autorizado) {
    return json({ error: "E-mail ou senha incorretos." }, 401, env);
  }
  return json({ token: await assinarToken(autorizado.email, autorizado.nome, env), nome: autorizado.nome }, 200, env);
}

async function exigirSessao(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verificarToken(token, env);
  // Confere a lista a cada uso: quem for removido de ALLOWED_EMAILS perde o acesso na hora.
  const autorizado = payload && listaEmails(env).find((e) => e.email === payload.email);
  if (!autorizado) throw new RespostaErro(401, "Sessão expirada. Entre de novo.");
  return autorizado; // { email, nome } atuais da lista
}

async function handleRefresh(request, env) {
  const { email, nome } = await exigirSessao(request, env);
  return json({ token: await assinarToken(email, nome, env), nome }, 200, env);
}

class RespostaErro extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handleTable(request, env) {
  await exigirSessao(request, env);
  const t = encodeURIComponent(await resolveTable(env));
  const { values } = await graph(env, `${workbookBase(env)}/tables('${t}')/range?$select=values`);
  return json({ headers: values[0].map(String), rows: values.slice(1) }, 200, env);
}

async function handleRows(request, env) {
  await exigirSessao(request, env);
  const { rows } = await request.json();
  if (!Array.isArray(rows) || !rows.length) return json({ error: "Nada para gravar." }, 400, env);
  const t = encodeURIComponent(await resolveTable(env));
  await graph(env, `${workbookBase(env)}/tables('${t}')/rows/add`, {
    method: "POST",
    body: JSON.stringify({ index: null, values: rows }),
  });
  return json({ ok: true }, 200, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/login" && request.method === "POST") return await handleLogin(request, env);
      if (url.pathname === "/api/refresh" && request.method === "POST") return await handleRefresh(request, env);
      if (url.pathname === "/api/table" && request.method === "GET") return await handleTable(request, env);
      if (url.pathname === "/api/rows" && request.method === "POST") return await handleRows(request, env);
      return json({ error: "Não encontrado." }, 404, env);
    } catch (err) {
      const status = err instanceof RespostaErro ? err.status : 500;
      console.error(err);
      return json({ error: err.message || "Erro interno." }, status, env);
    }
  },
};
