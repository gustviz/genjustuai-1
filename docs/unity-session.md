# Quest 3S — sessão definida pelo admin

O headset **não digita código**. Um admin escolhe a sessão atual em `/admin`. O Unity só pede o JSON.

## Expo

1. Visitante responde as duas perguntas e salva sem conta. O site chama `signInAnonymously()` e gera o código (`sql/sessions.sql`, `sql/anonymous_auth.sql`, `sql/profile_id.sql`, com Anonymous sign-ins ligado no dashboard).
2. Staff abre `https://genjutsuai.vercel.app/admin` sem PIN, escolhe o código e clica **Iniciar sessão no Quest com este código**.
3. O Quest chama `GET https://genjutsuai.vercel.app/api/session` (sem query) e carrega essa pessoa.

## Vercel env

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE` (Settings → API → `service_role` — só no servidor)

`ADMIN_SECRET` não é usada. `/admin` está aberto de propósito neste MVP.

## Contrato Unity

`GET https://genjutsuai.vercel.app/api/session`  
`GET https://genjutsuai.vercel.app/api/session?code=AB3K7Q` (NFC / debug)

**200**

```json
{
  "session_code": "AB3K7Q",
  "display_name": "Lina",
  "personality_text": "Lina, o dia abre em água parada. A casa pede silêncio e frescor: respire devagar, que o que é seu chega sem alarde. Este cartão é só o resumo; o dossiê completo fica na conta.",
  "archetype": "Zen",
  "profile_id": "Zen"
}
```

| Campo | Uso |
|---|---|
| `profile_id` | Id estável da demo. Unity escolhe a cena por este campo: `Zen`, `Cyber`, `Excentrico`, `Acolhedor`. `null` se o questionário ainda não foi salvo ou a coluna SQL ainda não existe. |
| `archetype` | Alias legível do mesmo perfil. `Excentrico` aparece como `Excêntrico`. |
| `session_code`, `display_name`, `personality_text` | Iguais ao contrato anterior. |

Erros, sempre JSON `{ "error": "..." }` e sem URL, chave ou corpo do Supabase:

| HTTP | `error` | Quando |
|---|---|---|
| 503 | `missing_config` | `SUPABASE_URL` / anon key ausentes ou recusadas (401/403). |
| 503 | `supabase_unreachable` | DNS, rede, timeout ou resposta inválida. |
| 404 | `no_current_session` | `GET` sem `code` e o admin ainda não definiu a sessão. |
| 404 | `not_found` | Código sem linha em `session_summaries`. |
| 400 | `invalid_code` | Código fora de 6 caracteres do alfabeto da sessão. |

## Mapa do questionário → ProfileId

| clima_ambiente | clima_tempo | profile_id | archetype |
|---|---|---|---|
| tranquilo | frio | Zen | Zen |
| tranquilo | quente | Acolhedor | Acolhedor |
| tranquilo | ameno | Acolhedor | Acolhedor |
| agitado | frio | Cyber | Cyber |
| agitado | ameno | Cyber | Cyber |
| agitado | quente | Excentrico | Excêntrico |

Implementação: `js/zcea-profile.js`. O visitante grava `profile_id` em `dossiers`, em `dossier_data.preferencias` e em `session_summaries` sem login Google. O resumo público só é gravado quando o par de respostas fecha um desses quatro ids. Entrar com Google, sem responder o questionário, não publica `Perfil em formação` nem apaga um quiz já salvo.

`POST /api/admin/session` (o botão **Iniciar sessão no Quest com este código**) devolve o mesmo par que o Quest lê:

```json
{ "current_session_code": "AB3K7Q", "display_name": "Lina", "profile_id": "Zen" }
```

`profile_id` vem `null` se essa pessoa ainda não salvou o questionário. A lista de `/admin` mostra o id ao lado do nome.

## SessionGate.cs

```csharp
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

[System.Serializable]
public class SessionSummary {
    public string session_code;
    public string display_name;
    public string personality_text;
    public string archetype;
    public string profile_id;
}

public class SessionGate : MonoBehaviour {
    public string apiBase = "https://genjutsuai.vercel.app";

    public IEnumerator LoadCurrentSession() {
        var url = apiBase + "/api/session";
        using (var req = UnityWebRequest.Get(url)) {
            yield return req.SendWebRequest();
            if (req.result != UnityWebRequest.Result.Success || req.responseCode != 200) {
                Debug.LogWarning("Nenhuma sessão atual no admin.");
                yield break;
            }
            var data = JsonUtility.FromJson<SessionSummary>(req.downloadHandler.text);
            Debug.Log(data.session_code + " " + data.profile_id + " " + data.archetype);
        }
    }
}
```

Sem `service_role` e sem senha admin no APK. Chame `LoadCurrentSession` na tela inicial do dojo (Start / botão “Conectar”).

## Corvo — chat do assistente (`/api/chat`)

O Unity (`MVP-Gen`, `Assets/GenJutsu/AI_Test`) tem três provedores em `AIConfig.provider`:

| Provedor | URL que o Quest chama | Chave |
|---|---|---|
| `Groq` | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` no Editor. Não use no APK. |
| `LocalOpenAI` | `http://IP-DO-PC:11434/v1/chat/completions` (Ollama com Qwen) | Nenhuma. |
| `GenJutsuProxy` | `https://genjutsuai.vercel.app/api/chat` | Só na Vercel. Recomendado para o APK. |

Nos três o Unity coloca no system prompt o `display_name`, o `profile_id` e o `personality_text` de `GET /api/session`.

### Vercel env

- `GROQ_API_KEY` — basta isso para usar a Groq.
- `LLM_BASE_URL` + `LLM_MODEL` — outro servidor OpenAI-compatível. Ex.: Qwen no Ollama exposto por túnel (`https://seu-tunel.example/v1`, `qwen3:8b`). `LLM_API_KEY` só se o servidor pedir.
- `CHAT_PROXY_TOKEN` — opcional. Exige o header `x-genjutsu-token` (campo `proxyToken` no `AIConfig`).

### Contrato

`GET /api/chat` → `200 { "ok": true, "model": "..." }` ou `503 { "error": "missing_config" }`. O Unity usa como teste de conexão.

`POST /api/chat`

```json
{
  "messages": [
    { "role": "system", "content": "Você é o Corvo..." },
    { "role": "user", "content": "Oi Corvo" }
  ],
  "temperature": 0.7,
  "max_tokens": 512
}
```

**200** — mesmo formato OpenAI, lido pelo `GroqClient.cs` sem parser novo:

```json
{ "choices": [{ "index": 0, "message": { "role": "assistant", "content": "Oi, Lina." } }],
  "usage": { "prompt_tokens": 120, "completion_tokens": 9, "total_tokens": 129 },
  "model": "openai/gpt-oss-120b" }
```

O modelo é sempre o da Vercel (o campo `model` do cliente é ignorado), `max_tokens` é limitado a 1024 e só as últimas 40 mensagens passam. Blocos `<think>` do Qwen3 são removidos.

| HTTP | `error` | Quando |
|---|---|---|
| 400 | `invalid_messages` | Sem mensagem `user`, papel fora de system/user/assistant. |
| 401 | `unauthorized` | `CHAT_PROXY_TOKEN` definido e header ausente ou errado. |
| 429 | `rate_limited` | O provedor limitou. |
| 502 | `llm_error` / `empty_reply` | O provedor falhou ou respondeu vazio. |
| 503 | `missing_config` / `llm_unreachable` | Sem chave, chave recusada, ou provedor fora do ar. |
| 504 | `llm_timeout` | Mais de 45 s. |

O endpoint é público. Sem `CHAT_PROXY_TOKEN`, qualquer pessoa com a URL gasta a cota da chave. O token no APK pode ser extraído; ele só freia uso casual.
