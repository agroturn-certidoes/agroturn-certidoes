// API da Agroturn: fica entre o site e a planilha.
// Guarda a senha da empresa e a chave de acesso ao SharePoint — nada disso aparece no site.
//
// Rotas (todas, exceto /api/login, exigem  Authorization: Bearer <token>):
//   POST /api/login          { email, password }                 -> { token, nome }
//   POST /api/refresh                                            -> { token, nome }   (renova o login)
//   GET  /api/table                                              -> { headers, rows, finalizados }
//   POST /api/pedidos        { chave, empreendimento, itens }    -> { ok, idIni, idFim, total }
//   GET  /api/push/chave                                         -> { publica }   (chave pública dos avisos)
//   POST /api/push/subscribe { subscription, nome }              -> { ok }   (ativar avisos neste aparelho)
//   POST /api/push/unsubscribe { endpoint }                      -> { ok }
//   POST /api/push/teste                                         -> { ok, enviados }
//
// Peça central: o "Estado" (Durable Object). Ele é único e atende um pedido por vez, por isso:
//   - grava pedidos na planilha em fila (dois envios simultâneos nunca recebem o mesmo Id);
//   - lembra dos pedidos já enviados (a mesma "chave" não grava duas vezes — útil no envio offline);
//   - a cada 5 min compara a planilha com a última leitura: guarda quando um pedido virou FINALIZADO
//     (a certidão vale 30 dias a partir daí) e manda os avisos (notificação no celular/computador).

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const TIPOS_PADRAO = ["Matrícula", "Cadeia Dominial", "Transcrição"];
const enc = new TextEncoder();

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
class RespostaErro extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

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
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function assinarToken(email, nome, env) {
  const payload = JSON.stringify({ email, nome, exp: Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS });
  const payloadB64 = b64url(enc.encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}
async function verificarToken(token, env) {
  if (!token) return null;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return null;
  const key = await hmacKey(env.SESSION_SECRET);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sigB64), enc.encode(payloadB64));
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
      return { email, nome: nomeExplicito || nomeDoEmail(email), explicito: !!nomeExplicito };
    })
    .filter((e) => e.email);
}

// FUNDIARIO_EMAILS (opcional): quem recebe aviso quando chega pedido novo.
function listaFundiario(env) {
  return String(env.FUNDIARIO_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// O site sugere o nome já com a grafia da planilha ("Maísa"). Aceitamos a sugestão só se for da mesma
// pessoa (mesmo primeiro nome do e-mail) — assim ninguém envia pedido "em nome" de outra pessoa.
function resolverSolicitante(sessao, sugerido) {
  if (sessao.explicito) return sessao.nome;
  const s = limparTexto(sugerido, 80);
  if (!s) return sessao.nome;
  const primeiro = (x) => norm(x).split(/\s+/)[0];
  return primeiro(s) === primeiro(sessao.nome) ? s : sessao.nome;
}

// Texto seguro pra gravar na planilha: sem caracteres de controle, com limite de tamanho, e sem virar
// fórmula do Excel (um texto começando com = + - @ seria executado como fórmula).
function limparTexto(v, max) {
  let s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
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

async function lerTabela(env) {
  const t = encodeURIComponent(await resolveTable(env));
  const { values } = await graph(env, `${workbookBase(env)}/tables('${t}')/range?$select=values`);
  return { headers: values[0].map(String), rows: values.slice(1) };
}

async function acrescentarLinhas(env, linhas) {
  const t = encodeURIComponent(await resolveTable(env));
  await graph(env, `${workbookBase(env)}/tables('${t}')/rows/add`, {
    method: "POST",
    body: JSON.stringify({ index: null, values: linhas }),
  });
}

// Localiza colunas pelo nome do cabeçalho (ignora acentos/maiúsculas), então a ordem pode mudar.
function colIndex(headers) {
  const find = (...nomes) => headers.findIndex((h) => nomes.some((n) => norm(h) === norm(n)));
  return {
    id: find("Id", "ID"),
    protocolo: find("Protocolo"),
    data: find("Data"),
    solicitante: find("Solicitante"),
    empreendimento: find("Nome do empreendimento"),
    tipo: find("Tipo de Certidão"),
    numero: find("Nº da Matrícula/Transcrição", "N° da Matrícula/Transcrição"),
    obs: find("Observações"),
    cartorio: find("Cartório Responsável"),
    responsavel: find("Responsável"),
    status: find("Status"),
    recibo: find("Recibo"),
    enviadoPor: find("Enviado por", "E-mail", "Email"), // opcional: quem enviou (e-mail autenticado)
  };
}

// Data e hora no fuso da empresa, como número de data do Excel (hora na parte fracionária).
function serialExcel(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  const dias = (Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(1899, 11, 30)) / 86400000;
  return dias + (+p.hour * 3600 + +p.minute * 60 + +p.second) / 86400;
}

// ---------- Web Push (aviso no celular/computador), sem biblioteca ----------
const concat = (...as) => {
  const out = new Uint8Array(as.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of as) { out.set(a, i); i += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

// RFC 8291 (aes128gcm): só o aparelho que se inscreveu consegue ler o conteúdo.
async function criptografarPush(sub, texto) {
  const uaPublic = b64urlToBytes(sub.keys.p256dh);
  const authSecret = b64urlToBytes(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, segredo, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const chave = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, chave, concat(enc.encode(texto), Uint8Array.of(2)))
  );
  const tamanho = new Uint8Array(4);
  new DataView(tamanho.buffer).setUint32(0, 4096);
  return concat(salt, tamanho, Uint8Array.of(asPublic.length), asPublic, cifrado);
}

// Chave pública VAPID (a que o site usa) a partir da chave privada em JWK.
function vapidPublica(jwk) {
  return b64url(concat(Uint8Array.of(4), b64urlToBytes(jwk.x), b64urlToBytes(jwk.y)));
}

async function jwtVapid(jwk, env, endpoint) {
  const chave = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const cab = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:no-reply@agroturn.com.br",
  })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chave, enc.encode(`${cab}.${corpo}`)));
  return { jwt: `${cab}.${corpo}.${b64url(sig)}`, pub: vapidPublica(jwk) };
}

// Devolve { status, texto } do serviço de push (404/410 = aparelho não existe mais). O texto é a
// explicação que o próprio serviço dá quando recusa (ex.: chave que não combina).
async function enviarPush(env, jwk, sub, dados) {
  const { jwt, pub } = await jwtVapid(jwk, env, sub.endpoint);
  const corpo = await criptografarPush(sub, JSON.stringify(dados));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${pub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: corpo,
  });
  return { status: res.status, texto: res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200) };
}

// ---------- Estado (Durable Object): um só, atende um pedido por vez ----------
export class Estado {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.fila = Promise.resolve();
  }

  // Executa uma tarefa por vez (mesmo com várias requisições chegando juntas).
  enfileirar(tarefa) {
    const proxima = this.fila.then(tarefa, tarefa);
    this.fila = proxima.catch(() => {});
    return proxima;
  }

  async fetch(request) {
    const caminho = new URL(request.url).pathname;
    const corpo = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    try {
      let dados;
      if (caminho === "/pedido") dados = await this.enfileirar(() => this.criarPedido(corpo));
      else if (caminho === "/tick") dados = await this.enfileirar(() => this.conferirPlanilha(corpo));
      else if (caminho === "/chave") dados = await this.enfileirar(async () => ({ publica: vapidPublica(await this.chaveVapid()) }));
      else if (caminho === "/finalizados") dados = (await this.state.storage.get("fin")) || {};
      else if (caminho === "/inscrever") dados = await this.enfileirar(() => this.inscrever(corpo));
      else if (caminho === "/desinscrever") dados = await this.enfileirar(() => this.desinscrever(corpo));
      else if (caminho === "/teste") dados = await this.enfileirar(() => this.testar(corpo));
      else return Response.json({ error: "Não encontrado." }, { status: 404 });
      return Response.json(dados);
    } catch (err) {
      const status = err instanceof RespostaErro ? err.status : 500;
      if (status >= 500) console.error(err);
      return Response.json({ error: err.message || "Erro interno." }, { status });
    }
  }

  // ----- Pedidos -----
  async criarPedido({ sessao, pedido }) {
    const env = this.env;
    const st = this.state.storage;
    const chave = limparTexto(pedido?.chave, 80);
    if (chave) {
      const anterior = await st.get("chave:" + chave);
      if (anterior) return { ...anterior.resp, repetido: true }; // já gravado (reenvio): não duplica
    }

    // Validação e limpeza: a API é quem decide o que vai pra planilha, não o navegador.
    const tipos = env.TIPOS ? String(env.TIPOS).split("|") : TIPOS_PADRAO;
    const empreendimento = limparTexto(pedido?.empreendimento, 200);
    if (!empreendimento) throw new RespostaErro(400, "Informe o nome do empreendimento.");
    const itens = Array.isArray(pedido?.itens) ? pedido.itens : [];
    if (!itens.length || itens.length > 50) throw new RespostaErro(400, "Informe de 1 a 50 certidões.");
    const linhasPedido = [];
    for (const it of itens) {
      const tipo = tipos.find((t) => norm(t) === norm(it?.tipo));
      if (!tipo) throw new RespostaErro(400, "Tipo de certidão inválido.");
      const cartorio = limparTexto(it?.cartorio, 200);
      if (!cartorio) throw new RespostaErro(400, "Informe o cartório responsável.");
      const numeros = (Array.isArray(it?.numeros) ? it.numeros : []).map((n) => limparTexto(n, 60)).filter(Boolean);
      if (!numeros.length) throw new RespostaErro(400, "Informe o número da matrícula/transcrição.");
      for (const numero of numeros) linhasPedido.push({ tipo, numero, cartorio, obs: limparTexto(it?.obs, 1000) });
    }
    if (linhasPedido.length > 200) throw new RespostaErro(400, "Muitas certidões em um pedido só (máx. 200).");

    const { headers, rows } = await lerTabela(env);
    const c = colIndex(headers);
    const faltando = ["solicitante", "empreendimento", "tipo", "numero", "cartorio"].filter((k) => c[k] < 0);
    if (faltando.length) throw new RespostaErro(500, `Colunas não encontradas na planilha: ${faltando.join(", ")}`);

    // Data do pedido: a do envio; se veio de um envio offline, a de quando a pessoa clicou (até 30 dias atrás).
    const agora = Date.now();
    let quando = Number(pedido?.criadoEm);
    if (!Number.isFinite(quando) || quando > agora + 5 * 60000 || quando < agora - 30 * 86400000) quando = agora;
    const serial = serialExcel(new Date(quando), env.TIMEZONE || "America/Cuiaba");
    const solicitante = resolverSolicitante(sessao, pedido?.solicitante);
    const statusInicial = env.STATUS_INICIAL || "AGUARDANDO PEDIDO";

    const maxId = c.id < 0 ? 0 : Math.max(0, ...rows.map((r) => Number(r[c.id]) || 0));
    const novas = linhasPedido.map((l, i) => {
      const linha = headers.map(() => null);
      const set = (k, v) => { if (c[k] >= 0) linha[c[k]] = v; };
      set("id", maxId + i + 1);
      // "protocolo" fica em branco: o Fundiário preenche com o número do RI Digital.
      set("data", serial);
      set("solicitante", solicitante);
      set("empreendimento", empreendimento);
      set("tipo", l.tipo);
      set("numero", l.numero);
      set("obs", l.obs);
      set("cartorio", l.cartorio);
      set("responsavel", "");
      set("status", statusInicial);
      set("recibo", false);
      set("enviadoPor", sessao.email);
      return linha;
    });
    await acrescentarLinhas(env, novas);

    const resp = { ok: true, idIni: maxId + 1, idFim: maxId + novas.length, total: novas.length, solicitante };
    if (chave) {
      await st.put("chave:" + chave, { resp, em: agora });
      for (const [k, v] of await st.list({ prefix: "chave:" })) {
        if (agora - v.em > 7 * 86400000) await st.delete(k); // guarda 7 dias
      }
    }

    // Aviso imediato pro Fundiário (e já marca os Ids como conhecidos pra conferência de 5 em 5 min
    // não avisar de novo).
    const snap = await st.get("snap");
    if (snap) {
      for (let i = 0; i < novas.length; i++) snap.ids[String(maxId + i + 1)] = statusInicial.toUpperCase();
      await st.put("snap", snap);
    }
    const tiposTxt = [...new Set(linhasPedido.map((l) => l.tipo))].join(", ");
    // Quem enviou não é avisado do próprio pedido.
    const aviso = await this.avisar(
      (s) => listaFundiario(env).includes(s.email) && s.email !== sessao.email,
      {
        titulo: `Novo pedido — ${empreendimento}`,
        corpo: `${solicitante}: ${novas.length} ${novas.length > 1 ? "certidões" : "certidão"} (${tiposTxt})`,
        aba: "acompanhar",
        tag: `novo-${maxId + 1}`,
      }
    );
    return { ...resp, aviso: { tentativas: aviso.tentativas, enviados: aviso.enviados } };
  }

  // ----- Conferência da planilha (cron a cada 5 min + sempre que alguém abre o site, no máx. 1x/min) -----
  async conferirPlanilha({ minimoSeg = 0 } = {}) {
    const env = this.env;
    const st = this.state.storage;
    const anterior = await st.get("snap");
    if (minimoSeg && anterior && Date.now() - anterior.em < minimoSeg * 1000) return { recente: true };
    const { headers, rows } = await lerTabela(env);
    const c = colIndex(headers);
    if (c.id < 0 || c.status < 0) return { ignorado: "planilha sem colunas Id/Status" };

    const atual = {};
    const info = {};
    for (const r of rows) {
      const id = r[c.id];
      if (id === null || id === undefined || id === "") continue;
      const status = String(r[c.status] ?? "").trim().toUpperCase();
      atual[String(id)] = status;
      info[String(id)] = {
        status,
        solicitante: String(r[c.solicitante] ?? "").trim(),
        empreendimento: String(r[c.empreendimento] ?? "").trim(),
        tipo: String(r[c.tipo] ?? "").trim(),
        numero: String(r[c.numero] ?? "").trim(),
      };
    }

    const snap = anterior;
    if (!snap) {
      await st.put("snap", { ids: atual, em: Date.now() }); // primeira leitura: só memoriza, sem avisar
      return { inicial: true, total: Object.keys(atual).length };
    }

    const fin = (await st.get("fin")) || {};
    const novos = [];
    const mudancas = [];
    for (const [id, status] of Object.entries(atual)) {
      const antes = snap.ids[id];
      if (antes === undefined) novos.push(id);
      else if (antes !== status) mudancas.push({ id, de: antes, para: status });
    }

    // Guarda quando a certidão chegou (FINALIZADO): dali começa a contar a validade de 30 dias.
    const agoraIso = new Date().toISOString();
    for (const m of mudancas) {
      if (m.para.includes("FINALIZ") && !m.de.includes("FINALIZ")) fin[m.id] = agoraIso;
      else if (!m.para.includes("FINALIZ") && m.de.includes("FINALIZ")) delete fin[m.id]; // reaberto
    }
    for (const id of novos) if (atual[id].includes("FINALIZ")) fin[id] = agoraIso;
    await st.put("fin", fin);

    // Pedidos que entraram direto na planilha (fora do site) também avisam o Fundiário.
    const grupos = (ids, chaveDe) => {
      const g = new Map();
      for (const id of ids) {
        const k = chaveDe(id);
        if (!g.has(k)) g.set(k, []);
        g.get(k).push(id);
      }
      return [...g.values()];
    };
    for (const ids of grupos(novos, (id) => norm(info[id].solicitante) + "|" + norm(info[id].empreendimento))) {
      const f = info[ids[0]];
      await this.avisar((s) => listaFundiario(env).includes(s.email), {
        titulo: `Novo pedido — ${f.empreendimento}`,
        corpo: `${f.solicitante}: ${ids.length} ${ids.length > 1 ? "certidões" : "certidão"}`,
        aba: "acompanhar",
        tag: `novo-${ids[0]}`,
      });
    }

    // Mudança de status: avisa quem pediu.
    for (const ids of grupos(mudancas.map((m) => m.id), (id) => norm(info[id].solicitante) + "|" + norm(info[id].empreendimento) + "|" + info[id].status)) {
      const f = info[ids[0]];
      const finalizado = f.status.includes("FINALIZ");
      const o = ids.length > 1 ? `${ids.length} certidões` : `${f.tipo} ${f.numero}`;
      await this.avisar((s) => norm(s.nome) === norm(f.solicitante), {
        titulo: finalizado ? "Certidão chegou" : "Pedido atualizado",
        corpo: finalizado
          ? `${f.empreendimento}: ${o} — FINALIZADO. Vale 30 dias a partir de hoje.`
          : `${f.empreendimento}: ${o} — ${f.status}`,
        aba: "acompanhar",
        tag: `status-${ids[0]}`,
      });
    }

    await st.put("snap", { ids: atual, em: Date.now() });
    return { novos: novos.length, mudancas: mudancas.length };
  }

  // ----- Avisos -----
  // A chave que identifica a Agroturn perante os serviços de aviso é criada aqui, uma única vez, e fica
  // guardada no próprio Estado — ninguém precisa gerar, copiar ou cadastrar nada à mão.
  async chaveVapid() {
    let jwk = await this.state.storage.get("vapid");
    if (!jwk) {
      const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      jwk = await crypto.subtle.exportKey("jwk", par.privateKey);
      await this.state.storage.put("vapid", jwk);
    }
    return jwk;
  }

  async avisar(filtro, dados) {
    const jwk = await this.chaveVapid();
    const subs = await this.state.storage.list({ prefix: "sub:" });
    const resumo = { tentativas: 0, enviados: 0, falhas: [] };
    for (const [chave, sub] of subs) {
      if (!filtro(sub)) continue;
      resumo.tentativas++;
      try {
        const { status, texto } = await enviarPush(this.env, jwk, sub, dados);
        if (status === 404 || status === 410) {
          await this.state.storage.delete(chave); // aparelho saiu
          resumo.falhas.push({ status, texto: "aparelho não existe mais (inscrição removida)" });
        } else if (status >= 200 && status < 300) resumo.enviados++;
        else {
          console.error("push falhou", status, texto);
          resumo.falhas.push({ status, texto, servico: new URL(sub.endpoint).host });
        }
      } catch (err) {
        console.error("push erro", err.message);
        resumo.falhas.push({ status: 0, texto: err.message }); // ex.: falha de rede ou chave corrompida
      }
    }
    return resumo;
  }

  async hashEndpoint(endpoint) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(endpoint)));
    return [...h].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async inscrever({ sessao, subscription, nome }) {
    const s = subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || !/^https:\/\//.test(s.endpoint)) {
      throw new RespostaErro(400, "Inscrição inválida.");
    }
    const chave = `sub:${sessao.email}:${await this.hashEndpoint(s.endpoint)}`;
    await this.state.storage.put(chave, {
      endpoint: s.endpoint,
      keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
      email: sessao.email,
      nome: resolverSolicitante(sessao, nome),
      em: Date.now(),
    });
    return { ok: true };
  }

  async desinscrever({ sessao, endpoint }) {
    await this.state.storage.delete(`sub:${sessao.email}:${await this.hashEndpoint(String(endpoint || ""))}`);
    return { ok: true };
  }

  async testar({ sessao }) {
    const resumo = await this.avisar((s) => s.email === sessao.email, {
      titulo: "Avisos ativados",
      corpo: "Está tudo certo: você vai receber avisos dos pedidos aqui.",
      aba: "home",
      tag: "teste",
    });
    const snap = await this.state.storage.get("snap");
    return { ok: true, ...resumo, configurado: true, conferidoEm: snap ? snap.em : null };
  }
}

// ---------- Rotas ----------
function estado(env) {
  return env.ESTADO.get(env.ESTADO.idFromName("unico"));
}

async function chamarEstado(env, caminho, corpo) {
  const res = await estado(env).fetch(`https://estado${caminho}`, {
    method: corpo === undefined ? "GET" : "POST",
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new RespostaErro(res.status, dados.error || "Erro interno.");
  return dados;
}

async function exigirSessao(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verificarToken(token, env);
  // Confere a lista a cada uso: quem for removido de ALLOWED_EMAILS perde o acesso na hora.
  const autorizado = payload && listaEmails(env).find((e) => e.email === payload.email);
  if (!autorizado) throw new RespostaErro(401, "Sessão expirada. Entre de novo.");
  return autorizado; // { email, nome, explicito } atuais da lista
}

async function handleLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  const emailNorm = String(email || "").trim().toLowerCase();
  const autorizado = listaEmails(env).find((e) => e.email === emailNorm);
  if (password !== env.SHARED_PASSWORD || !autorizado) {
    return json({ error: "E-mail ou senha incorretos." }, 401, env);
  }
  return json({ token: await assinarToken(autorizado.email, autorizado.nome, env), nome: autorizado.nome }, 200, env);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    const rota = `${request.method} ${url.pathname}`;
    try {
      if (rota === "POST /api/login") return await handleLogin(request, env);

      const sessao = await exigirSessao(request, env);
      const corpo = request.method === "POST" ? await request.json().catch(() => ({})) : {};

      if (rota === "POST /api/refresh") {
        return json({ token: await assinarToken(sessao.email, sessao.nome, env), nome: sessao.nome }, 200, env);
      }
      if (rota === "GET /api/table") {
        // Quem abre o site também dispara a conferência (no máximo 1x por minuto): mudanças de status
        // chegam mais rápido que esperar o agendamento de 5 em 5 minutos.
        ctx?.waitUntil?.(chamarEstado(env, "/tick", { minimoSeg: 60 }).catch((err) => console.error("tick falhou:", err.message)));
        const [tabela, finalizados] = await Promise.all([lerTabela(env), chamarEstado(env, "/finalizados")]);
        return json({ ...tabela, finalizados }, 200, env);
      }
      if (rota === "POST /api/pedidos") {
        return json(await chamarEstado(env, "/pedido", { sessao, pedido: corpo }), 200, env);
      }
      if (rota === "GET /api/push/chave") return json(await chamarEstado(env, "/chave", {}), 200, env);
      if (rota === "POST /api/push/subscribe") {
        return json(await chamarEstado(env, "/inscrever", { sessao, subscription: corpo.subscription, nome: corpo.nome }), 200, env);
      }
      if (rota === "POST /api/push/unsubscribe") {
        return json(await chamarEstado(env, "/desinscrever", { sessao, endpoint: corpo.endpoint }), 200, env);
      }
      if (rota === "POST /api/push/teste") {
        return json(await chamarEstado(env, "/teste", { sessao }), 200, env);
      }
      return json({ error: "Não encontrado." }, 404, env);
    } catch (err) {
      const status = err instanceof RespostaErro ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "Erro interno." }, status, env);
    }
  },

  // Cron (a cada 5 min): compara a planilha com a última leitura.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(chamarEstado(env, "/tick", {}).catch((err) => console.error("tick falhou:", err.message)));
  },
};
