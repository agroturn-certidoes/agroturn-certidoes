// Configuração do site de Solicitação de Certidões — Agroturn
// Edite apenas este arquivo para ajustar o comportamento do site.
window.APP_CONFIG = {
  // Endereço da API (worker/) que fala com a planilha.
  // Deixe vazio ("") para rodar em MODO DEMONSTRAÇÃO (salva só no navegador).
  apiBase: "https://agroturn-certidoes-api.agroturn-certidoes.workers.dev",

  // Dias de validade da certidão, contados a partir de quando ela chega (status FINALIZADO).
  diasValidade: 30,

  // Domínio de e-mail da empresa — só decide o texto de aviso na tela de login.
  // Quem realmente autoriza é a lista de e-mails configurada na API (worker/wrangler.toml + secret).
  dominioEmail: "agroturn.com.br",

  // Valor gravado na coluna "Status" de cada novo pedido: EM BRANCO de propósito — o Fundiário escolhe
  // a etapa na planilha. (Só vale no modo demonstração; no modo real quem grava é a API — STATUS_INICIAL.)
  statusInicial: "",

  // O que cada etapa quer dizer (aparece embaixo do status em "Acompanhar pedidos").
  // Chaves em MAIÚSCULAS, como estão na planilha. Pedido sem status aparece como "NOVO".
  statusDescricoes: {
    "NOVO": "Recebido — o Fundiário ainda vai dar andamento.",
    "AGUARDANDO TAXA": "Aguardando o cartório informar o valor da taxa.",
    "AGUARDANDO PAGAMENTO": "Boleto enviado — aguardando o pagamento.",
    "AGUARDANDO PEDIDO": "Pago — aguardando a certidão chegar.",
    "FINALIZADO": "Certidão entregue.",
  },

  // true = "12345;78456" vira uma linha por número.
  separarNumeros: true,

  // Fuso usado na coluna Data (a planilha registra data e hora do pedido).
  timeZone: "America/Cuiaba",

  tiposCertidao: ["Matrícula", "Cadeia Dominial", "Transcrição"],

  solicitantes: [
    "Anna", "Aurora", "Camila", "Caroline", "Evelin", "Erika", "Gabrielly",
    "Isabella", "Keli", "Léo", "Luis", "Maísa", "Maria Clara",
    "Victor Martins", "Victor Gonçalves", "Vitória", "Yuri",
  ],
};
