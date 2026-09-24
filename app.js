(() => {
  const CFG = window.APP_CONFIG;
  const DEMO = !CFG.apiBase;
  const DIAS_VALIDADE = CFG.diasValidade || 30; // a certidão vale 30 dias a partir de quando chega (FINALIZADO)
  const OBS_HINTS = {
    "Transcrição": "Informe folhas, livro e data da transcrição.",
    "Cadeia Dominial": "A cadeia é pedida até a origem. Se quiser até uma data específica, informe aqui.",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const domEmail = norm(CFG.dominioEmail).replace(/^@/, "");
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v === null ? padrao : JSON.parse(v); } catch { return padrao; } };
  const apagar = (k) => { try { localStorage.removeItem(k); } catch {} };

  let cache = null; // { headers, rows, finalizados, offline?, em? }

  // ---------- Sessão (a API confere e-mail + senha e devolve um token) ----------
  const TOKEN_KEY = "agroturn-token";
  const getStoredToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setStoredToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} };
  const clearStoredToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} };

  // Só lê e-mail e nome de dentro do token pra mostrar na tela — quem confere de verdade é a API.
  function dadosDoToken(token) {
    try {
      const bytes = Uint8Array.from(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes)); // UTF-8: nomes com acento
      if (payload.exp < Date.now() / 1000) return null;
      return { email: payload.email, nome: payload.nome || "" };
    } catch {
      return null;
    }
  }

  let sessaoEmail = null;
  let sessaoNome = "";

  async function fazerLogin(email, senha) {
    let res;
    try {
      res = await fetch(`${CFG.apiBase}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: senha }),
      });
    } catch {
      throw new Error("Sem conexão com a internet. Tente de novo quando o sinal voltar.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Não foi possível entrar.");
    setStoredToken(data.token);
    sessaoEmail = email;
    sessaoNome = data.nome || "";
  }

  // Quem está pedindo, sem precisar escolher: vem do e-mail de login (a API devolve o nome; se não vier,
  // montamos do e-mail). Depois acertamos acentos e grafia pela lista de nomes conhecidos
  // (ex.: "Maisa" -> "Maísa", igual ao que já está na planilha).
  function nomeSolicitante() {
    if (DEMO) return "Demonstração";
    const local = String(sessaoEmail || "").split("@")[0];
    const doEmail = local.split(/[._-]+/).map((p) => p.replace(/\d+/g, "")).filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
    const nome = sessaoNome || doEmail;
    const exato = CFG.solicitantes.find((s) => norm(s) === norm(nome));
    if (exato) return exato;
    if (norm(nome) !== norm(doEmail)) return nome; // nome escrito de propósito na lista da API: respeita
    // Nome montado do e-mail: tenta casar com a lista ("keli.silva" -> "Keli"), só se for inequívoco.
    const palavras = norm(nome).split(" ");
    const completos = CFG.solicitantes.filter((s) => norm(s).split(" ").every((w) => palavras.includes(w)));
    if (completos.length === 1) return completos[0];
    const porPrimeiro = CFG.solicitantes.filter((s) => norm(s).split(" ")[0] === palavras[0]);
    return porPrimeiro.length === 1 ? porPrimeiro[0] : nome;
  }

  function sair() {
    clearStoredToken();
    location.reload();
  }

  // ---------- Acesso à planilha (via API própria) ----------
  async function api(path, options = {}) {
    const token = getStoredToken();
    let res;
    try {
      res = await fetch(`${CFG.apiBase}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
      });
    } catch {
      const e = new Error("Sem conexão com a internet.");
      e.offline = true; // não chegou na API (diferente de a API recusar)
      throw e;
    }
    if (res.status === 401) {
      clearStoredToken();
      location.reload();
      throw new Error("Sessão expirada.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // Última planilha lida fica guardada: sem internet ainda dá pra consultar (com aviso).
  const TABELA_KEY = "agroturn-tabela";

  async function loadTable(force = false) {
    if (cache && !force) return cache;
    if (DEMO) {
      cache = { headers: DEMO_HEADERS, rows: readDemo(), finalizados: {} };
      return cache;
    }
    try {
      const t = await api("/api/table");
      cache = { headers: t.headers, rows: t.rows, finalizados: t.finalizados || {} };
      guardar(TABELA_KEY, { em: Date.now(), tabela: cache });
    } catch (err) {
      const salva = err.offline ? ler(TABELA_KEY, null) : null;
      if (!salva) throw err;
      cache = { ...salva.tabela, offline: true, em: salva.em };
    }
    return cache;
  }

  // Modo demonstração: mesmas colunas da planilha, salvo no navegador.
  const DEMO_HEADERS = ["Id", "Protocolo", "Data", "Solicitante", "Nome do empreendimento", "Tipo de Certidão",
    "Nº da Matrícula/Transcrição", "Observações", "Cartório Responsável", "Responsável", "Status", "Recibo"];
  const DEMO_KEY = "agroturn-certidoes-demo";
  const readDemo = () => ler(DEMO_KEY, []);
  const writeDemo = (rows) => guardar(DEMO_KEY, rows);

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
      // Opcional: se a planilha tiver essa coluna preenchida, ela vale mais que o registro automático.
      finalizadoEm: find("Finalizado em", "Data de finalização", "Data de finalizacao", "Data de chegada"),
    };
  }

  // ---------- Data e hora ----------
  // O Protocolo NÃO é gerado pelo site: é o número que o RI Digital (ONR) gera quando o
  // Fundiário faz o pedido lá, e é digitado na planilha manualmente depois. O site deixa
  // essa coluna em branco.
  // Data+hora no fuso da empresa como número de data do Excel (dias desde 1899-12-30, hora na fração).
  function serialDe(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: CFG.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]));
    const dias = (Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(1899, 11, 30)) / 86400000;
    return dias + (+p.hour * 3600 + +p.minute * 60 + +p.second) / 86400;
  }
  // Valor de célula de data (número do Excel ou texto dd/mm/aaaa) -> número do Excel, ou null.
  function serialDeCelula(v) {
    if (typeof v === "number" && v > 1) return v;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? "").trim());
    return m ? (Date.UTC(+m[3], +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 86400000 : null;
  }
  const diaDe = (serial) =>
    new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toLocaleDateString("pt-BR", { timeZone: "UTC" });
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

  // ---------- Certidão repetida: já pedida? já chegou? ainda vale? ----------
  const numKey = (s) => norm(s).replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, ""); // "3.035" = "3035"
  const cartKey = (s) => norm(s).replace(/[^a-z0-9]/g, "");                            // "1º Ofício de Cuiabá-MT" = "1 oficio de cuiaba mt"
  const mesmoCartorio = (a, b) => a === b || (Math.min(a.length, b.length) >= 8 && (a.startsWith(b) || b.startsWith(a)));
  const ehFinalizado = (status) => String(status ?? "").toUpperCase().includes("FINALIZ");

  // Quando a certidão chegou: coluna "Finalizado em" da planilha (se existir e estiver preenchida)
  // ou o momento que a API registrou quando o status virou FINALIZADO.
  function finalizacaoSerial(row, c, finalizados) {
    if (c.finalizadoEm >= 0) {
      const s = serialDeCelula(row[c.finalizadoEm]);
      if (s !== null) return s;
    }
    const iso = finalizados?.[String(row[c.id])];
    return iso ? serialDe(new Date(iso)) : null;
  }

  // Situação de uma linha FINALIZADA: { fim (último dia de validade), vigente } — ou null se a data é desconhecida.
  function vigencia(row, c, finalizados) {
    const fin = finalizacaoSerial(row, c, finalizados);
    if (fin === null) return null;
    const fim = fin + DIAS_VALIDADE;
    return { fin, fim, vigente: serialDe(new Date()) <= fim };
  }

  function conflitosDe(cand, tabela) {
    if (!tabela) return [];
    const c = colIndex(tabela.headers);
    const nk = numKey(cand.numero);
    if (c.tipo < 0 || c.numero < 0 || !nk) return [];
    const ck = cartKey(cand.cartorio);
    const achados = [];
    for (const r of tabela.rows) {
      if (norm(r[c.tipo]) !== norm(cand.tipo)) continue;
      const numeros = String(r[c.numero] ?? "").split(/[;\n]+/).map(numKey).filter(Boolean); // há linhas antigas com vários números
      if (!numeros.includes(nk)) continue;
      const finalizado = ehFinalizado(r[c.status]);
      achados.push({
        forte: c.cartorio < 0 || !ck || mesmoCartorio(cartKey(r[c.cartorio]), ck),
        id: Number(r[c.id]) || 0,
        status: String(r[c.status] ?? "").trim(),
        finalizado,
        pedidoEm: serialDeCelula(r[c.data]),
        vig: finalizado ? vigencia(r, c, tabela.finalizados) : null,
        solicitante: String(r[c.solicitante] ?? "").trim(),
        empreendimento: String(r[c.empreendimento] ?? "").trim(),
        cartorio: String(r[c.cartorio] ?? "").trim(),
      });
    }
    return achados.sort((a, b) => b.id - a.id).slice(0, 3).map(classificar);
  }

  // nivel "alerta" = provável duplicidade (pede confirmação); "info" = só bom saber.
  function classificar(a) {
    const quando = a.pedidoEm !== null ? diaDe(a.pedidoEm) : "data desconhecida";
    const quem = `${a.solicitante || "alguém"}${a.empreendimento ? ` — ${a.empreendimento}` : ""}`;
    if (!a.forte) {
      return { nivel: "info", texto: `Mesmo número em outro cartório (${a.cartorio || "?"}): ${a.status || "sem status"}, pedido em ${quando} por ${quem}.` };
    }
    if (!a.finalizado) {
      return { nivel: "alerta", texto: `Já existe pedido em andamento (${a.status || "sem status"}), feito em ${quando} por ${quem}.` };
    }
    if (a.vig) {
      if (a.vig.vigente) {
        const restam = Math.ceil(a.vig.fim - serialDe(new Date()));
        return { nivel: "alerta", texto: `A certidão já chegou em ${diaDe(a.vig.fin)} e vale até ${diaDe(a.vig.fim)} (${restam <= 0 ? "último dia" : `${restam} dia${restam > 1 ? "s" : ""}`}). Pedido de ${quem}.` };
      }
      return { nivel: "info", texto: `Já houve certidão finalizada em ${diaDe(a.vig.fin)}; venceu em ${diaDe(a.vig.fim)}. Pode pedir de novo.` };
    }
    // FINALIZADO, mas ninguém registrou quando a certidão chegou: usa a data do pedido como referência.
    if (a.pedidoEm !== null && serialDe(new Date()) - a.pedidoEm <= DIAS_VALIDADE) {
      return { nivel: "alerta", texto: `Já finalizada (pedido de ${quando}, ${quem}). A data de chegada não foi registrada, então pode ainda estar vigente.` };
    }
    return { nivel: "info", texto: `Já finalizada (pedido de ${quando}, ${quem}). Confira se a certidão ainda está no prazo.` };
  }

  function conflitosDoPedido(pedido, tabela) {
    const out = [];
    const vistos = new Set();
    for (const it of pedido.itens) {
      for (const numero of it.numeros) {
        const k = `${norm(it.tipo)}|${numKey(numero)}|${cartKey(it.cartorio)}`;
        if (vistos.has(k)) out.push({ nivel: "alerta", rotulo: `${it.tipo} ${numero}`, texto: "Está repetida dentro deste mesmo pedido." });
        vistos.add(k);
        for (const x of conflitosDe({ tipo: it.tipo, numero, cartorio: it.cartorio }, tabela)) {
          out.push({ ...x, rotulo: `${it.tipo} ${numero}` });
        }
      }
    }
    return out;
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
    $(".remove", node).addEventListener("click", () => { node.remove(); renumber(); salvarRascunho(); });
    let t;
    node.addEventListener("input", () => { updateLinhas(); clearTimeout(t); t = setTimeout(() => atualizarDup(node), 300); });
    node.addEventListener("change", () => atualizarDup(node));
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

  // Aviso embaixo de cada certidão assim que tipo + número + cartório estiverem preenchidos.
  function atualizarDup(node) {
    const el = $(".dup", node);
    const it = readItens().find((x) => x.el === node);
    if (!cache || !it || !it.tipo || !it.numeros.length || !it.cartorio) { el.hidden = true; return; }
    const lista = it.numeros.flatMap((numero) =>
      conflitosDe({ tipo: it.tipo, numero, cartorio: it.cartorio }, cache).map((x) => ({ ...x, numero })));
    el.hidden = !lista.length;
    el.innerHTML = lista.map((x) => `<p class="${x.nivel}"><strong>${esc(it.numeros.length > 1 ? `Nº ${x.numero}: ` : "")}</strong>${esc(x.texto)}</p>`).join("");
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

  // ---------- Rascunho: o que foi digitado não se perde se a tela fechar ----------
  const RASCUNHO_KEY = "agroturn-rascunho";
  let rascunhoTimer;
  function salvarRascunho() {
    clearTimeout(rascunhoTimer);
    rascunhoTimer = setTimeout(() => {
      const itens = readItens().map((it) => ({ tipo: it.tipo, numero: $(".numero", it.el).value, cartorio: it.cartorio, obs: it.obs }));
      const vazio = !$("#empreendimento").value.trim() && itens.every((i) => !i.tipo && !i.numero.trim() && !i.cartorio && !i.obs);
      if (vazio) apagar(RASCUNHO_KEY); else guardar(RASCUNHO_KEY, { empreendimento: $("#empreendimento").value, itens });
    }, 400);
  }
  function restaurarRascunho() {
    const r = ler(RASCUNHO_KEY, null);
    if (!r?.itens?.length) return;
    $("#empreendimento").value = r.empreendimento || "";
    itensEl.innerHTML = "";
    r.itens.forEach((d) => {
      const n = addItem();
      const radio = [...n.querySelectorAll('input[type="radio"]')].find((x) => x.value === d.tipo);
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
      $(".numero", n).value = d.numero || "";
      $(".cartorio", n).value = d.cartorio || "";
      $(".observacoes", n).value = d.obs || "";
    });
    updateLinhas();
    toast("Recuperei o pedido que você estava preenchendo");
  }

  // ---------- Envio ----------
  const novaChave = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let chaveAtual = null; // mesma chave até o pedido ser enviado: reenviar nunca grava duas vezes

  function coletarPedido() {
    chaveAtual = chaveAtual || novaChave();
    return {
      chave: chaveAtual,
      empreendimento: $("#empreendimento").value.trim(),
      solicitante: $("#solicitante").value, // a API confere que é mesmo a pessoa logada
      criadoEm: Date.now(),
      itens: readItens().map(({ tipo, numeros, cartorio, obs }) => ({ tipo, numeros, cartorio, obs })),
    };
  }

  // Modo demonstração: monta as linhas aqui mesmo (no modo real quem monta é a API).
  function gravarDemo(pedido) {
    const rows = readDemo();
    const c = colIndex(DEMO_HEADERS);
    const maxId = Math.max(0, ...rows.map((r) => Number(r[c.id]) || 0));
    const serial = serialDe(new Date(pedido.criadoEm));
    const novas = [];
    for (const it of pedido.itens) {
      for (const numero of it.numeros) {
        const row = DEMO_HEADERS.map(() => null);
        const set = (k, v) => { row[c[k]] = v; };
        set("id", maxId + novas.length + 1);
        set("data", serial);
        set("solicitante", pedido.solicitante);
        set("empreendimento", pedido.empreendimento);
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
    writeDemo([...rows, ...novas]);
    return { idIni: maxId + 1, idFim: maxId + novas.length, total: novas.length };
  }

  async function enviarPedido(pedido) {
    if (DEMO) return gravarDemo(pedido);
    return api("/api/pedidos", { method: "POST", body: JSON.stringify(pedido) });
  }

  const rotuloIds = (r) => (r.idIni === r.idFim ? `Nº ${r.idIni}` : `Nº ${r.idIni}–${r.idFim}`);

  function mostrarSucesso({ titulo, ref, resumo }) {
    $("#sucessoTitulo").textContent = titulo;
    $("#protocoloOut").textContent = ref;
    $("#sucessoResumo").textContent = resumo;
    $("#copyBtn").hidden = !/^Nº/.test(ref);
    $("#dupBox").hidden = true;
    $("#pedidoForm").hidden = true;
    $("#sucesso").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function onSubmit(e) {
    e.preventDefault();
    await tentarEnviar(false);
  }

  async function tentarEnviar(confirmado) {
    const errEl = $("#formError");
    errEl.hidden = true;
    if (!confirmado) $("#dupBox").hidden = true;
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
      const pedido = coletarPedido();

      // Confere de novo com a planilha mais recente antes de enviar (sem internet, usa a última que temos).
      if (!confirmado) {
        let tabela = null;
        try { tabela = await loadTable(true); } catch { tabela = cache; }
        const conflitos = conflitosDoPedido(pedido, tabela);
        if (conflitos.some((x) => x.nivel === "alerta")) { mostrarConflitos(conflitos); return; }
      }

      try {
        const r = await enviarPedido(pedido);
        cache = null;
        concluir();
        mostrarSucesso({
          titulo: "Pedido enviado",
          ref: rotuloIds(r),
          resumo: `${r.total} ${r.total > 1 ? "certidões registradas" : "certidão registrada"} para ${pedido.empreendimento}. ` +
            "O Setor Fundiário vai preencher o protocolo do RI Digital depois de solicitar no ONR.",
        });
      } catch (err) {
        if (!err.offline) throw err;
        // Sem sinal: guarda no aparelho e envia sozinho quando a internet voltar.
        guardarNaFila(pedido);
        concluir();
        mostrarSucesso({
          titulo: "Pedido guardado",
          ref: "Aguardando internet",
          resumo: `Sem conexão agora. O pedido de ${pedido.empreendimento} ficou guardado neste aparelho e será enviado automaticamente quando o sinal voltar.`,
        });
      }
    } catch (err) {
      console.error(err);
      errEl.textContent = `Não foi possível enviar o pedido: ${err.message}`;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar pedido";
    }
  }

  function concluir() { chaveAtual = null; apagar(RASCUNHO_KEY); }

  function mostrarConflitos(conflitos) {
    const box = $("#dupBox");
    box.querySelector(".dup-lista").innerHTML = conflitos
      .map((x) => `<li class="${x.nivel}"><strong>${esc(x.rotulo)}</strong> — ${esc(x.texto)}</li>`).join("");
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resetForm() {
    const solicitante = $("#solicitante").value;
    $("#pedidoForm").reset();
    $("#solicitante").value = solicitante;
    itensEl.innerHTML = "";
    addItem();
    chaveAtual = null;
    $("#formError").hidden = true;
    $("#dupBox").hidden = true;
    $("#sucesso").hidden = true;
    $("#pedidoForm").hidden = false;
  }

  // ---------- Fila de envio (sem internet) ----------
  const FILA_KEY = "agroturn-fila";
  const lerFila = () => ler(FILA_KEY, []);
  let enviandoFila = false;

  function guardarNaFila(pedido) {
    const fila = lerFila().filter((x) => x.pedido.chave !== pedido.chave);
    fila.push({ pedido, guardadoEm: Date.now() });
    guardar(FILA_KEY, fila);
    renderFila();
  }

  function renderFila() {
    const fila = lerFila();
    const bar = $("#filaBar");
    bar.hidden = !fila.length || !document.body.classList.contains("logado");
    $("#filaTxt").textContent = fila.length === 1
      ? "1 pedido aguardando internet — envio automático quando o sinal voltar."
      : `${fila.length} pedidos aguardando internet — envio automático quando o sinal voltar.`;
  }

  async function processarFila() {
    if (enviandoFila || DEMO || !lerFila().length) return;
    enviandoFila = true;
    const btn = $("#filaBtn");
    btn.disabled = true;
    let enviou = false;
    try {
      for (const item of lerFila()) {
        try {
          const r = await enviarPedido(item.pedido);
          guardar(FILA_KEY, lerFila().filter((x) => x.pedido.chave !== item.pedido.chave));
          enviou = true;
          toast(`Pedido de ${item.pedido.empreendimento} enviado (${rotuloIds(r)})`);
        } catch (err) {
          if (err.offline || !err.status || err.status >= 500) break; // tenta de novo depois
          // A API recusou (dados inválidos): não adianta insistir.
          guardar(FILA_KEY, lerFila().filter((x) => x.pedido.chave !== item.pedido.chave));
          toast(`Um pedido guardado foi recusado: ${err.message}`);
        }
      }
    } finally {
      enviandoFila = false;
      btn.disabled = false;
      renderFila();
      if (enviou) {
        cache = null;
        if (!$("#tab-acompanhar").hidden) renderLista(true);
        else if (!$("#tab-home").hidden) loadTable(true).then((t) => atualizarStats(t.headers, t.rows)).catch(() => {});
      }
    }
  }

  // ---------- UI: acompanhar ----------
  const STATUS_CLASS = [["TAXA", "taxa"], ["PAGAMENTO", "pagamento"], ["PEDIDO", "st-pedido"], ["FINALIZ", "finalizado"]];
  const statusClass = (s) => (STATUS_CLASS.find(([k]) => String(s).toUpperCase().includes(k)) || [, ""])[1];

  async function renderLista(force = false) {
    const lista = $("#listaPedidos");
    lista.innerHTML = `<div class="sk" aria-label="Carregando"></div><div class="sk"></div><div class="sk"></div>`;
    try {
      const tabela = await loadTable(force);
      const { headers, rows } = tabela;
      $("#offlineAviso").hidden = !tabela.offline;
      if (tabela.offline) {
        $("#offlineAviso").textContent = `Sem conexão — mostrando o que foi carregado em ${new Date(tabela.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.`;
      }
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

      // Pedidos guardados no aparelho (ainda sem internet) aparecem primeiro.
      const pendentes = lerFila().map(({ pedido }) => {
        const n = pedido.itens.reduce((a, i) => a + i.numeros.length, 0);
        return `<article class="pedido pendente"><div class="pedido-head"><div><strong>Aguardando envio</strong> · ${esc(pedido.empreendimento)}</div>` +
          `<div class="meta">${n} ${n > 1 ? "certidões" : "certidão"} · guardado no aparelho</div></div></article>`;
      }).join("");

      // Agrupa por pedido (mesmo minuto + solicitante + empreendimento), mais recentes primeiro.
      // Não agrupa por Protocolo: ele é preenchido manualmente depois e pode faltar ou ser diferente por linha.
      const grupos = new Map();
      filtradas.forEach((r) => {
        const k = chaveAgrupamento(r[c.data], r[c.solicitante], r[c.empreendimento]);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(r);
      });
      const ordenados = [...grupos.values()].sort((a, b) => (Number(a[0][c.id]) || 0) - (Number(b[0][c.id]) || 0)).reverse().slice(0, 100);
      if (!ordenados.length && !pendentes) {
        lista.innerHTML = `<div class="empty">Nenhum pedido encontrado.</div>`;
        return;
      }
      lista.innerHTML = pendentes + ordenados.map((rs) => {
        const f = rs[0];
        const ids = rs.map((r) => r[c.id]).filter((v) => v != null);
        const idLabel = ids.length > 1 ? `Nº ${Math.min(...ids)}–${Math.max(...ids)}` : `Nº ${ids[0] ?? "—"}`;
        const linhas = rs.map((r) => {
          const v = ehFinalizado(r[c.status]) ? vigencia(r, c, tabela.finalizados) : null;
          const vig = v ? `<span class="vig ${v.vigente ? "ok" : "vencida"}">${v.vigente ? `Vale até ${diaDe(v.fim)}` : `Venceu em ${diaDe(v.fim)}`}</span>` : "";
          return `
          <tr>
            <td>${esc(r[c.tipo])} · <strong>${esc(r[c.numero])}</strong>${r[c.obs] ? `<br><span class="muted small">${esc(r[c.obs])}</span>` : ""}
              ${r[c.protocolo] ? `<br><span class="muted small">Protocolo RI Digital: ${esc(r[c.protocolo])}</span>` : ""}</td>
            <td class="cart">${esc(r[c.cartorio])}</td>
            <td class="status"><span class="badge ${statusClass(r[c.status])}">${esc(r[c.status] || "—")}</span>${vig}</td>
          </tr>`;
        }).join("");
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
    // Menu do cabeçalho (computador) e barra de baixo (celular) andam juntos.
    document.querySelectorAll("[data-tab]").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    });
    fecharMenuConta();
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
    const n = rows.filter((r) => r[c.empreendimento] && !ehFinalizado(r[c.status])).length;
    $("#statAndamento").textContent = n;
  }

  // Avatar com as iniciais; toque abre o menu da conta (nome, e-mail, avisos e Sair).
  function iniciais(nome) {
    const p = String(nome).trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }

  function fecharMenuConta() {
    $("#userMenu").hidden = true;
    $("#avatarBtn").setAttribute("aria-expanded", "false");
  }

  function renderUser() {
    const nome = nomeSolicitante();
    $("#avatarBtn").textContent = iniciais(nome);
    $("#umNome").textContent = nome;
    $("#umEmail").textContent = DEMO ? "Modo demonstração" : sessaoEmail || "";
    $("#logoutBtn").hidden = DEMO; // sem login não há o que sair
    $("#avatarBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const abrir = $("#userMenu").hidden;
      $("#userMenu").hidden = !abrir;
      $("#avatarBtn").setAttribute("aria-expanded", String(abrir));
      if (abrir) atualizarPushUI();
    });
    $("#logoutBtn").addEventListener("click", sair);
    document.addEventListener("click", (e) => { if (!e.target.closest("#userArea")) fecharMenuConta(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharMenuConta(); });
  }

  // Aviso rápido no rodapé ("Copiado!" etc.)
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  // ---------- Avisos no celular/computador (notificações) ----------
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalado = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSuportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const b64urlParaBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

  async function inscricaoAtual() {
    const reg = await navigator.serviceWorker.ready;
    return { reg, sub: await reg.pushManager.getSubscription() };
  }

  async function atualizarPushUI() {
    const area = $("#pushArea");
    if (DEMO || !CFG.vapidPublicKey) { area.hidden = true; return; }
    area.hidden = false;
    const btn = $("#pushBtn"), teste = $("#pushTeste"), dica = $("#pushDica");
    if (!pushSuportado()) {
      btn.hidden = teste.hidden = true;
      dica.textContent = ehIOS && !instalado()
        ? "No iPhone, instale o app na Tela de Início (Compartilhar → Adicionar à Tela de Início) para receber avisos."
        : "Este navegador não permite avisos.";
      return;
    }
    if (Notification.permission === "denied") {
      btn.hidden = teste.hidden = true;
      dica.textContent = "Os avisos estão bloqueados nas configurações do navegador para este site.";
      return;
    }
    const { sub } = await inscricaoAtual();
    btn.hidden = false;
    btn.textContent = sub ? "Desativar avisos neste aparelho" : "Ativar avisos neste aparelho";
    teste.hidden = !sub;
    dica.textContent = sub ? "Você recebe aviso quando um pedido seu muda de etapa." : "Receba aviso quando o pedido muda de etapa ou a certidão chega.";
  }

  async function alternarPush() {
    const btn = $("#pushBtn");
    btn.disabled = true;
    try {
      const { reg, sub } = await inscricaoAtual();
      if (sub) {
        await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
        await sub.unsubscribe();
        toast("Avisos desativados neste aparelho");
      } else {
        if ((await Notification.requestPermission()) !== "granted") { toast("Sem permissão, não dá para ativar os avisos"); return; }
        const nova = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlParaBytes(CFG.vapidPublicKey) });
        await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: nova.toJSON(), nome: nomeSolicitante() }) });
        toast("Avisos ativados");
      }
    } catch (err) {
      toast(err.offline ? "Sem internet agora. Tente de novo em instantes." : `Não foi possível: ${err.message}`);
    } finally {
      btn.disabled = false;
      atualizarPushUI();
    }
  }

  async function testarPush() {
    try {
      const r = await api("/api/push/teste", { method: "POST", body: "{}" });
      const dica = $("#pushDica");
      if (!r.configurado) {
        dica.textContent = "A chave dos avisos (VAPID_PRIVATE_JWK) não está cadastrada na API.";
      } else if (!r.tentativas) {
        dica.textContent = "A API não tem este aparelho inscrito. Desative e ative os avisos de novo.";
      } else if (r.enviados === r.tentativas) {
        dica.textContent = "Aviso enviado. Se não aparecer, veja se as notificações do navegador/Windows não estão silenciadas.";
      } else {
        const f = r.falhas[0] || {};
        dica.textContent = `O serviço de avisos recusou (código ${f.status}${f.servico ? ` · ${f.servico}` : ""}): ${f.texto || "sem detalhe"}`;
        console.warn("aviso de teste falhou", r);
      }
      toast(r.enviados ? "Aviso de teste enviado" : "O aviso de teste não foi entregue — veja o motivo no menu");
    } catch (err) {
      toast(`Não foi possível: ${err.message}`);
    }
  }

  // Instalar como app: Chrome/Android/computador oferecem um botão; no iPhone só existe o caminho manual.
  let promptInstalar = null;
  const dispensouInstalar = () => ler("agroturn-instalar", "") === "nao";
  function mostrarInstalar() {
    if (instalado() || dispensouInstalar()) return;
    if (ehIOS) {
      $("#instalarDica").textContent = "Toque em Compartilhar e depois em “Adicionar à Tela de Início”.";
      $("#instalarBtn").hidden = true;
    } else if (!promptInstalar) return; // sem suporte: não mostra
    $("#instalar").hidden = false;
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    promptInstalar = e;
    if (!$("#appView").hidden) mostrarInstalar();
  });
  window.addEventListener("appinstalled", () => { promptInstalar = null; $("#instalar").hidden = true; });
  function iniciarInstalar() {
    $("#instalarBtn").addEventListener("click", async () => {
      if (!promptInstalar) return;
      promptInstalar.prompt();
      await promptInstalar.userChoice.catch(() => {});
      promptInstalar = null;
      $("#instalar").hidden = true;
    });
    $("#instalarFechar").addEventListener("click", () => {
      $("#instalar").hidden = true;
      guardar("agroturn-instalar", "nao");
    });
    mostrarInstalar();
  }

  function startApp() {
    $("#loginView").hidden = true;
    $("#appView").hidden = false;
    document.body.classList.add("logado");
    renderUser();
    iniciarInstalar();

    // O solicitante é quem entrou (não há mais o que escolher): fica fixo no formulário.
    const quem = nomeSolicitante();
    $("#solicitante").value = quem;
    $("#solicitanteNome").textContent = quem;

    // O filtro de "Acompanhar pedidos" continua com a lista de nomes (mais o de quem entrou, se for novo).
    const filtro = $("#filtroSolicitante");
    const nomes = CFG.solicitantes.includes(quem) ? CFG.solicitantes : [...CFG.solicitantes, quem];
    nomes.forEach((s) => filtro.add(new Option(s, s)));
    filtro.value = quem;

    addItem();
    restaurarRascunho();
    loadTable().then(({ headers, rows }) => {
      fillSuggestions(headers, rows);
      atualizarStats(headers, rows);
      [...itensEl.children].forEach(atualizarDup);
    }).catch((err) => console.warn(err));

    $("#addItem").addEventListener("click", () => { $(".numero", addItem())?.closest(".item").scrollIntoView({ behavior: "smooth", block: "nearest" }); });
    $("#pedidoForm").addEventListener("submit", onSubmit);
    const clearInvalid = (e) => e.target.classList.remove("invalid");
    $("#pedidoForm").addEventListener("input", (e) => { clearInvalid(e); $("#dupBox").hidden = true; salvarRascunho(); });
    $("#pedidoForm").addEventListener("change", (e) => { clearInvalid(e); salvarRascunho(); });
    $("#dupRevisar").addEventListener("click", () => { $("#dupBox").hidden = true; });
    $("#dupEnviar").addEventListener("click", () => tentarEnviar(true));
    $("#novoPedido").addEventListener("click", resetForm);
    $("#verPedidos").addEventListener("click", () => { resetForm(); showTab("acompanhar"); });
    $("#copyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#protocoloOut").textContent); toast("Número copiado"); } catch { toast("Não foi possível copiar"); }
    });
    document.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
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
    $("#pushBtn").addEventListener("click", alternarPush);
    $("#pushTeste").addEventListener("click", testarPush);

    // Fila de envio: tenta ao abrir, quando a internet volta e quando o app volta para a tela.
    $("#filaBtn").addEventListener("click", processarFila);
    window.addEventListener("online", processarFila);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") processarFila(); });
    setInterval(processarFila, 60000);
    renderFila();
    processarFila();

    // Abriu por um aviso (ou link com #acompanhar): vai direto pra tela certa.
    const alvo = location.hash.slice(1);
    if (["novo", "acompanhar"].includes(alvo)) showTab(alvo);
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.aba) showTab(e.data.aba); });
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
    const dados = token && dadosDoToken(token);
    if (dados) {
      sessaoEmail = dados.email;
      sessaoNome = dados.nome;
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

  // Registra o service worker (instalar como app + abrir sem internet + avisos). Só em https ou localhost.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
