# Claude Code의 WebSearch / WebFetch 도구 분석 보고서

- 분석 대상: Claude Code CLI 2.1.322 (`~/.local/share/claude/versions/2.1.322`, Mach-O arm64)
- 빌드 정보: `BUILD_TIME 2026-11-10T00:15:08Z`, `GIT_SHA 660928a5946898d0c8d3488f20dd9b0b2da4ec09`
- 분석 방법: 정적 분석 (IDA로 컨테이너 구조를 확인하고, 내장된 JS 소스를 추출하여 분석)
- 분석 범위: provider가 `firstParty`(api.anthropic.com)이고, Claude 구독(OAuth)으로 로그인한 일반적인 로컬 환경

이 문서에서 "확인"이라고 표시한 내용은 코드에서 직접 확인한 사실입니다. "추정"이라고 표시한 내용은 코드 흐름을 근거로 추론했지만 실행해서 검증하지는 않은 내용입니다.


## 1. 요약

- `WebSearch`와 `WebFetch`는 Claude Code에 **명시적으로 등록된 내장 도구**입니다. Claude Agent SDK에는 이 도구들을 구현한 코드가 없습니다. SDK는 CLI를 실행하고 도구 이름을 전달할 뿐입니다.
- 메인 모델은 두 도구를 일반적인 클라이언트 도구로 인식합니다. 메인 모델이 도구를 호출하면, CLI가 로컬에서 도구 코드를 실행합니다.
- **WebSearch**는 Anthropic Messages API에 **별도의 요청(사이드 쿼리)을 한 번 더 보냅니다**. 이 요청에는 Anthropic의 서버 측 도구인 `web_search_20250305`가 들어 있고, 모델이 이 도구를 반드시 사용하도록 강제됩니다. 따라서 실제 검색은 Anthropic 서버에서 수행됩니다. 로컬 프로세스는 검색 엔진에 직접 접속하지 않습니다.
- **WebFetch**는 로컬 프로세스가 **대상 URL에 직접 HTTP GET 요청을 보냅니다**. 그 전에 Anthropic의 도메인 안전성 검사 API를 호출합니다. 받아 온 HTML은 Markdown으로 변환한 뒤, 작은 모델(Haiku 계열)에 다시 Messages API 요청을 보내서 사용자가 지정한 `prompt`에 대한 답을 받습니다.
- 그러므로 도구를 한 번 사용할 때마다 메인 대화 요청 외에 추가 API 요청이 발생합니다. WebSearch는 Messages API 요청 1회가 추가되고, WebFetch는 GET 요청 2회와 Messages API 요청 1회가 추가됩니다.


## 2. 바이너리 구조와 분석 방법

### 2.1 Bun 단일 실행 파일

Claude Code CLI는 Bun의 `bun build --compile` 기능으로 만든 단일 실행 파일입니다. JavaScript 코드와 리소스는 Mach-O의 `__BUN` 세그먼트 안에 있는 `__bun` 섹션에 들어 있습니다.

| 항목 | 값 |
|---|---|
| `__bun` 섹션 주소 범위 | `0x107a7c000` ~ `0x1135a9375` |
| 파일 오프셋 | `0x7898000` (126,451,712) |
| 페이로드 크기 (섹션 맨 앞 8바이트) | `0xbb2d36d` (약 196MB) |
| 트레일러 | `\n---- Bun! ----\n` |
| 모듈 테이블 | 페이로드 오프셋 `0xbafea59`, 크기 `0x28318`, 52바이트 엔트리 3,166개 |
| 진입 모듈 | 7번 `/$bunfs/root/cli` |
| 실행 인자 (`execArgv`) | `--zero-fill-buffers` |

IDA에서 세그먼트 목록을 확인하고, 트레일러 바로 앞에 있는 32바이트 오프셋 구조체를 해석하여 위 값들을 얻었습니다. 모듈 3,166개 중 2,919개가 JS 청크이고, 나머지는 `.node` 네이티브 애드온, 압축 리소스(`.zst`), 문서(`.md`) 등입니다.

### 2.2 JS 청크의 형태

모든 JS 청크는 `// @bun @bytecode` 주석으로 시작합니다. 이것은 JSC 바이트코드와 원본 소스가 함께 들어 있다는 뜻입니다. 원본 소스는 축약(minify)되어 있지만 평문 상태이므로 그대로 추출해서 읽을 수 있습니다. 도구의 동작은 모두 JS로 구현되어 있기 때문에, 네이티브 코드(Bun과 JavaScriptCore 런타임)는 분석하지 않았습니다.

### 2.3 추출 결과와 주요 파일

추출물은 `/tmp/cc-analysis/`에 저장했습니다. `fs/`에는 모듈 원본이 있고, `pretty/`에는 prettier로 정리한 파일이 있습니다.

| 파일 | 내용 |
|---|---|
| `chunk-raphtnn0.js` | WebSearch 도구 본체 (`dr`), 내장 도구 목록 함수 `Fb()` |
| `chunk-196sa858.js` | 상수 `If = "WebSearch"`, WebSearch 도구 설명문 |
| `chunk-psvz19tc.js` | 상수 `qn = "WebFetch"`, 인용 제한 규칙 |
| `chunk-t14zvpyp.js` | WebFetch 도구 설명문, 2차 모델에 보내는 프롬프트 템플릿 |
| `chunk-9r1hbf9p.js` | WebFetch 도구 본체 (`FS`), HTTP 요청 처리, 사이드 쿼리 함수(`Y7t`, `g2`), Messages 요청 본문 조립(`VDn`) |
| `chunk-jshe6j36.js` | Anthropic SDK 클라이언트 생성(`HU`), 기본 헤더(`su`), SDK의 `/v1/messages?beta=true` 호출 |
| `chunk-yqezv9gr.js` | 작은 모델 선택(`uk`), beta 목록 계산(`X1`, `Q2n`), `Claude-User` User-Agent |
| `chunk-smzekmsg.js` | beta 헤더 상수 표 |
| `chunk-j13ytyp8.js` | 시스템 프롬프트 앞부분 조립(`DGi`, `BTr`), `metadata` 생성(`Ize`) |
| `chunk-g32ceg0f.js` | 과금 귀속 헤더 문자열 생성(`j0s`) |

함수와 변수 이름은 축약 과정에서 붙은 이름입니다. 버전이 바뀌면 이름도 달라집니다.


## 3. 도구 등록

### 3.1 내장 도구 목록

`chunk-raphtnn0.js`의 `Fb()` 함수가 내장 도구 배열을 반환합니다. 이 배열에 `FS`(WebFetch)와 `dr`(WebSearch)가 조건 없이 들어 있습니다. 실제로 모델에 노출되는지는 각 도구의 `isEnabled()`가 결정합니다.

```js
function Fb() {
  ...
  return [ Hbn, ..., EDe, ...br, FS, yr, fr, dr, Ze, ... ];
}
```

두 도구 모두 `cn({...})`으로 만든 도구 객체이고, 다음 속성을 공통으로 가집니다.

- `shouldDefer: true`: 지연 로딩 도구입니다. 도구 검색(tool search) 기능이 켜져 있으면 처음부터 전체 스키마를 보내지 않고, 필요할 때 불러옵니다.
- `isReadOnly() → true`, `isConcurrencySafe() → true`: 읽기 전용이고, 동시에 여러 번 실행할 수 있습니다.
- `backgrounding: "detach"`: 백그라운드로 분리해서 실행할 수 있습니다.

### 3.2 도구별 정의

| 항목 | WebSearch | WebFetch |
|---|---|---|
| 이름 | `"WebSearch"` | `"WebFetch"` |
| 화면 표시 이름 | `Web Search` | `Fetch` |
| 입력 스키마 | `query` (2자 이상), `allowed_domains?`, `blocked_domains?`. 기능 플래그가 켜지면 `mode: "standard" \| "extended"`가 추가됩니다. | `url` (URL 형식), `prompt`, `offset?` (0 이상의 정수) |
| 출력 스키마 | `query`, `results[]`, `durationSeconds`, `searchCount?` | `bytes`, `code`, `codeText`, `result`, `durationMs`, `url` |
| 최대 결과 크기 | 100,000자 | `av` 상수 (값은 확인하지 않았습니다) |
| 권한 검사 | 항상 `passthrough` (사용자 확인 대상) | URL과 도메인 규칙으로 판정 (`domain:<host>` 형태) |

### 3.3 활성화 조건

**WebSearch** (`isEnabled`)

1. 조직 정책 키 `allow_web_search`가 허용되어 있어야 합니다.
2. provider가 다음 중 하나여야 합니다.
   - `firstParty`이면 활성화됩니다.
   - `foundry`이면 활성화됩니다.
   - `vertex`이면 일부 모델에서만 활성화됩니다.
   - `gateway`이면 **비활성화**됩니다.
   - 그 밖의 provider(bedrock 등)는 기본적으로 비활성화됩니다.

**WebFetch** (`isEnabled`)

1. 환경 변수 `CLAUDE_CODE_DISABLE_WEB_FETCH`가 설정되어 있지 않아야 합니다.
2. 조직 정책 키 `allow_web_fetch`가 허용되어 있어야 합니다.

WebFetch는 provider 조건이 없습니다. 대상 사이트에 로컬에서 직접 접속하기 때문입니다.


## 4. 공통 기반: 사이드 쿼리가 Messages API 요청이 되는 과정

WebSearch와 WebFetch는 모두 "사이드 쿼리"라는 별도의 모델 호출을 사용합니다. 사이드 쿼리는 메인 대화와 같은 요청 조립 함수를 거치므로, 요청 형태도 메인 대화 요청과 거의 같습니다.

### 4.1 호출 경로

```
WebSearch:  dr.call() ─▶ Y7t() ─▶ _Ln() ─▶ KDn() ─▶ VDn() ─▶ HU() 로 만든 SDK 클라이언트
WebFetch:   FS.call() ─▶ ZXt() ─▶ g2() ─▶ JGr() ─▶ PDe() ─▶ _Ln() ─▶ ... (같은 경로)
```

- `VDn()`이 요청 본문 전체를 조립합니다. 모델, 메시지, 시스템 프롬프트, 도구, beta 목록, thinking 설정 등이 여기서 정해집니다.
- `HU()`가 Anthropic TypeScript SDK 클라이언트를 만듭니다. 인증 방식과 기본 헤더가 여기서 정해집니다.
- 실제 전송은 `client.beta.messages.create({...body, stream: true})`로 이루어집니다. SDK는 이 호출을 `POST /v1/messages?beta=true` 요청으로 바꿉니다. 스트리밍 요청이 실패하면 `stream: false`로 다시 시도하는 경로(`SGr`)도 있습니다.

### 4.2 HTTP 요청의 형태 (firstParty, 구독 OAuth 기준)

```http
POST https://api.anthropic.com/v1/messages?beta=true
Authorization: Bearer <claude.ai OAuth access token>
anthropic-version: 2023-06-01
anthropic-beta: <쉼표로 구분한 beta 목록, 4.3절 참고>
content-type: application/json
x-app: cli
User-Agent: claude-cli/2.1.322 (external, <entrypoint>[, agent-sdk/<버전>])
X-Claude-Code-Session-Id: <세션 UUID>
x-stainless-*: <Anthropic SDK가 자동으로 붙이는 헤더>
```

각 헤더의 근거는 다음과 같습니다.

- **인증** (`HU`, 확인): 구독자이면 SDK에 `authToken`(OAuth 액세스 토큰)을 넘기므로 `Authorization: Bearer`가 붙습니다. API 키를 쓰는 경우에는 `x-api-key`가 붙습니다.
- **기본 헤더** (`su()`, 확인): `{"x-app": "cli", "User-Agent": $j(), "X-Claude-Code-Session-Id": <세션 ID>}`입니다. 백그라운드 세션이면 `x-app` 값이 `cli-bg`가 됩니다.
- **User-Agent** (`$j()`, 확인): 형식은 `claude-cli/2.1.322 (external, ${entrypoint}${agent-sdk}${client-app}${workload})`입니다.
  - `entrypoint`는 `CLAUDE_CODE_ENTRYPOINT` 값을 따르고, 값이 없으면 `cli`입니다.
  - `CLAUDE_AGENT_SDK_VERSION`이 있으면 `, agent-sdk/<버전>`이 붙습니다.
  - Agent SDK가 CLI를 실행하는 경우에는 SDK가 이 환경 변수들을 설정할 것으로 추정합니다.
- **그 밖의 선택적 헤더**: 원격 컨테이너 ID, 서브에이전트 ID(`x-claude-code-agent-id`, `x-claude-code-parent-agent-id`), `ANTHROPIC_CUSTOM_HEADERS`로 지정한 헤더 등이 조건에 따라 추가됩니다.
- `anthropic-version: 2023-06-01`은 SDK의 기본값입니다. SDK 코드에서 이 값을 직접 확인하지는 않았습니다(추정).

### 4.3 beta 헤더

beta 목록은 `X1()`과 `Q2n()`이 모델과 환경에 따라 계산합니다. 사이드 쿼리와 관련이 있는 항목은 다음과 같습니다.

| beta 값 | 추가 조건 | 사이드 쿼리 해당 여부 |
|---|---|---|
| `oauth-2025-04-20` | OAuth 구독 인증이고 `user:inference` scope가 있을 때 (`Tt()`) | 구독 환경이면 포함 |
| `claude-code-20250219` | 모델 이름에 `haiku`가 들어 있지 **않을** 때 | WebSearch(메인 모델 사용 시) 포함, WebFetch(Haiku) 제외 |
| `interleaved-thinking-2025-05-14` | 모델이 interleaved thinking을 지원하고 `DISABLE_INTERLEAVED_THINKING`이 없을 때 | 모델에 따라 다름 |
| `context-1m-2025-08-07` | 1M 컨텍스트 모델일 때 | 모델에 따라 다름 |
| `web-search-2025-03-05` | provider가 `vertex`(일부 모델) 또는 `foundry`일 때 | firstParty에서는 **포함되지 않음** |
| `claude-code-side-query-2026-09-29` | 사이드 쿼리 표시. 3.4절 참고 | WebFetch만 조건부로 포함 |

- firstParty에서는 `web_search_20250305` 도구를 쓸 때 별도의 beta 헤더가 필요하지 않습니다(확인).
- 사이드 쿼리 표시 beta(`claude-code-side-query-2026-09-29`)는 다음 조건을 모두 만족할 때 붙습니다.
  - 요청의 `sendSideQueryBeta`가 참이어야 합니다.
  - provider가 firstParty여야 합니다.
  - 그 밖의 내부 조건도 만족해야 합니다.
- WebFetch가 쓰는 `g2()`는 `sendSideQueryBeta` 기본값을 `s0()` 함수의 결과로 정합니다. 그래서 이 beta는 환경에 따라 붙을 수도 있고 붙지 않을 수도 있습니다.
- WebSearch는 `sendSideQueryBeta`를 지정하지 않습니다. 그래서 이 beta는 붙지 않습니다(확인).
- `ANTHROPIC_BETAS` 환경 변수로 beta를 추가할 수 있습니다.

### 4.4 요청 본문의 공통 필드

`VDn()`이 조립하는 본문의 기본 구조는 다음과 같습니다.

```jsonc
{
  "model": "<모델 ID>",
  "messages": [ ... ],
  "system": [ {"type": "text", "text": "..."}, ... ],
  "tools": [ ... ],
  "tool_choice": { ... },
  "metadata": { "user_id": "<JSON 문자열>" },
  "max_tokens": <모델의 최대 출력 토큰>,
  "thinking": { "type": "disabled" },
  "output_config": { "effort": "..." },   // 조건부
  "stream": true
}
```

**system 배열의 앞부분** (`DGi`, 확인)

사이드 쿼리에서 지정한 시스템 프롬프트 앞에 다음 두 블록이 자동으로 붙습니다.

1. 과금 귀속 블록 (`j0s`)
   - 내용은 다음과 같은 형식의 텍스트입니다.
     ```
     x-anthropic-billing-header: cc_version=2.1.322.<fingerprint>; cc_entrypoint=<entrypoint>; cch=00000; ...
     ```
   - HTTP 헤더가 아닙니다. **시스템 프롬프트의 첫 번째 텍스트 블록**으로 들어갑니다.
   - firstParty 구독 환경에서는 `cch=00000;`이 붙습니다. 서브에이전트, 이전 요청 ID, 프롬프트 ID 같은 정보도 조건에 따라 추가됩니다.
   - 환경 설정으로 이 블록을 끌 수 있는 분기가 있습니다.
2. CLI 정체성 문장 (`BTr`)
   - 대화형 세션에서는 `"You are Claude Code, Anthropic's official CLI for Claude."`가 들어갑니다.
   - 비대화형 세션(Agent SDK, `-p` 모드)에서는 다음 둘 중 하나가 들어갑니다.
     - `--append-system-prompt`를 쓰지 않으면 `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`가 들어갑니다.
     - 쓰면 `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`가 들어갑니다.
   - Vertex에서는 항상 첫 번째 문장을 씁니다.

**metadata** (`Ize`, 확인)

`user_id` 필드에 다음 객체를 JSON 문자열로 바꾼 값이 들어갑니다.

```json
{"device_id": "<기기 ID>", "account_uuid": "<계정 UUID>", "session_id": "<세션 ID>"}
```

`CLAUDE_CODE_EXTRA_METADATA` 환경 변수로 항목을 추가할 수 있습니다.

**thinking과 tool_choice** (확인)

- 사이드 쿼리는 `thinkingConfig: {type: "disabled", mechanical: true}`로 호출됩니다.
- firstParty이고 모델이 thinking을 지원하면, 본문에 `"thinking": {"type": "disabled"}`가 명시적으로 들어갑니다.
- `tool_choice`가 특정 도구를 강제하는 경우에 extended thinking이 켜져 있으면 강제 지정이 `{"type": "auto"}`로 바뀝니다. 사이드 쿼리는 thinking을 끄므로 이 일은 일어나지 않습니다.


## 5. WebSearch의 동작

### 5.1 실행 분기

`dr.call()`은 다음 순서로 조건을 확인하고, 처음 만족한 경로로 처리합니다.

| 순서 | 경로 | 조건 | 비고 |
|---|---|---|---|
| 1 | 검색 예산 초과 | 세션(또는 턴)의 검색 예산을 모두 쓴 경우 | 검색하지 않고 안내문을 반환합니다. 한도는 `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`으로 정합니다. |
| 2 | 검색 서비스 (`et()`) | `uwo()`가 참인 경우 | 이 버전에서는 `uwo()`가 항상 `false`를 반환하므로 **사용되지 않습니다**. |
| 3 | CCR 프록시 | firstParty, `CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY` 설정, 원격 세션 ID 존재 | 원격(클라우드) 세션용 경로입니다. 5.4절 참고 |
| 4 | **기본 경로: 사이드 쿼리** | 위 조건에 해당하지 않는 모든 경우 | 로컬 CLI는 이 경로를 사용합니다. |

### 5.2 기본 경로의 HTTP 요청

헤더는 4.2절과 같습니다. 본문은 다음과 같습니다.

```jsonc
POST https://api.anthropic.com/v1/messages?beta=true

{
  "model": "<메인 모델, 또는 플래그에 따라 작은 모델>",
  "messages": [
    { "role": "user", "content": "Perform a web search for the query: <query>" }
  ],
  "system": [
    { "type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.322.…; cc_entrypoint=…; cch=00000; …" },
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." },
    { "type": "text", "text": "You run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results." }
  ],
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "allowed_domains": [ ... ],     // 입력에 있을 때만
      "blocked_domains": [ ... ],     // 입력에 있을 때만
      "max_uses": 8,
      "search_profile": "fast"        // mode가 "standard"이고 기능 플래그가 켜졌을 때만
    }
  ],
  "tool_choice": { "type": "tool", "name": "web_search" },
  "thinking": { "type": "disabled" },
  "metadata": { "user_id": "…" },
  "max_tokens": …,
  "stream": true
}
```

**모델 선택** (확인)

- 기본으로는 **메인 대화와 같은 모델**을 사용합니다.
- 서버 측 기능 플래그 `tengu_plum_vx3`가 켜져 있으면 작은 모델(`uk()`, 보통 Haiku 계열)을 사용합니다.

**그 밖의 설정** (확인)

- `enablePromptCaching: false`이므로 `cache_control` 표시가 붙지 않습니다.
- 메인 대화의 도구와 MCP 도구는 전달하지 않습니다(`tools: []`, `mcpTools: []`). 서버 도구 하나만 `extraToolSchemas`로 추가됩니다.
- `querySource`는 `"web_search_tool"`입니다. 이 값은 내부 분류와 텔레메트리에 쓰입니다.
- `allowed_domains`와 `blocked_domains`를 동시에 지정하면 요청을 보내기 전에 입력 검증 단계에서 거부합니다.
- Foundry에서는 배포된 모델이 `web_search`를 지원하지 않으면 오류를 냅니다.

### 5.3 응답 처리

응답은 SSE 스트림으로 받습니다. 처리 방식은 다음과 같습니다(확인).

1. `content_block_start` 이벤트의 블록 종류를 확인합니다.
   - `server_tool_use` 블록이면 서버가 실행한 검색 호출의 ID를 기록합니다.
   - `web_search_tool_result` 블록이면 진행 상황(결과 개수)을 화면에 표시합니다.
2. `input_json_delta` 이벤트에서 정규식으로 `"query"` 값을 꺼내서, 서버가 실제로 사용한 검색어를 화면에 표시합니다.
3. 스트림이 끝나면 `ji()` 함수가 최종 콘텐츠 블록을 정리합니다.
   - `web_search_tool_result`에서는 각 결과의 **`title`과 `url`만** 꺼냅니다. 본문 발췌(snippet)나 암호화된 콘텐츠는 버립니다.
   - `text` 블록은 모델이 작성한 요약문으로 보존합니다.
   - 오류 결과는 `Web search error: <error_code>` 문자열로 바꿉니다.

메인 모델에 돌려주는 `tool_result`의 형식은 다음과 같습니다.

```
Web search results for query: "<query>"

Links: [{"title":"…","url":"…"}, …]

<사이드 쿼리 모델이 작성한 요약문>

REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.
```

`CLAUDE_CODE_WEBSEARCH_CITATIONS`가 설정되어 있고 결과에 snippet이 있으면, 문자열 대신 `search_result` 콘텐츠 블록 배열(`citations.enabled: true`)로 반환합니다. 이 형식은 주로 CCR 프록시 경로에서 쓰입니다.

### 5.4 CCR 프록시 경로 (원격 세션 전용)

원격 세션에서는 사이드 쿼리 대신 Anthropic의 세션 워커 API를 호출합니다(확인).

```http
POST {ANTHROPIC_BASE_URL 또는 https://api.anthropic.com}/v1/code/sessions/{세션 ID}/worker/web-search
Authorization: Bearer <세션 토큰 또는 OAuth 토큰>
anthropic-version: 2023-06-01
Content-Type: application/json
User-Agent: claude-code/2.1.322

{"query": "…", "allowed_domains": [...], "blocked_domains": [...], "search_profile": "fast"}
```

응답은 `{"results": [{"title", "url", "snippet"}], "error": {...}}` 형식입니다. 재시도 정책은 최대 4회, 기본 지연 1초, 전체 예산 75초입니다.


## 6. WebFetch의 동작

### 6.1 전체 흐름

```
FS.call(url, prompt, offset)
  ├─ (artifact 링크이면 별도 처리)
  ├─ lds(): 페이지 가져오기
  │    ├─ URL 검사
  │    ├─ 15분 캐시 확인
  │    ├─ [CCR 프록시 경로] POST .../worker/web-fetch
  │    └─ [기본 경로]
  │         ├─ GET https://api.anthropic.com/api/web/domain_info?domain=<host>
  │         ├─ GET <대상 URL>  (리다이렉트를 수동으로 처리)
  │         └─ HTML이면 turndown으로 Markdown 변환
  └─ 결과 가공
       ├─ 사전 승인 도메인 + text/markdown + 짧은 내용 → 원문 그대로 반환
       ├─ 서브에이전트 경로 → 원문을 태그로 감싸고, 넘치는 부분만 요약
       └─ 그 밖의 경우 → ZXt(): 작은 모델에 POST /v1/messages
```

### 6.2 URL 검사와 캐시

`lds()`가 가장 먼저 수행하는 검사입니다(확인).

- URL 길이가 2,000자를 넘으면 거부합니다.
- URL에 사용자 이름이나 비밀번호가 들어 있으면 거부합니다.
- 호스트 이름에 점이 없으면(`localhost` 등) 거부합니다. 이때 Bash에서 curl을 쓰라는 안내문을 반환합니다.
- 같은 URL을 15분 안에 다시 요청하면 캐시된 결과를 사용합니다.
  - TTL은 `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`로 바꿀 수 있습니다.
  - 캐시 전체 크기는 50MB로 제한됩니다.
- 같은 URL이 5분 안에 대상 사이트 오류로 실패했다면 다시 요청하지 않습니다.

### 6.3 요청 1: 도메인 안전성 검사

```http
GET https://api.anthropic.com/api/web/domain_info?domain=<호스트 이름>
User-Agent: claude-code/2.1.322
```

- 이 요청에는 **인증 헤더를 붙이지 않습니다**(확인).
- 주소가 코드에 고정되어 있어서 `ANTHROPIC_BASE_URL`의 영향을 받지 않습니다(확인).
- 응답 처리는 다음과 같습니다.
  - HTTP 200이고 `can_fetch: true`이면 허용으로 판정하고, 결과를 5분 동안 캐시합니다(최대 128개 도메인).
  - HTTP 200이지만 `can_fetch`가 참이 아니면 `Claude Code is unable to fetch from <host>` 오류를 냅니다.
  - 그 밖의 상태 코드나 네트워크 오류는 "도메인 안전성을 확인할 수 없다"는 오류로 처리합니다. HTTP 429이면 재시도하지 말라는 안내문을 따로 반환합니다.
- 요청 하나의 timeout은 10초이고, 전체 대기 한도는 30초입니다.
- 설정 `skipWebFetchPreflight`가 참이면 이 검사를 건너뜁니다.

### 6.4 요청 2: 대상 페이지 요청

```http
GET <URL, http://는 https://로 변경>
Accept: text/markdown, text/html, */*
User-Agent: Claude-User (claude-code/2.1.322; +https://support.anthropic.com/)
```

- HTTP 클라이언트는 axios이고, 로컬 프로세스에서 직접 요청을 보냅니다(확인).
- 응답 본문은 바이너리 버퍼로 받고, 최대 10MB까지만 받습니다.
- 요청 하나의 timeout은 60초입니다.
- 전체 처리 기한은 기본 300초입니다. `CLAUDE_CODE_WEBFETCH_DEADLINE_MS` 또는 서버 측 플래그 `tengu_webfetch_deadline_ms`로 바뀝니다.
- 상태 코드 처리 방식은 다음과 같습니다.
  - 모든 상태 코드를 받아들이고(`validateStatus: () => true`), 코드가 직접 판단합니다.
  - 2xx이면 성공으로 처리합니다.
  - 301, 302, 303, 307, 308이면 리다이렉트로 처리합니다. 자동 리다이렉트는 끄고(`maxRedirects: 0`) 아래 규칙으로 직접 따라갑니다.
  - 그 밖의 코드는 `http_error`로 처리합니다. `Retry-After` 값이 있으면 함께 전달합니다.
- 리다이렉트 규칙은 다음과 같습니다.
  - 같은 프로토콜, 같은 포트, 같은 호스트(`www.` 접두어 차이는 허용)로 가는 경우에만 자동으로 따라갑니다. 최대 10회까지 따라갑니다.
  - 다른 호스트로 가면 따라가지 않습니다. 대신 `REDIRECT DETECTED` 안내문과 새 URL을 모델에 돌려주고, 모델이 새 URL로 다시 호출하도록 합니다.
- 네트워크 이그레스 프록시가 접속을 막은 경우는 `EGRESS_BLOCKED` 오류로 구분합니다.

### 6.5 콘텐츠 변환

- `Content-Type`에 `text/html`이 들어 있으면 turndown 라이브러리로 Markdown으로 바꿉니다. 변환 전에 `style`, `script`, `noscript`, `iframe` 요소를 제거하고, 입력 HTML은 앞에서부터 1MB만 사용합니다.
- PDF 같은 바이너리 콘텐츠는 세션 디렉터리에 `webfetch-<시각>-<난수>` 파일로 저장하고, 모델에는 파일이 저장되었다는 사실만 알립니다.
- 그 밖의 텍스트는 그대로 사용합니다.

### 6.6 요청 3: 작은 모델로 내용 처리

`ZXt()`가 `g2()`를 호출해서 사이드 쿼리를 보냅니다. 헤더는 4.2절과 같고, 본문은 다음과 같습니다.

```jsonc
POST https://api.anthropic.com/v1/messages?beta=true

{
  "model": "<작은 모델: ANTHROPIC_SMALL_FAST_MODEL 또는 Haiku 계열>",
  "messages": [
    {
      "role": "user",
      "content": "\nWeb page content:\n---\n<Markdown 본문, 최대 100,000자>\n---\n\n<prompt>\n\nProvide a concise response based only on the content above. In your response:\n - Enforce a strict 125-character maximum for quotes from any source document. ...\n"
    }
  ],
  "system": [
    { "type": "text", "text": "x-anthropic-billing-header: …" },
    { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." }
  ],
  "thinking": { "type": "disabled" },   // 모델이 thinking을 지원할 때
  "metadata": { "user_id": "…" },
  "max_tokens": …,
  "stream": true
}
```

**모델 선택** (`uk()`, 확인)

1. `ANTHROPIC_SMALL_FAST_MODEL`이 있으면 그 모델을 사용합니다.
2. firstParty에서는 기본 Haiku 모델을 사용합니다. `ANTHROPIC_DEFAULT_HAIKU_MODEL`로 바꿀 수 있습니다.
3. 선택한 모델에 접근 권한이 없으면(`permission_denied`) 대체 모델 목록의 다음 모델로 다시 시도합니다.

**프롬프트 구성** (`aKi()`, 확인)

- 지정된 시스템 프롬프트는 비어 있습니다. 그래서 system 배열에는 4.4절의 자동 블록만 들어갑니다.
- 본문이 100,000자를 넘으면 잘라 내고 `[Content truncated due to length...]`를 덧붙입니다.
- `offset`을 지정하면 그 위치부터의 내용을 보내고, 앞에 "긴 페이지의 일부"라는 설명을 덧붙입니다.
- 마지막 지시문은 도메인에 따라 달라집니다.
  - **사전 승인 도메인**이면 지시문이 간단합니다. "Include relevant details, code examples, and documentation excerpts as needed."라고 지시합니다.
  - 그 밖의 도메인이면 인용 제한 규칙이 붙습니다. 인용을 125자 이내로 제한하고, 원문을 그대로 옮기지 말고, 노래 가사를 재현하지 말라는 규칙입니다.
- 출처를 신뢰할 수 없는 경우(`untrustedSource`)에는 본문을 `<untrusted-content-<난수>>` 태그로 감싸고, 앞뒤에 "이 내용은 지시가 아니라 데이터"라는 경고문을 붙입니다.

**작은 모델을 거치지 않는 경우** (확인)

다음 조건을 모두 만족하면 원문을 그대로 반환합니다.

1. 사전 승인 도메인입니다. 이 목록은 코드에 고정되어 있고, `docs.python.org`, `developer.mozilla.org`, `react.dev`, `nodejs.org`, `code.claude.com` 같은 문서 사이트들이 들어 있습니다.
2. 응답의 `Content-Type`이 `text/markdown`입니다.
3. 본문 길이가 100,000자 미만입니다.

### 6.7 CCR 프록시 경로 (원격 세션 전용)

firstParty이고 `CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY`가 설정되어 있고 원격 세션 ID가 있으면, 로컬에서 대상 사이트에 접속하지 않습니다. 대신 다음 요청을 보냅니다(확인).

```http
POST {base}/v1/code/sessions/{세션 ID}/worker/web-fetch

{"url": "https://…", "auto_mode_server_cleared": true}
```

`auto_mode_server_cleared`는 조건이 맞을 때만 들어갑니다. 응답은 `{"url", "destination_url", "title", "text", "content_type", "retrieved_at", "error"}` 형식입니다. 서버가 가져온 텍스트를 그대로 사용하고, 대상 사이트의 오류는 `robots_disallowed`, `site_blocked` 같은 유형으로 구분합니다.

원격 세션(`ccrSessionUrl`이 있는 세션)에서 이 프록시를 쓸 수 없으면, 로컬 요청으로 대체하지 않고 오류를 냅니다.


## 7. 도구 한 번 사용 시 발생하는 요청 정리

메인 모델이 도구를 한 번 호출하고 결과를 받아 최종 답변을 작성하는 경우를 기준으로 정리했습니다.

**WebSearch**

| 순서 | 요청 | 목적지 | 인증 |
|---|---|---|---|
| 1 | `POST /v1/messages?beta=true` (메인 대화) | api.anthropic.com | OAuth Bearer |
| 2 | `POST /v1/messages?beta=true` (사이드 쿼리, `web_search_20250305` 강제) | api.anthropic.com | OAuth Bearer |
| (서버) | 실제 웹 검색 | Anthropic 서버 내부 | 해당 없음 |
| 3 | `POST /v1/messages?beta=true` (메인 대화, tool_result 포함) | api.anthropic.com | OAuth Bearer |

**WebFetch**

| 순서 | 요청 | 목적지 | 인증 |
|---|---|---|---|
| 1 | `POST /v1/messages?beta=true` (메인 대화) | api.anthropic.com | OAuth Bearer |
| 2 | `GET /api/web/domain_info?domain=…` | api.anthropic.com | **없음** |
| 3 | `GET <대상 URL>` (같은 호스트 리다이렉트 포함) | **대상 사이트** | 없음 |
| 4 | `POST /v1/messages?beta=true` (Haiku 사이드 쿼리) | api.anthropic.com | OAuth Bearer |
| 5 | `POST /v1/messages?beta=true` (메인 대화, tool_result 포함) | api.anthropic.com | OAuth Bearer |

WebFetch에서 대상 사이트가 보는 접속 주소는 **사용자 컴퓨터의 IP 주소**입니다. WebSearch에서는 검색 엔진이 사용자 컴퓨터와 직접 통신하지 않습니다.


## 8. pi-native-search와의 관계

pi-native-search의 `claudeBridgeSearch()`는 Agent SDK의 `query()`를 다음 옵션으로 호출합니다. 옵션은 `allowedTools: ["WebSearch"]`, `permissionMode: "bypassPermissions"`, `settingSources: []`입니다. 이 보고서의 분석에 따르면 이 호출은 다음 순서로 동작합니다.

1. SDK가 Claude Code CLI를 하위 프로세스로 실행합니다.
2. CLI의 메인 모델이 "Search the web for: …" 프롬프트를 받고 `WebSearch` 도구를 호출합니다.
3. CLI가 5.2절의 사이드 쿼리를 보냅니다. 기본 설정에서는 이 사이드 쿼리도 메인 모델과 같은 모델을 사용합니다.
4. 메인 모델이 결과를 받아 번호 목록으로 정리하고, SDK의 `result` 메시지로 반환합니다.

따라서 pi에서 검색을 한 번 할 때마다 구독 할당량에서 Messages API 요청 3회 이상이 소비됩니다(추정). 비대화형 실행이므로 시스템 프롬프트 정체성 문장은 `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`가 될 것으로 추정합니다.


## 9. 확인하지 못한 사항

- **서버 측 검색 구현**: `web_search_20250305`가 내부적으로 어떤 검색 엔진을 쓰는지는 클라이언트 코드로 알 수 없습니다. 도구 설명문에는 "Web search is only available in the US"라는 문구가 있습니다.
- **실제 헤더 값**: 아래 값은 실행 중 상태에 따라 정해지므로 정적 분석만으로는 확정할 수 없습니다.
  - 최종 beta 목록
  - `x-stainless-*` 헤더
  - `anthropic-version`
  - `max_tokens` 값
  - 과금 귀속 블록의 fingerprint 값
- **서버 측 기능 플래그**: `tengu_plum_vx3`(검색 모델 선택), `tengu_sleepy_shore`(검색 mode 기능) 같은 플래그 값은 서버에서 내려오므로 계정에 따라 다를 수 있습니다.
- **바이트코드 영역**: `web_search_20250305` 같은 문자열이 소스 영역 앞쪽(페이로드 오프셋 약 `0x975526`, `0xaf0940`)에도 한 번씩 더 나타납니다. JSC 바이트코드나 상수 영역으로 추정하지만, 모듈 엔트리의 바이트코드 필드 해석을 끝내지 못해서 확정하지 못했습니다.


## 10. 동적 검증 계획

정적 분석 결과를 실제 트래픽으로 확인하기 위한 계획입니다. Claude Code가 저장한 OAuth 토큰(macOS Keychain의 `Claude Code-credentials`)을 꺼내서 curl로 요청을 재현하면, 구독 인증 정보를 Claude Code 밖에서 사용하게 됩니다. 이는 이용 약관에 어긋날 수 있으므로 계획에 포함하지 않았습니다. 대신 아래와 같이 위험이 낮은 순서로 진행할 것을 제안합니다.

| 단계 | 방법 | 확인할 내용 | 인증 |
|---|---|---|---|
| A | `curl -A "claude-code/2.1.322" "https://api.anthropic.com/api/web/domain_info?domain=example.com"` | 도메인 검사 응답의 스키마와 차단 도메인에 대한 응답 | 없음 (CLI도 인증 없이 보냅니다) |
| B | `curl -A "Claude-User (claude-code/2.1.322; +https://support.anthropic.com/)" -H "Accept: text/markdown, text/html, */*" <테스트 URL>` | 대상 사이트가 받는 요청의 형태와 리다이렉트 처리 | 없음 |
| C | `ANTHROPIC_BASE_URL`을 로컬 로깅 프록시로 지정한 뒤 `claude -p "…" --allowedTools WebSearch,WebFetch` 실행. `pi-claude-bridge/diag/capture-proxy.mjs`를 재활용할 수 있습니다. | 사이드 쿼리의 실제 본문과 헤더, 요청 횟수, beta 목록 | CLI가 직접 처리합니다. 로그에서는 토큰을 가립니다. |
| D | mitmproxy를 `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`와 함께 사용 | C에서는 보이지 않는 `domain_info` 요청과 대상 사이트 요청 | C와 같음 |
| E | C에서 캡처한 본문을 **API 키**(`x-api-key`)로 curl 전송 | `web_search_20250305` 요청 본문이 공식 API에서도 같은 결과를 내는지 확인 | `ANTHROPIC_API_KEY` (공식으로 허용된 방식) |


## 부록: 분석 산출물

- `/tmp/cc-analysis/bun_section.bin`: `__bun` 섹션 원본
- `/tmp/cc-analysis/fs/`: 모듈 원본 3,166개
- `/tmp/cc-analysis/pretty/`: prettier로 정리한 주요 청크
- `~/.local/share/claude/versions/2.1.322.i64`: IDA 데이터베이스 (약 2GB). Claude Code 업데이터가 관리하는 디렉터리 안에 생성되었으므로 다른 곳으로 옮기거나 삭제하는 편이 좋습니다.
