(() => {
  const CFG = window.APP_CONFIG;
  const DEMO = !CFG.apiBase;
  const OBS_HINTS = {
    "Transcrição": "Informe folhas, livro e data da transcrição.",
    "Cadeia Dominial": "A cadeia é pedida até a origem. Se quiser até uma data específica, informe aqui.",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const domEmail = norm(CFG.dominioEmail).replace(/^@/, "");

  let cache = null; // { headers: [], rows: [][] }

  // ---------- Sessão (a API confere e-mail + senha e devolve um token) ----------
  const TOKEN_KEY = "agroturn-token";
  const getStoredToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setStoredToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} };
  const clearStoredToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} };

  // Só lê o e-mail de dentro do token pra mostrar na tela — quem confere de verdade é a API.
  function emailDoToken(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.exp < Date.now() / 1000) return null;
      return payload.email;
    } catch {
      return null;
    }
  }

  let sessaoEmail = null;

  async function fazerLogin(email, senha) {
    const res = await fetch(`${CFG.apiBase}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Não foi possível entrar.");
    setStoredToken(data.token);
    sessaoEmail = email;
  }

  function sair() {
    clearStoredToken();
    location.reload();
  }

  // ---------- Acesso à planilha (via API própria) ----------
  async function api(path, options = {}) {
    const token = getStoredToken();
    const res = await fetch(`${CFG.apiBase}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
    });
    if (res.status === 401) {
      clearStoredToken();
      location.reload();
      throw new Error("Sessão expirada.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  }

  async function loadTable(force = false) {
    if (cache && !force) return cache;
    if (DEMO) {
      const saved = readDemo();
      cache = { headers: DEMO_HEADERS, rows: saved };
      return cache;
    }
    cache = await api("/api/table");
    return cache;
  }

  async function appendRows(rows) {
    if (DEMO) {
      writeDemo([...readDemo(), ...rows]);
      return;
    }
    await api("/api/rows", { method: "POST", body: JSON.stringify({ rows }) });
  }

  // Modo demonstração: mesmas colunas da planilha, salvo no navegador.
  const DEMO_HEADERS = ["Id", "Protocolo", "Data", "Solicitante", "Nome do empreendimento", "Tipo de Certidão",
    "Nº da Matrícula/Transcrição", "Observações", "Cartório Responsável", "Responsável", "Status", "Recibo"];
  const DEMO_KEY = "agroturn-certidoes-demo";
  function readDemo() { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || []; } catch { return []; } }
  function writeDemo(rows) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(rows)); } catch {} }

  // Localiza colunas pelo nome do cabeçalho (ignora acentos/maiúsculas), então a ordem pode mudar.
  function colIndex(headers) {
    const find = (...names) => headers.findIndex((h) => names.some((n) => norm(h) === norm(n)));
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
    };
  }

  // ---------- Data e hora ----------
  // O Protocolo NÃO é gerado pelo site: é o número que o RI Digital (ONR) gera quando o
  // Fundiário faz o pedido lá, e é digitado na planilha manualmente depois. O site deixa
  // essa coluna em branco.
  function nowParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: CFG.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  }
  // Serial de data+hora do Excel (dias desde 1899-12-30, com a hora na parte fracionária).
  const excelSerial = (p) => {
    const dias = (Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(1899, 11, 30)) / 86400000;
    const horaFracao = (+p.hour * 3600 + +p.minute * 60 + +p.second) / 86400;
    return dias + horaFracao;
  };
  // Agrupa linhas do mesmo pedido mesmo sem Protocolo: mesmo minuto + solicitante + empreendimento.
  const chaveAgrupamento = (data, solicitante, empreendimento) =>
    `${Math.round((Number(data) || 0) * 1440)}|${norm(solicitante)}|${norm(empreendimento)}`;
  function formatData(v) {
    if (typeof v === "number" && v > 0) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
      const temHora = Math.round(v * 86400) % 86400 !== 0;
      return d.toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: temHora ? "short" : undefined });
    }
    return String(v ?? "");
  }

  // ---------- UI: formulário ----------
  const itensEl = $("#itens");
  let itemSeq = 0;

  function addItem() {
    const node = $("#itemTpl").content.firstElementChild.cloneNode(true);
    const seg = $(".seg", node);
    const group = `tipo-${++itemSeq}`;
    CFG.tiposCertidao.forEach((tipo) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="radio" name="${group}" value=""><span></span>`;
      label.querySelector("input").value = tipo;
      label.querySelector("span").textContent = tipo;
      seg.append(label);
    });
    seg.addEventListener("change", () => {
      seg.classList.remove("invalid");
      const tipo = $("input:checked", seg)?.value;
      $(".obs-hint", node).textContent = OBS_HINTS[tipo] || "";
    });
    $(".remove", node).addEventListener("click", () => { node.remove(); renumber(); });
    node.addEventListener("input", updateLinhas);
    itensEl.append(node);
    renumber();
    return node;
  }

  function renumber() {
    [...itensEl.children].forEach((el, i) => { $(".item-n", el).textContent = `Certidão ${i + 1}`; });
    updateLinhas();
  }

  const splitNumeros = (s) =>
    CFG.separarNumeros ? s.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean) : [s.trim()].filter(Boolean);

  function readItens() {
    return [...itensEl.children].map((el) => ({
      el,
      tipo: $("input:checked", el)?.value || "",
      numeros: splitNumeros($(".numero", el).value),
      cartorio: $(".cartorio", el).value.trim(),
      obs: $(".observacoes", el).value.trim(),
    }));
  }

  function updateLinhas() {
    const n = readItens().reduce((acc, it) => acc + Math.max(it.numeros.length, 1), 0);
    $("#linhasInfo").textContent = n > 1 ? `${n} certidões neste pedido` : "";
  }

  function validate() {
    let ok = true;
    const mark = (el, bad) => { el.classList.toggle("invalid", bad); if (bad) ok = false; };
    mark($("#solicitante"), !$("#solicitante").value);
    mark($("#empreendimento"), !$("#empreendimento").value.trim());
    for (const it of readItens()) {
      mark($(".seg", it.el), !it.tipo);
      mark($(".numero", it.el), !it.numeros.length);
      mark($(".cartorio", it.el), !it.cartorio);
    }
    return ok;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const errEl = $("#formError");
    errEl.hidden = true;
    if (!validate()) {
      errEl.textContent = "Preencha os campos obrigatórios destacados.";
      errEl.hidden = false;
      $(".invalid")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const btn = $("#submitBtn");
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const { headers, rows } = await loadTable(true);
      const c = colIndex(headers);
      const faltando = ["solicitante", "empreendimento", "tipo", "numero", "cartorio"].filter((k) => c[k] < 0);
      if (faltando.length) throw new Error(`Colunas não encontradas na planilha: ${faltando.join(", ")}`);

      const p = nowParts();
      const dataSerial = excelSerial(p);
      const maxId = c.id < 0 ? 0 : Math.max(0, ...rows.map((r) => Number(r[c.id]) || 0));
      const solicitante = $("#solicitante").value;
      const empreendimento = $("#empreendimento").value.trim();

      const novas = [];
      for (const it of readItens()) {
        for (const numero of it.numeros) {
          const row = headers.map(() => null);
          const set = (k, v) => { if (c[k] >= 0) row[c[k]] = v; };
          set("id", maxId + novas.length + 1);
          // "protocolo" fica em branco: o Fundiário preenche na planilha com o número do RI Digital.
          set("data", dataSerial);
          set("solicitante", solicitante);
          set("empreendimento", empreendimento);
          set("tipo", it.tipo);
          set("numero", numero);
          set("obs", it.obs);
          set("cartorio", it.cartorio);
          set("responsavel", "");
          set("status", CFG.statusInicial);
          set("recibo", false);
          novas.push(row);
        }
      }
      await appendRows(novas);
      cache = null;
      try { localStorage.setItem("agroturn-solicitante", solicitante); } catch {}

      const idIni = maxId + 1, idFim = maxId + novas.length;
      $("#protocoloOut").textContent = idIni === idFim ? `Nº ${idIni}` : `Nº ${idIni}–${idFim}`;
      $("#sucessoResumo").textContent =
        `${novas.length} ${novas.length > 1 ? "certidões registradas" : "certidão registrada"} para ${empreendimento}. ` +
        `O Setor Fundiário vai preencher o protocolo do RI Digital depois de solicitar no ONR.`;
      $("#pedidoForm").hidden = true;
      $("#sucesso").hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error(err);
      errEl.textContent = `Não foi possível enviar o pedido: ${err.message}`;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  }

  function resetForm() {
    const solicitante = $("#solicitante").value;
    $("#pedidoForm").reset();
    $("#solicitante").value = solicitante;
    itensEl.innerHTML = "";
    addItem();
    $("#formError").hidden = true;
    $("#sucesso").hidden = true;
    $("#pedidoForm").hidden = false;
  }

  // ---------- UI: acompanhar ----------
  const STATUS_CLASS = [["TAXA", "taxa"], ["PAGAMENTO", "pagamento"], ["PEDIDO", "pedido"], ["FINALIZ", "finalizado"]];
  const statusClass = (s) => (STATUS_CLASS.find(([k]) => String(s).toUpperCase().includes(k)) || [, ""])[1];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  async function renderLista(force = false) {
    const lista = $("#listaPedidos");
    lista.innerHTML = `<div class="empty">Carregando…</div>`;
    try {
      const { headers, rows } = await loadTable(force);
      fillSuggestions(headers, rows);
      const c = colIndex(headers);
      const quem = $("#filtroSolicitante").value;
      const q = norm($("#filtroBusca").value);
      const filtradas = rows.filter((r) => {
        if (!r[c.empreendimento]) return false;
        if (quem && norm(r[c.solicitante]) !== norm(quem)) return false;
        if (q && ![c.protocolo, c.empreendimento, c.numero, c.cartorio, c.tipo].some((i) => norm(r[i]).includes(q))) return false;
        return true;
      });

      // Resumo por status
      const counts = {};
      filtradas.forEach((r) => { const s = r[c.status] || "SEM STATUS"; counts[s] = (counts[s] || 0) + 1; });
      $("#statusResumo").innerHTML = Object.entries(counts)
        .map(([s, n]) => `<span class="chip"><span class="badge ${statusClass(s)}">${esc(s)}</span> ${n}</span>`).join("");

      // Agrupa por pedido (mesmo minuto + solicitante + empreendimento), mais recentes primeiro.
      // Não agrupa por Protocolo: ele é preenchido manualmente depois e pode faltar ou ser diferente por linha.
      const grupos = new Map();
      filtradas.forEach((r) => {
        const k = chaveAgrupamento(r[c.data], r[c.solicitante], r[c.empreendimento]);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(r);
      });
      const ordenados = [...grupos.values()].sort((a, b) => (Number(a[0][c.id]) || 0) - (Number(b[0][c.id]) || 0)).reverse().slice(0, 100);
      if (!ordenados.length) {
        lista.innerHTML = `<div class="empty">Nenhum pedido encontrado.</div>`;
        return;
      }
      lista.innerHTML = ordenados.map((rs) => {
        const f = rs[0];
        const ids = rs.map((r) => r[c.id]).filter((v) => v != null);
        const idLabel = ids.length > 1 ? `Nº ${Math.min(...ids)}–${Math.max(...ids)}` : `Nº ${ids[0] ?? "—"}`;
        const linhas = rs.map((r) => `
          <tr>
            <td>${esc(r[c.tipo])} · <strong>${esc(r[c.numero])}</strong>${r[c.obs] ? `<br><span class="muted small">${esc(r[c.obs])}</span>` : ""}
              ${r[c.protocolo] ? `<br><span class="muted small">Protocolo RI Digital: ${esc(r[c.protocolo])}</span>` : ""}</td>
            <td class="cart">${esc(r[c.cartorio])}</td>
            <td class="status"><span class="badge ${statusClass(r[c.status])}">${esc(r[c.status] || "—")}</span></td>
          </tr>`).join("");
        return `
          <article class="pedido">
            <div class="pedido-head">
              <div><strong>${esc(idLabel)}</strong> · ${esc(f[c.empreendimento])}</div>
              <div class="meta">${esc(formatData(f[c.data]))} · ${esc(f[c.solicitante])}${f[c.responsavel] ? ` · resp. ${esc(f[c.responsavel])}` : ""}</div>
            </div>
            <table>${linhas}</table>
          </article>`;
      }).join("");
    } catch (err) {
      console.error(err);
      lista.innerHTML = `<div class="alert error">Não foi possível ler a planilha: ${esc(err.message)}</div>`;
    }
  }

  function fillSuggestions(headers, rows) {
    const c = colIndex(headers);
    const uniq = (i) => [...new Set(rows.map((r) => String(r[i] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const fill = (id, vals) => {
      $(id).innerHTML = "";
      vals.forEach((v) => { const o = document.createElement("option"); o.value = v; $(id).append(o); });
    };
    if (c.empreendimento >= 0) fill("#listaEmpreendimentos", uniq(c.empreendimento));
    if (c.cartorio >= 0) fill("#listaCartorios", uniq(c.cartorio));
  }

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    $("#tab-home").hidden = name !== "home";
    $("#tab-novo").hidden = name !== "novo";
    $("#tab-acompanhar").hidden = name !== "acompanhar";
    // Se a tela de "Pedido enviado" ainda estiver aberta, voltar pra Nova solicitação mostra o formulário limpo.
    if (name === "novo" && !$("#sucesso").hidden) resetForm();
    if (name === "acompanhar") renderLista();
    if (name === "home") loadTable().then(({ headers, rows }) => atualizarStats(headers, rows)).catch(() => {});
    window.scrollTo({ top: 0 });
  }

  // Abre o formulário já com o tipo escolhido no atalho da tela inicial.
  function abrirNovo(tipo) {
    showTab("novo");
    const primeiro = $(".item", itensEl);
    const radio = primeiro && [...primeiro.querySelectorAll('input[type="radio"]')].find((r) => r.value === tipo);
    if (radio) radio.click();
  }

  // "Pedidos em andamento" = tudo que ainda não está FINALIZADO.
  function atualizarStats(headers, rows) {
    const c = colIndex(headers);
    if (c.status < 0) return;
    const n = rows.filter((r) => r[c.empreendimento] && !String(r[c.status] ?? "").toUpperCase().includes("FINALIZ")).length;
    $("#statAndamento").textContent = n;
  }

  // Pré-seleciona o solicitante pelo e-mail de login (ex: victor.martins@... → "Victor Martins"),
  // ou pela última escolha salva neste navegador.
  function guessSolicitante() {
    let last = null;
    try { last = localStorage.getItem("agroturn-solicitante"); } catch {}
    if (last && CFG.solicitantes.includes(last)) return last;
    const local = norm(sessaoEmail).split("@")[0];
    if (!local) return "";
    const palavras = local.split(/[._-]+/).filter(Boolean);
    const completo = CFG.solicitantes.filter((s) => norm(s).split(" ").every((w) => palavras.includes(w)));
    const candidatos = completo.length ? completo : CFG.solicitantes.filter((s) => norm(s).split(" ")[0] === palavras[0]);
    return candidatos.length === 1 ? candidatos[0] : "";
  }

  function renderUser() {
    const area = $("#userArea");
    if (DEMO) { area.innerHTML = `<span class="muted small">Demonstração</span>`; return; }
    area.innerHTML = `<span class="name"></span><button class="btn ghost small" id="logoutBtn">Sair</button>`;
    const nome = guessSolicitante() || String(sessaoEmail || "").split("@")[0];
    $(".name", area).textContent = nome ? `Olá, ${nome}` : "";
    $("#logoutBtn").addEventListener("click", sair);
  }

  function startApp() {
    $("#loginView").hidden = true;
    $("#appView").hidden = false;
    document.body.classList.add("logado");
    renderUser();

    const sel = $("#solicitante");
    const filtro = $("#filtroSolicitante");
    CFG.solicitantes.forEach((s) => {
      sel.add(new Option(s, s));
      filtro.add(new Option(s, s));
    });
    const quem = guessSolicitante();
    sel.value = quem;
    filtro.value = quem;

    addItem();
    loadTable().then(({ headers, rows }) => { fillSuggestions(headers, rows); atualizarStats(headers, rows); }).catch((err) => console.warn(err));

    $("#addItem").addEventListener("click", () => $(".numero", addItem())?.closest(".item").scrollIntoView({ behavior: "smooth", block: "nearest" }));
    $("#pedidoForm").addEventListener("submit", onSubmit);
    const clearInvalid = (e) => e.target.classList.remove("invalid");
    $("#pedidoForm").addEventListener("input", clearInvalid);
    $("#pedidoForm").addEventListener("change", clearInvalid);
    $("#novoPedido").addEventListener("click", resetForm);
    $("#verPedidos").addEventListener("click", () => { resetForm(); showTab("acompanhar"); });
    $("#copyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#protocoloOut").textContent); $("#copyBtn").textContent = "Copiado!"; } catch {}
      setTimeout(() => ($("#copyBtn").textContent = "Copiar"), 1500);
    });
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
    document.querySelectorAll("[data-novo]").forEach((b) => b.addEventListener("click", () => abrirNovo(b.dataset.novo)));
    document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
      // "Meus pedidos" filtra pelo solicitante escolhido; "Todos os pedidos" mostra tudo.
      $("#filtroSolicitante").value = b.dataset.go === "meus" ? $("#solicitante").value : "";
      showTab("acompanhar");
    }));
    $("#brandHome").addEventListener("click", (e) => { e.preventDefault(); showTab("home"); });
    $("#filtroSolicitante").addEventListener("change", () => renderLista());
    let debounce;
    $("#filtroBusca").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => renderLista(), 200); });
    $("#refreshBtn").addEventListener("click", () => renderLista(true));
  }

  function pedirLogin(erro) {
    $("#loginView").hidden = false;
    $("#loginError").hidden = !erro;
    if (erro) $("#loginError").textContent = erro;
    const limpar = () => { $("#loginEmail").classList.remove("invalid"); $("#loginSenha").classList.remove("invalid"); $("#loginError").hidden = true; };
    $("#loginEmail").addEventListener("input", limpar);
    $("#loginSenha").addEventListener("input", limpar);
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = norm($("#loginEmail").value);
      const senha = $("#loginSenha").value;
      if (!email.endsWith("@" + domEmail)) {
        $("#loginError").textContent = `Use seu e-mail @${domEmail}.`;
        $("#loginError").hidden = false;
        $("#loginEmail").classList.add("invalid");
        return;
      }
      const btn = $("#loginBtn");
      btn.disabled = true;
      btn.textContent = "Entrando…";
      try {
        await fazerLogin(email, senha);
        startApp();
      } catch (err) {
        $("#loginError").textContent = err.message;
        $("#loginError").hidden = false;
        $("#loginSenha").classList.add("invalid");
      } finally {
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });
  }

  // ---------- Início ----------
  (async () => {
    if (DEMO) {
      $("#demoBanner").hidden = false;
      startApp();
      return;
    }
    const token = getStoredToken();
    const email = token && emailDoToken(token);
    if (email) {
      sessaoEmail = email;
      startApp();
      // Renova o login em segundo plano: enquanto a pessoa usar o site, ele nunca expira.
      // Se falhar por falta de rede, segue com o login atual; se a API recusar (ex.: e-mail
      // removido da lista), api() já derruba a sessão e volta pra tela de login.
      api("/api/refresh", { method: "POST" }).then((d) => setStoredToken(d.token)).catch(() => {});
    } else {
      clearStoredToken();
      pedirLogin();
    }
  })();
})();
