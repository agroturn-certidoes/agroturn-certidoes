// Configuração do site de Solicitação de Certidões — Agroturn
// Edite apenas este arquivo para ajustar o comportamento do site.
window.APP_CONFIG = {
  // ID do aplicativo (client) registrado no Microsoft Entra ID.
  // Deixe vazio ("") para rodar em MODO DEMONSTRAÇÃO (salva só no navegador, não grava na planilha).
  clientId: "",

  // Locatário (tenant) Microsoft 365 da Agroturn.
  tenantId: "dab95a95-89a3-41a2-b053-f4f88b513953",

  // Arquivo "Controle de Certidões - RI Ditigital.xlsx" no SharePoint (site Agroturn).
  driveId: "b!x18PLiznRkepMx7QItAI0M_XmqvkJp1MnIWn2uOO-UCJGnZo60jYR7phsMb5tPGD",
  itemId: "01UQHUCRED3ZSZMLLY6RFLN222BYAHTHRL",

  // Aba e tabela onde as linhas são adicionadas.
  worksheet: "Controle de Certidão",
  tableName: "", // vazio = usa a primeira tabela da aba acima

  // Valor gravado na coluna "Status" de cada novo pedido.
  // Como o pedido acabou de chegar (o Fundiário ainda não solicitou no RI Digital),
  // o padrão é "AGUARDANDO PEDIDO". Troque aqui se o fluxo de vocês usar outro valor inicial.
  statusInicial: "AGUARDANDO PEDIDO",

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
