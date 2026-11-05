# GenJutsu AI

Portal da Smart Home Cognitiva para a experiência no Meta Quest 3S. Hospedagem: **Vercel**. Auth e banco: **Supabase**.

O caminho principal não pede Google. A pessoa escreve o nome, responde duas perguntas e salva como visitante. Se não houver sessão, o cliente chama `supabase.auth.signInAnonymously()` e, com o papel `authenticated`, chama `genjutsu_ensure_session()` e grava `dossiers` + `session_summaries` (incluindo `profile_id`). Não há seletor de casa.

1. **Continuar sem conta** — abre o questionário. O nome é obrigatório. O botão **Salvar sem conta e gerar o código** cria a sessão anônima se ainda não existir. Não chama Calendar, YouTube, Contacts nem Tasks. O nome público é o que a pessoa escreveu (o fallback antigo `Visitante` + código só aparece se esse nome não existir). O e-mail fica vazio e o avatar é [`assets/guest-avatar.jpg`](assets/guest-avatar.jpg).
2. **Continuar com Google** — opcional. OAuth com agenda, YouTube, contatos e tarefas (sem Gmail). O nome da conta preenche o campo e as mesmas duas perguntas gravam o mesmo `profile_id`.

Microsoft aparece só como “ou Microsoft”, fora desse par.

O perfil do Quest é ZCEA, não as casas de marketing (Acolhedora / Elétrica / Ardente) nem os 8 arquétipos do CDD. `profile_id` é o id estável. `archetype` é o alias legível (`Excentrico` → `Excêntrico`).

| clima_ambiente | clima_tempo | profile_id | archetype | Letra |
| --- | --- | --- | --- | --- |
| tranquilo | frio | Zen | Zen | Z |
| tranquilo | quente | Acolhedor | Acolhedor | A |
| tranquilo | ameno | Acolhedor | Acolhedor | A |
| agitado | frio | Cyber | Cyber | C |
| agitado | ameno | Cyber | Cyber | C |
| agitado | quente | Excentrico | Excêntrico | E |

O resumo que o Quest lê (`session_summaries`) só nasce quando esse par fecha um `profile_id`. Login sem as duas respostas não grava `Perfil em formação` no lugar do perfil. Quem já tinha `preferencias` sem `profile_id` é preenchido por [`sql/backfill_profile_id.sql`](sql/backfill_profile_id.sql).

Documento mestre acadêmico (CDD): [docs/GenJutsu_AI_CDD_Completo.md](docs/GenJutsu_AI_CDD_Completo.md). Gap vs este repo: [docs/architecture/gap-cdd-vs-repo.md](docs/architecture/gap-cdd-vs-repo.md).

## 1. Novo projeto Supabase

1. Crie um projeto em [supabase.com](https://supabase.com). O projeto ao vivo `ahzsvjimyfzjcfuhgdgw` pode ter só `dossiers`. Não assuma que `session_summaries`, `app_state` ou `sessions` já existem.
2. SQL Editor, **nesta ordem** (os arquivos são idempotentes; `profile_id.sql` precisa da policy de leitura que `sessions.sql` ou `admin_read.sql` criam):
   1. [`sql/dossiers.sql`](sql/dossiers.sql)
   2. [`sql/sessions.sql`](sql/sessions.sql) — `genjutsu_ensure_session()`, código de 6 caracteres, `session_summaries`
   3. [`sql/app_state.sql`](sql/app_state.sql)
   4. [`sql/admin_read.sql`](sql/admin_read.sql)
   5. [`sql/anonymous_auth.sql`](sql/anonymous_auth.sql) — reafirma grants para o papel `authenticated`. Não concede `genjutsu_ensure_session()` ao papel `anon` da chave pública.
   6. [`sql/profile_id.sql`](sql/profile_id.sql) — coluna `profile_id` em `dossiers` e `session_summaries` (Zen, Cyber, Excentrico, Acolhedor)
   7. [`sql/backfill_profile_id.sql`](sql/backfill_profile_id.sql) — só se já existem respostas sem `profile_id`
   8. [`sql/freeze_session_code.sql`](sql/freeze_session_code.sql) — só se o código de sessão já existia antes do trigger
3. **Authentication → URL configuration**
   - Site URL: `https://SEU-PROJETO.vercel.app`
   - Redirect URLs: `https://SEU-PROJETO.vercel.app/**` e `https://SEU-REF.supabase.co/auth/v1/callback`
4. **Authentication → Providers → Google**: ative e cole Client ID / Secret do Google Cloud (passo 2). Opcional para o visitante.
5. **Authentication → Providers → Anonymous**: ative **Anonymous sign-ins**. Esse interruptor fica no dashboard e **não liga por SQL**. Sem ele, “Salvar sem conta” falha. O usuário anônimo entra no papel `authenticated` com `auth.uid()` preenchido — não é o papel `anon` da chave pública. As políticas `auth.uid() = user_id` e o `grant execute` de `genjutsu_ensure_session()` para `authenticated` já aceitam esse usuário.
6. Em **Settings → API**, copie **Project URL** e a chave **anon**.

## 2. Novo projeto Google Cloud

1. [console.cloud.google.com](https://console.cloud.google.com) → projeto novo (ex. `genjutsuai-vercel`).
2. Ative as APIs: **Google Calendar**, **YouTube Data API v3**, **People API**, **Google Tasks API**.
3. Tela de consentimento OAuth (External), em **Testing**, com usuários de teste.
4. Escopos:
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/tasks.readonly`
5. Home / privacidade / termos: `https://SEU-PROJETO.vercel.app/`, `/privacy`, `/terms`.
6. Credencial **OAuth client ID → Web application**
   - Origins: `https://SEU-PROJETO.vercel.app` e `https://SEU-REF.supabase.co`
   - Redirect: `https://SEU-REF.supabase.co/auth/v1/callback`
7. Cole ID e secret no provider Google do Supabase.

`*.vercel.app` é domínio compartilhado (mesmo limite que o Netlify para verificação de marca). Use o app em **Testing**.

## 3. Deploy na Vercel

1. [vercel.com](https://vercel.com) → importar o GitHub `Andremarcelin/genjustuai`.
2. Framework: **Other**. Root: `.`
3. Environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (chave **anon / publishable** de leitura — não é a secret)

`ADMIN_SECRET` não é lida neste MVP. `/admin` e `GET`/`POST /api/admin/session` abrem sem PIN. A variável pode sair da Vercel. Para travar de novo, volte a exigir o segredo em `api/admin/session.js` e recoloque o campo de PIN em `admin.html`.
4. Deploy. A rota `/api/config` entrega essas variáveis ao site.
5. Depois do primeiro URL, atualize Site URL no Supabase, origins no Google e, se quiser, os links em `privacy.html` / `terms.html`.

## Estrutura

- `index.html` — landing e as duas perguntas. O botão principal salva sem conta.
- `site.css`, `portal.css` — visual (preto fosco, neon vermelho `#FF1A1A`, Cinzel nos títulos, Inter no corpo)
- `assets/icon-crow.jpg` — ícone do corvo; `assets/landing-frame.jpg` — fundo com circuitos e nuvens
- `js/zcea-profile.js` — mapa das duas respostas para `profile_id`
- `js/guest-save.js` — `signInAnonymously()` quando não há sessão, depois dossiê + resumo
- `js/personality.js` — nome, e-mail, avatar e texto do resumo (visitante não ganha frase de agenda)
- `js/portal.js` — OAuth opcional e a gravação no Supabase
- `api/config.js` — Vercel Function (`SUPABASE_URL`, `SUPABASE_ANON_KEY`)
- `vercel.json` — rewrites `/privacy`, `/terms`, `/admin` e `/s/:code`
- `sql/dossiers.sql` — tabela + RLS
- `sql/sessions.sql` — session_code, interações, conversas, resumo NFC, `genjutsu_ensure_session`
- `sql/anonymous_auth.sql` — grants reafirmados para o papel `authenticated` (inclui anônimo)
- `sql/profile_id.sql` — coluna ZCEA em `dossiers` e `session_summaries`
- `summary.html` — página pública `/s/CODIGO`
- `admin.html` — escolha da sessão do Quest
- `api/session.js` — JSON para o Unity/Quest (`?code=`)
- `api/chat.js` — proxy do Corvo (Groq ou Qwen por `LLM_BASE_URL`). A chave fica na Vercel, não no APK. Contrato em [docs/unity-session.md](docs/unity-session.md#corvo--chat-do-assistente-apichat)
- [docs/unity-session.md](docs/unity-session.md) — handshake Quest 3S

O resumo do visitante descreve só clima e casa. A frase “N evento(s) de agenda…” só entra quando a fonte do dossiê é Google.

`node test/personality.test.js` confere o fallback `Visitante` + código, o nome escrito quando existe, o e-mail vazio e a ausência dessa frase.

`node --test test/guest-save.test.js test/zcea-profile.test.js test/session-api.test.mjs test/chat-api.test.mjs` confere o save sem login (sessão anônima, `profile_id`, código de 6 caracteres) e o JSON de `GET /api/session`.

## Como verificar o visitante

1. Com Anonymous sign-ins ligado e o SQL acima aplicado, abra o site.
2. **Continuar sem conta**. Não entre com Google.
3. Escreva um nome. **Aceso e em movimento** + **Aconchego** (valores `agitado` + `quente`). Não há lista de casas.
4. **Salvar sem conta e gerar o código**. A tela final abre um pergaminho com a frase do perfil Excêntrico e, abaixo, os registros salvos (nome, respostas, `profile_id` `Excentrico`, código). O QR continua na mesma tela.
5. `GET /api/session?code=CODIGO` devolve `session_code`, `display_name` (o nome escrito), `personality_text` (a frase), `archetype` `Excêntrico` e `profile_id` `Excentrico`.
