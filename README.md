# Solicitação de Certidões — Agroturn

Site para pedir certidões (matrícula, transcrição, cadeia dominial). Substitui o Microsoft Forms.
Cada pedido vira uma ou mais linhas na planilha **Controle de Certidões - RI Ditigital.xlsx**
(aba *Controle de Certidão*) no SharePoint. O Setor Fundiário continua trabalhando na planilha
normalmente (Responsável, Status, Recibo).

## Como é montado

Duas partes, publicadas em lugares diferentes:

- **Site** (`index.html`, `styles.css`, `app.js`, `config.js`) — só HTML/JS, hospedado no GitHub Pages.
  Quem acessa nunca vê nem toca na credencial da planilha.
- **API** (`worker/`) — um Cloudflare Worker (gratuito) que confere e-mail + senha e, se estiver certo,
  lê/grava na planilha usando uma credencial própria da Microsoft (não é a conta de ninguém — é só do
  robô). É a única peça que guarda segredos.

O login **não** é mais pela Microsoft: é e-mail (`@agroturn.com.br`) + uma senha da empresa, conferidos
pela API. Isso evita levar todo mundo pra tela de login da Microsoft — mas por trás, quem escreve na
planilha continua sendo uma aplicação Microsoft registrada (é preciso registrá-la, só que sem exigir que
cada pessoa faça login nela).

## O que o site faz

- **Nova solicitação**: solicitante, empreendimento e uma ou mais certidões no mesmo pedido.
  Números separados por `;` viram uma linha cada.
- **Acompanhar pedidos**: lista os pedidos da planilha, agrupados por solicitante + empreendimento +
  data/hora do envio (não por Protocolo — ele é digitado depois e pode faltar ou ser diferente por linha).
  Mostra o status atualizado pelo Fundiário. Tem filtro por solicitante e busca.
- **Solicitante automático**: vem do e-mail de login. `victor.martins@…` vira "Victor Martins"; o site acerta acentos e grafia pela lista `solicitantes` do `config.js` (`maisa@…` vira "Maísa", `keli.souza@…` vira "Keli", igual ao que já está na planilha). Se o e-mail não der o nome certo (ex.: `victor@…`, quando há dois Victors), escreva o nome na lista da API — veja `ALLOWED_EMAILS` abaixo.
- Login fica salvo neste navegador por 1 ano e se renova sozinho a cada visita — só pede de novo em navegador/computador novo, aba anônima ou depois de limpar os dados do navegador.
- Sugere empreendimentos e cartórios já usados na planilha (evita digitação diferente).

Colunas gravadas em cada linha nova:

| Coluna | Valor |
|---|---|
| Id | maior Id da tabela + 1 |
| Protocolo | **em branco** — é o número do RI Digital (ONR); o Fundiário digita na planilha depois de solicitar lá |
| Data | data e hora do envio (fuso de Cuiabá) |
| Solicitante | o nome de quem entrou, tirado do e-mail de login (não há mais o que escolher) |
| Nome do empreendimento, Tipo de Certidão, Nº da Matrícula/Transcrição, Observações, Cartório Responsável | preenchidos no site |
| Responsável | vazio (o Fundiário preenche com quem for solicitar no RI Digital) |
| Status | `AGUARDANDO PEDIDO` (ajustável em `config.js` — troque se o fluxo de vocês usar outro valor inicial) |
| Recibo | desmarcado |

Depois de enviado, o site mostra o **número do pedido** (a faixa de Id das linhas criadas, ex. `Nº 74–77`)
como referência — não um protocolo, já que ele ainda não existe nesse momento.

As colunas são encontradas **pelo nome do cabeçalho**, então mudar a ordem delas não quebra o site.
Renomear uma coluna quebra.

## Certidão repetida, avisos e envio sem internet

- **Aviso de certidão repetida.** Ao preencher tipo + número + cartório, o site confere a planilha
  (`3035` = `3.035`; entende linhas antigas com vários números). Se já existe pedido **em andamento** ou
  uma certidão **ainda vigente**, mostra um aviso amarelo e pede confirmação antes de enviar. Certidão
  vencida ou o mesmo número em outro cartório só aparecem como informação.
- **Validade de 30 dias.** Conta a partir de quando a certidão **chega** (status FINALIZADO), não da data do
  pedido. A planilha não guarda essa data, então a API confere a planilha a cada 5 minutos e registra o
  momento em que o status vira FINALIZADO. Em "Acompanhar pedidos" aparece "Vale até dd/mm" ou
  "Venceu em dd/mm". Pedidos que já estavam FINALIZADOS antes disso não têm a data de chegada; para eles
  o site usa a data do pedido como referência e diz que a data não foi registrada. Se quiser corrigir, crie na
  tabela a coluna **Finalizado em** e preencha (ela vale mais que o registro automático).
- **Avisos no celular/computador** (passo 3b): o Fundiário é avisado quando chega pedido novo e
  quem pediu é avisado quando o status muda (e quando a certidão chega). Cada pessoa liga no avatar →
  *Ativar avisos neste aparelho*. No iPhone só funciona com o app instalado na Tela de Início.
  Detalhes: quem envia o pedido **não** é avisado do próprio pedido (mesmo estando na lista do Fundiário);
  a mudança de status feita na planilha é percebida em até 5 minutos (agendamento) ou no máximo 1 minuto
  depois de alguém abrir o site. Depois de enviar, o site diz "O Setor Fundiário já foi avisado" quando
  algum aparelho recebeu. Para testar o aviso de mudança: envie um pedido, mude o status dele na planilha e
  espere.
- **Sem internet (na fazenda):** o pedido fica guardado no aparelho e sai sozinho quando o sinal volta
  (uma faixa avisa). O que a pessoa digita vira rascunho, recuperado se a tela fechar. A lista de
  acompanhamento mostra a última cópia, com aviso de "sem conexão".
- **Ids sem repetição:** quem grava na planilha é a API (uma gravação por vez), então dois envios ao mesmo
  tempo nunca recebem o mesmo Id. O navegador não escolhe mais nenhum valor da linha: Id, data, solicitante
  e status inicial são definidos pela API.
- **Coluna opcional "Enviado por":** se existir na tabela, a API grava o e-mail autenticado de quem enviou.

## Instalar como aplicativo (celular e computador)

O site é um PWA: dá para instalar e abrir como um app, em tela cheia, com o ícone da Agroturn.

- **Android (Chrome):** na tela inicial do site aparece "Instale o app" → **Instalar**. Ou menu ⋮ → *Instalar app*.
- **iPhone (Safari):** botão **Compartilhar** → *Adicionar à Tela de Início*.
- **Computador (Chrome/Edge):** ícone de instalar na barra de endereço.

No celular, o menu vira uma barra de abas embaixo (Início · Novo pedido · Acompanhar) e o botão
*Enviar pedido* fica sempre visível. O service worker (`sw.js`) guarda uma cópia das telas para abrir
mesmo sem internet — mas pedidos e a lista de acompanhamento sempre vão ao vivo pra planilha, então
sem internet o app abre e avisa que não conseguiu enviar/ler.

Arquivos do app: `manifest.webmanifest`, `sw.js` e `assets/` (ícones). Se trocar a logomarca,
gere de novo os ícones (192, 512 e o "maskable").

## Testar agora (modo demonstração)

Com `apiBase` vazio em `config.js`, o site roda sem login e salva os pedidos só no navegador.

```bash
node serve.js
```

Abra http://localhost:5500

## Colocar no ar de verdade

### 1. Publicar o site no GitHub Pages

1. Crie uma conta em https://github.com (gratuita, sem cartão) se ainda não tiver.
2. **New repository**: nome `agroturn-certidoes`, **Public**. **Create repository**.
3. No terminal, dentro da pasta do projeto:
   ```bash
   git remote add origin https://github.com/SEU-USUARIO/agroturn-certidoes.git
   git push -u origin main
   ```
   No primeiro `push`, o Git abre o navegador pra você entrar com sua conta do GitHub.
4. No repositório, **Settings → Pages** → **Source: Deploy from a branch**, branch **main**, pasta
   **/ (root)** → **Save**.
5. Espere ~1 minuto: o link fixo do site aparece ali, algo como
   `https://SEU-USUARIO.github.io/agroturn-certidoes/`.
6. Sempre que os arquivos mudarem: `git add -A && git commit -m "..." && git push`.

### 2. Dar à aplicação uma credencial própria (sem depender do login de ninguém)

Isso usa o **mesmo registro de aplicativo** já criado no Entra ID (`Certidões Agroturn`), só que com um
tipo de permissão diferente — de "em nome de quem está logado" para "em nome do próprio aplicativo".

1. https://entra.microsoft.com → **Identidade → Aplicativos → Registros de aplicativo → Certidões Agroturn**
2. **Certificados e segredos → Novo segredo do cliente** → dê um nome (ex. "API") e prazo de expiração
   (ex. 24 meses) → **Adicionar**. Copie o **valor** do segredo agora — ele só aparece uma vez.
   **Não me envie esse valor.** Ele vai direto pro Cloudflare (passo 3), nunca pro código do site.
3. **Permissões de API → Adicionar uma permissão → Microsoft Graph → Permissões de aplicativo**
   (não "delegadas" desta vez) → busque `Files.ReadWrite.All` → **Adicionar permissões**.
4. **Conceder consentimento do administrador para Agroturn** → confirme.

> Isso dá ao aplicativo acesso amplo a arquivos do SharePoint da empresa (não só a essa planilha). Para
> uma empresa desse tamanho é um risco aceitável, mas se um dia quiser reduzir esse acesso só à pasta da
> planilha, me avise — dá pra trocar por uma permissão mais estreita (`Sites.Selected`), só dá mais um
> passo de configuração.

### 3. Publicar a API no Cloudflare Worker

1. Crie uma conta gratuita em https://dash.cloudflare.com/sign-up (sem cartão).
2. No computador, instale a ferramenta de linha de comando (uma vez):
   ```bash
   npm install -g wrangler
   ```
3. Entre com sua conta (abre o navegador):
   ```bash
   wrangler login
   ```
4. Dentro da pasta `worker/`, cadastre os segredos — cada comando vai perguntar o valor e
   **você digita direto no terminal**, eu nunca vejo:
   ```bash
   cd C:\Users\Agrot\Projetos\agroturn-certidoes\worker
   wrangler secret put GRAPH_CLIENT_SECRET
   wrangler secret put SHARED_PASSWORD
   wrangler secret put SESSION_SECRET
   wrangler secret put ALLOWED_EMAILS
   ```
   - `GRAPH_CLIENT_SECRET`: o valor copiado no passo 2.2.
   - `SHARED_PASSWORD`: a senha única que todo mundo vai usar pra entrar no site.
   - `SESSION_SECRET`: qualquer texto longo e aleatório (só para assinar o login) — pode gerar um com
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `ALLOWED_EMAILS`: a lista de e-mails autorizados, separados por vírgula, ex.
     `victor.martins@agroturn.com.br,keli@agroturn.com.br,...`. Quando o e-mail sozinho não dá o nome certo,
     escreva `e-mail=Nome`, ex. `victor@agroturn.com.br=Victor Gonçalves,maisa@agroturn.com.br=Maísa`.
5. Publique:
   ```bash
   wrangler deploy
   ```
   O terminal mostra a URL da API, algo como `https://agroturn-certidoes-api.SEU-USUARIO.workers.dev`.
6. **Me manda essa URL** — não é secreta. Eu coloco em `config.js` (`apiBase`) e publico.
7. Sempre que quiser trocar a senha, adicionar/remover alguém da lista, ou trocar a chave: repita o
   `wrangler secret put ...` correspondente e depois `wrangler deploy` de novo.

### 3b. Ativar os avisos (opcional)

O `wrangler deploy` do passo 3 já publica o "Estado" da API (grava pedidos em fila, guarda o histórico,
confere a planilha a cada 5 minutos e envia os avisos). A chave que identifica a Agroturn perante
Chrome/Safari/Firefox é criada e guardada pela própria API na primeira vez — não há nada para gerar,
copiar ou cadastrar. O que falta é dizer **quem recebe aviso de pedido novo** (o Fundiário), e-mails
separados por vírgula:

```bash
wrangler secret put FUNDIARIO_EMAILS
```
e depois \`wrangler deploy\`. Cada pessoa liga os avisos no próprio aparelho: avatar → *Ativar avisos neste
aparelho* (e permitir notificações quando o navegador perguntar). O botão *Enviar aviso de teste* mostra o
motivo quando algo falha. Se a permissão ficou **bloqueada** no navegador, é preciso liberar pelo cadeado
ao lado do endereço do site (Notificações → Permitir) — o site não consegue desbloquear sozinho.

(Se já existir o segredo antigo `VAPID_PRIVATE_JWK`, pode apagar: `wrangler secret delete VAPID_PRIVATE_JWK`.)

### 4. Aposentar o Forms

Depois de testar, **desative o recebimento de respostas** no Forms, mas não exclua o formulário.
A tabela da planilha (`OfficeForms.Table…`) foi criada pelo Forms. Desativar evita duas portas de
entrada, e não excluir preserva o vínculo com o histórico.

## Ajustes comuns (`config.js`)

- `solicitantes`: nomes conhecidos, com a grafia da planilha. Servem para acertar acentos do nome tirado do e-mail e para o filtro de "Acompanhar pedidos". Quem não estiver na lista continua conseguindo pedir (o nome sai do e-mail).
- `statusInicial`: status das linhas novas.
- `separarNumeros`: `false` para gravar `12345;78456` numa linha só.
- `tiposCertidao`: tipos disponíveis.
- `dominioEmail`: domínio mostrado/validado na tela de login (ex. `agroturn.com.br`). Quem realmente
  autoriza é a lista `ALLOWED_EMAILS` configurada no Worker (passo 3.4) — trocar aqui sem trocar lá não
  dá acesso a ninguém novo.

## Ajustes comuns (API, em `worker/`)

- Trocar a senha da empresa: `wrangler secret put SHARED_PASSWORD` de novo, depois `wrangler deploy`.
- Adicionar/remover alguém: `wrangler secret put ALLOWED_EMAILS` de novo (lista inteira, separada por
  vírgula), depois `wrangler deploy`.
- Essas trocas não pedem alteração no site — só no Worker.

## Segurança: o que essa senha compartilhada protege (e o que não protege)

Todo mundo usa a mesma senha. Isso é simples de manter, mas quer dizer que **qualquer pessoa com a senha
consegue enviar pedidos em nome de qualquer e-mail da lista** — não há como confirmar que foi realmente o
dono daquele e-mail. Para o uso interno de hoje (equipe pequena, de confiança) é um risco aceitável. Se um
dia isso incomodar, dá pra trocar por senha individual por pessoa, ou por um link de acesso enviado por
e-mail — me avise.

## Alternativa de hospedagem do site: Azure Static Web Apps

Se um dia a Agroturn tiver assinatura Azure (ou quiser um domínio próprio tipo `certidoes.agroturn.com.br`
sem depender do GitHub), dá para trocar a hospedagem do **site** sem mudar a API:

1. https://portal.azure.com → **Criar um recurso → Static Web App**.
2. Nome: `agroturn-certidoes`. Plano: **Free**. Em **Detalhes da implantação**, **Origem: Outro**.
3. **Revisar + criar → Criar**. A **URL** aparece na página **Visão Geral** (ex. `https://nome.azurestaticapps.net`).
4. **Gerenciar token de implantação** → copie o token (não compartilhe com ninguém).
5. `npm install -g @azure/static-web-apps-cli` (uma vez).
6. Publique você mesmo, colando o token:
   ```bash
   swa deploy "C:\Users\Agrot\Projetos\agroturn-certidoes" --deployment-token COLE_O_TOKEN_AQUI --env production
   ```
7. Atualize `ALLOWED_ORIGIN` em `worker/wrangler.toml` pra essa nova URL e rode `wrangler deploy` de novo
   (senão a API bloqueia os pedidos vindos desse endereço, por segurança).
