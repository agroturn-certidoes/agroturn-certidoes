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
- Login fica salvo por 30 dias neste navegador — não pede toda vez.
- Sugere empreendimentos e cartórios já usados na planilha (evita digitação diferente).

Colunas gravadas em cada linha nova:

| Coluna | Valor |
|---|---|
| Id | maior Id da tabela + 1 |
| Protocolo | **em branco** — é o número do RI Digital (ONR); o Fundiário digita na planilha depois de solicitar lá |
| Data | data e hora do envio (fuso de Cuiabá) |
| Solicitante, Nome do empreendimento, Tipo de Certidão, Nº da Matrícula/Transcrição, Observações, Cartório Responsável | preenchidos no site |
| Responsável | vazio (o Fundiário preenche com quem for solicitar no RI Digital) |
| Status | `AGUARDANDO PEDIDO` (ajustável em `config.js` — troque se o fluxo de vocês usar outro valor inicial) |
| Recibo | desmarcado |

Depois de enviado, o site mostra o **número do pedido** (a faixa de Id das linhas criadas, ex. `Nº 74–77`)
como referência — não um protocolo, já que ele ainda não existe nesse momento.

As colunas são encontradas **pelo nome do cabeçalho**, então mudar a ordem delas não quebra o site.
Renomear uma coluna quebra.

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
     `victor.martins@agroturn.com.br,keli@agroturn.com.br,...`.
5. Publique:
   ```bash
   wrangler deploy
   ```
   O terminal mostra a URL da API, algo como `https://agroturn-certidoes-api.SEU-USUARIO.workers.dev`.
6. **Me manda essa URL** — não é secreta. Eu coloco em `config.js` (`apiBase`) e publico.
7. Sempre que quiser trocar a senha, adicionar/remover alguém da lista, ou trocar a chave: repita o
   `wrangler secret put ...` correspondente e depois `wrangler deploy` de novo.

### 4. Aposentar o Forms

Depois de testar, **desative o recebimento de respostas** no Forms, mas não exclua o formulário.
A tabela da planilha (`OfficeForms.Table…`) foi criada pelo Forms. Desativar evita duas portas de
entrada, e não excluir preserva o vínculo com o histórico.

## Ajustes comuns (`config.js`)

- `solicitantes`: lista de nomes (entrou ou saiu alguém).
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
