# Solicitação de Certidões — Agroturn

Site para pedir certidões (matrícula, transcrição, cadeia dominial). Substitui o Microsoft Forms.
Cada pedido vira uma ou mais linhas na planilha **Controle de Certidões - RI Ditigital.xlsx**
(aba *Controle de Certidão*) no SharePoint. O Setor Fundiário continua trabalhando na planilha
normalmente (Responsável, Status, Recibo).

## O que o site faz

- **Nova solicitação**: solicitante, empreendimento e uma ou mais certidões no mesmo pedido.
  Números separados por `;` viram uma linha cada.
- **Acompanhar pedidos**: lista os pedidos da planilha, agrupados por solicitante + empreendimento +
  data/hora do envio (não por Protocolo — ele é digitado depois e pode faltar ou ser diferente por linha).
  Mostra o status atualizado pelo Fundiário. Tem filtro por solicitante e busca.
- Login com a conta Microsoft da empresa. O solicitante é pré-selecionado pelo nome da conta.
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

Com `clientId` vazio em `config.js`, o site roda sem login e salva os pedidos só no navegador.

```bash
node serve.js
```

Abra http://localhost:5500

## Ligar na planilha (uma vez, precisa de um administrador do Microsoft 365)

### 1. Publicar no GitHub Pages (fazer antes — dá o endereço que entra no passo 2)

1. Crie uma conta em https://github.com (gratuita, sem cartão) se ainda não tiver.
2. **New repository**: nome `agroturn-certidoes`, marcado como **Public** (sem README, sem .gitignore —
   já vêm do projeto). **Create repository**.
3. Copie a URL do repositório que o GitHub mostrar (ex. `https://github.com/SEU-USUARIO/agroturn-certidoes.git`)
   e rode, no terminal, dentro da pasta do projeto:
   ```bash
   git remote add origin https://github.com/SEU-USUARIO/agroturn-certidoes.git
   git commit -m "Site de solicitação de certidões"
   git push -u origin main
   ```
   No primeiro `push`, o Git abre o navegador para você entrar com sua conta do GitHub — é o próprio GitHub
   pedindo login, não estou vendo nem guardando essa senha.
4. No repositório, vá em **Settings → Pages**. Em **Source**, escolha **Deploy from a branch**, branch
   **main**, pasta **/ (root)** → **Save**.
5. Espere ~1 minuto e recarregue a página. O endereço fixo do site aparece ali:
   `https://SEU-USUARIO.github.io/agroturn-certidoes/`.
6. Sempre que eu atualizar os arquivos do site, você só precisa rodar `git add -A && git commit -m "..." && git push`
   de novo — o GitHub Pages publica sozinho em ~1 minuto.

O repositório fica público, mas nada nele é secreto: `clientId` não é uma senha (é um identificador de app
público, protegido por login), e o acesso real à planilha continua exigindo login Microsoft de alguém com
permissão nela.

### 2. Registrar o aplicativo no Microsoft Entra ID

1. Acesse https://entra.microsoft.com → **Identidade → Aplicativos → Registros de aplicativo → Novo registro**.
2. Nome: `Certidões Agroturn`. Tipos de conta: **Somente contas deste diretório organizacional**.
3. URI de redirecionamento: plataforma **Aplicativo de página única (SPA)**, com o endereço do passo 1.5
   (ex.: `https://SEU-USUARIO.github.io/agroturn-certidoes/`). Adicione também `http://localhost:5500/` para testes.
4. Clique em **Registrar** e copie o **ID do aplicativo (cliente)** — pode me enviar, não é secreto.

### 3. Permissões

Em **Permissões de API → Adicionar permissão → Microsoft Graph → Permissões delegadas**, adicione:

- `User.Read`
- `Files.ReadWrite.All`

Depois clique em **Conceder consentimento do administrador para Agroturn**, para que ninguém veja
tela de autorização.

### 4. Configurar o site

Em `config.js`, cole o ID em `clientId`. Os outros valores (tenant, arquivo, aba) já estão preenchidos.
Depois, `git add -A && git commit -m "clientId" && git push` para publicar essa mudança no GitHub Pages.

### 5. Acesso à planilha

O site grava **em nome de quem está logado**. Por isso, todos os solicitantes precisam ter permissão de
**edição** no arquivo da planilha (hoje já é assim se o pessoal abre o arquivo pelo site Agroturn).

### 6. Aposentar o Forms

Depois de testar, **desative o recebimento de respostas** no Forms, mas não exclua o formulário.
A tabela da planilha (`OfficeForms.Table…`) foi criada pelo Forms. Desativar evita duas portas de
entrada, e não excluir preserva o vínculo com o histórico.

## Ajustes comuns (`config.js`)

- `solicitantes`: lista de nomes (entrou ou saiu alguém).
- `statusInicial`: status das linhas novas.
- `separarNumeros`: `false` para gravar `12345;78456` numa linha só.
- `tiposCertidao`: tipos disponíveis.
- `dominioEmail`: domínio exigido na tela de login (ex. `agroturn.com.br`). A tela pede o e-mail nesse
  formato em vez do botão genérico do Microsoft — mas quem autentica de verdade continua sendo o
  Microsoft, com a mesma conta de sempre. Não é uma senha nova nem um sistema de login separado.

## Alternativa de hospedagem: Azure Static Web Apps

Se um dia a Agroturn tiver assinatura Azure (ou quiser um domínio próprio tipo `certidoes.agroturn.com.br`
sem depender do GitHub), dá para trocar de hospedagem sem mudar o resto do site:

1. https://portal.azure.com → **Criar um recurso → Static Web App**.
2. Nome: `agroturn-certidoes`. Plano: **Free**. Em **Detalhes da implantação**, **Origem: Outro**.
3. **Revisar + criar → Criar**. A **URL** aparece na página **Visão Geral** (ex. `https://nome.azurestaticapps.net`).
4. **Gerenciar token de implantação** → copie o token (não compartilhe com ninguém).
5. `npm install -g @azure/static-web-apps-cli` (uma vez).
6. Publique você mesmo, colando o token:
   ```bash
   swa deploy "C:\Users\Agrot\Projetos\agroturn-certidoes" --deployment-token COLE_O_TOKEN_AQUI --env production
   ```
7. Adicione essa URL como URI de redirecionamento no Entra ID (além da do GitHub Pages, ou no lugar dela).
