<p align="center">
  <img src="docs/turbine-hero.png" alt="Turbine: a turbine rotor with blue streams of text flowing in and gold streams flowing out" width="900">
</p>

# Turbine

A programmable sliding-window **map/reduce pump for long documents**. Turbine reads a source text, tiles it into windows, applies your prompt to each window (in parallel, or sequentially with carry-forward), validates the result, checkpoints every window, and concatenates the outputs into `<source>__transformed.md`.

It is a browser-hosted app: **DiamondJS** front end, **Elysia on Bun** back end. Run it on your Mac, on a LAN box, or on a public server. Inference comes from wherever you point it: Ollama, vLLM, llama.cpp, OpenRouter, OpenAI, Anthropic, or any OpenAI-compatible endpoint.

Its first job is cleaning up the public-domain embeddings-profiler corpus that `tools/fetch_corpus.ts` builds, but the instructions are arbitrary: style rewrites, translation, annotation, extraction, anything that fits in a window.

---

## How it works

```
source text ──► planner ──► [ctx_before | FOCUS | ctx_after] × N windows
                                   │
                    prompt template + your instructions
                                   │
                              provider.generate()  (streamed)
                                   │
                              validator (none | conserve | length-ratio)
                                   │  retry at lower temperature, then flag
                              checkpoint  <stem>__turbine.jsonl
                                   │
                    assemble in index order ──► <stem>__transformed.md
```

- **Focus regions tile the document with no overlap.** Only the focus is transformed and emitted, so outputs concatenate cleanly. The context on either side is read-only and may overlap.
- Focus boundaries snap to a **paragraph break**, then a **sentence end**, then whitespace, then a hard cut.
- **map** runs windows in parallel with a concurrency limit; results land by index.
- **fold** runs windows in order and can carry the tail of the previous *output* into the next prompt. This is the actual "reduce".
- Every finished window is one JSON line in the checkpoint file, with the model, connection, prompt hash, timing, token usage and validation result. Jobs resume from it; single windows can be re-run.
- The **conserve** validator strips Markdown from the output and checks that the words still match the input. Use it whenever the model must format, not rewrite.

Prompt template variables: `{{context_before}}`, `{{focus}}`, `{{context_after}}`, `{{carry}}`, `{{window_index}}`, `{{window_count}}`, `{{source_name}}`. Blocks like `{{#carry}}…{{/carry}}` render only when the variable is non-empty.

### Tokens, not characters

Everything the model measures is in tokens, so the UI leads with tokens and keeps character counts small and grey. Three sources feed the numbers, best one wins:

1. **The model itself.** After every preview the backend's `usage` figures (prompt and completion tokens) are shown next to the output and used to recalibrate the plan's chars-per-token for *that* model.
2. **tiktoken (Rust → WASM, `cl100k_base`).** Loaded lazily in the browser from `/vendor/tiktoken/` (about 2 MB, cached). Selections, the preview focus, and the generated-token counter are counted exactly with it. Not any local model's exact vocabulary, but within a few percent on English prose.
3. **4 characters per token.** The fallback until either of the above is available.

While a preview streams, the token counter refreshes once a second. The output pane follows the newest text while you are at the bottom, releases when you scroll up, and re-engages when you scroll back down.

**Max output tokens** is the per-window generation ceiling sent to the backend (`max_tokens` / `num_predict`). It is not derived from the whole corpus: each window is its own request. With **Auto** on (the default) it is set to 1.5× the largest slice plus a margin, capped by what the model's context leaves after the largest prompt. Set it by hand and the plan warns if it falls below the largest slice, because that window's output would be cut off.

**Min similarity** (the conserve validator) strips Markdown from the output, normalises case, quotes, dashes and punctuation on both sides, splits into words, and scores `2·LCS / (|input| + |output|)` where LCS is the longest common subsequence of words. 1.0 means every word survived in order; 0.95 tolerates roughly one word in twenty added, dropped or changed.

Hover help for every field lives in `client/tooltips.json`, keyed `view → component → field`, so wording can be revised without touching templates.

### The context window and the sliding window

Two different things share the word "window":

- **The model's context window** is how many tokens the backend can hold at once, prompt and answer together. You set it on the Connect page as *Context length*; it becomes the connection's `ctx_len`.
- **Turbine's sliding windows** are the slices the planner cuts the document into: focus plus context on either side.

They meet in the plan. Every planned prompt (instructions + template + context before + focus + context after + carry) must fit inside `ctx_len` together with the output limit, or the plan shows an error and *Start job* is disabled. Nothing is ever silently truncated on Turbine's side.

What the backend does with `ctx_len` depends on the dialect:

| Backend | What `ctx_len` does at runtime |
|---|---|
| **Ollama** | Sent as `options.num_ctx` on every request, so the runtime KV cache matches the plan. Set 65,536 on the Connect page and gemma4 is loaded with a 64k context, no more, no less. Override it per job with the `num_ctx` knob in Model parameters. Changing it makes Ollama reload the model; memory scales with it. |
| **vLLM / llama.cpp** | The context is fixed when the server starts (`--max-model-len`, `-c`). Turbine reads it back (`max_model_len`, `/props`) and warns when your `ctx_len` is larger than the server allows. |
| **OpenRouter / OpenAI / Anthropic** | The model's context is fixed by the provider. Turbine reads it from the model list and shows it next to your `ctx_len`; keep `ctx_len` at or below it. |

A smaller `ctx_len` therefore means smaller windows (or fewer of them fitting), a smaller *Auto* output limit, and, on Ollama, a smaller memory footprint.

### Model parameters

The *Model parameters* panel on the Prompt tab is populated by asking the backend, not from a fixed list:

| Backend | Discovery endpoint | What it yields |
|---|---|---|
| Ollama | `POST /api/show` | capabilities (`thinking`), modelfile defaults (`temperature`, `top_p`, `top_k`, `min_p`, penalties), the architecture's context length |
| OpenRouter | `GET /api/v1/models` | per-model `supported_parameters`, `context_length`, `max_completion_tokens`, `default_parameters`, and a `reasoning` descriptor (mandatory? supported efforts?) |
| OpenAI | model id rules + `/v1/models` | reasoning models (o-series, GPT-5) take `reasoning_effort` and `max_completion_tokens` and reject sampling knobs |
| vLLM | `GET /v1/models` | `max_model_len` |
| llama.cpp | `GET /props` | `n_ctx` and the server's default sampling settings |
| Anthropic | `GET /v1/models/{id}` + generation rules | context and output caps; which generations accept `thinking: disabled`, `between_tools`, or always think |

Reasoning is one normalized control (**off**, **on**, **low**, **medium**, **high**) that each provider translates: Ollama `think`, OpenRouter `reasoning.effort` / `reasoning.enabled:false`, OpenAI `reasoning_effort`, vLLM and llama.cpp `chat_template_kwargs.enable_thinking`, Anthropic `thinking` + `output_config.effort`. **Off is the default for every backend**; where a model always reasons the panel says so and offers the lowest effort instead.

Every other knob is a descriptor with bounds and plain-language help. A cleared knob is not sent, so the backend's own default applies. *Reset defaults* clears them all, sets reasoning off and temperature back to the config default, which is the right starting point for OpenRouter and Ollama alike.

---

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.2 and Node ≥ 20 (Parcel, which builds the DiamondJS client, runs under Node).

```bash
cd single-page-hosted-apps/turbine
bun install
bun run build          # compiles the client into dist/client
bun run start          # http://localhost:7331
```

Development, with the client rebuilding on save and the server restarting on change:

```bash
bun run dev
```

Checks:

```bash
bun test                  # shared engine + server tests (no network)
TURBINE_LIVE=1 bun test tests/live   # hits your local Ollama
bun run check             # typecheck + route-check + stink-check + tests
```

### DiamondJS notes

Turbine runs on DiamondJS **2.2.3**, which fixed five bugs found while building it ([#7](https://github.com/Node0/diamondjs/issues/7) first-render of `if`/`switch`/`repeat`, [#8](https://github.com/Node0/diamondjs/issues/8) static `href` and the stink gate, [#9](https://github.com/Node0/diamondjs/issues/9) `select` binding order, [#10](https://github.com/Node0/diamondjs/issues/10) `route-check` template imports, [#11](https://github.com/Node0/diamondjs/issues/11) `@reactive` under define semantics). Two settings still matter:

- `tsconfig.json` sets `experimentalDecorators: true` **and** `useDefineForClassFields: false`, the documented configuration. Since 2.2.3 reactivity no longer depends on the second flag, but it keeps the compiled output honest.
- `package.json` declares an explicit browser `targets.client` block for Parcel; without it Parcel externalized the `@diamondjs/*` imports and the page came up blank.

---

## First visit

The app looks for its own saved connection in this browser. If there is none, it asks you to choose:

- **Use local inference backend**: Ollama, vLLM or llama.cpp. You give host, port, path and model. No passphrase, because there is no secret to protect.
- **Remote inference provider**: OpenRouter, OpenAI, Anthropic or a custom OpenAI-compatible endpoint, plus your API key and a **short passphrase**. The passphrase derives a key (PBKDF2, 310k iterations, random per-browser salt) that encrypts your API key in this browser's local storage with AES-GCM. On later visits you type the passphrase to unlock.

A browser fingerprint hash is recorded alongside the vault. It never decides anything on its own; if it changes (browser update, new machine) you are simply asked for the passphrase again.

The header shows where inference is running at all times ("OpenRouter · model" or "Local: ollama @ host:port"), and a small countdown shows when the server will forget your key.

---

## Where do the API keys go?

| | Browser | Server memory | Server disk |
|---|---|---|---|
| Public deployment | AES-GCM in local storage, unlocked by your passphrase | Encrypted per session (HKDF from a boot-time master secret → AES-256-GCM), decrypted only for the duration of a request, **dropped when the session TTL elapses** | never |
| Private deployment | same | same | only if *you* put `api_key` or `api_key_env` on a connection in `config.json` |

`session.ttl_seconds` in `config.json` sets the countdown. With `extend_on_activity: true` the TTL slides on each request; the default is a fixed window. If the key expires mid-job, the job pauses in a `key-expired` state; unlock again and it resumes.

Error handlers scrub the key from any message they log. Authorization headers are never logged.

One caveat: browsers only expose WebCrypto on secure origins (https or localhost). If you open Turbine over plain http from another LAN machine, the browser cannot encrypt the key, so it remembers the connection but asks for the key again on each visit. Use https, a `.localhost` name, or put the key on a server connection in `config.json` for a private deployment.

---

## Where does inference run?

| `public_deployment` | Connection locality | Job runs in |
|---|---|---|
| `false` (your LAN) | any | the server |
| `true` | remote (OpenRouter, …) | the server, restricted to `remote_host_allowlist` |
| `true` | local (Ollama on the user's machine) | **the browser**, calling the user's own backend directly |

A public server never fetches a user-supplied URL, which closes the server-side request forgery hole; and "local" means *the user's* machine, which a public server could not reach anyway. Browser-run jobs need the tab open, and Ollama needs `OLLAMA_ORIGINS` set to the app's origin. Chrome may ask for local-network permission.

---

## config.json

```jsonc
{
  "public_deployment": false,
  "server":   { "host": "0.0.0.0", "port": 7331, "static_dir": "dist/client", "data_dir": "data", "trust_proxy": false },
  "session":  { "ttl_seconds": 3600, "extend_on_activity": false, "cookie_name": "turbine_sid" },
  "limits":   { "max_upload_bytes": 26214400, "max_concurrency": 8, "max_jobs_per_session": 4 },
  "window_defaults": { "focus_tokens": 1500, "context_before_tokens": 400, "context_after_tokens": 400,
                       "snap": "paragraph", "mode": "map", "concurrency": 2,
                       "carry": { "kind": "tail", "chars": 1200 }, "temperature": 0.2, "max_tokens": 2048,
                       "validator": { "kind": "none" }, "joiner": "\n\n" },
  "remote_host_allowlist": ["openrouter.ai", "api.openai.com", "api.anthropic.com"],
  "inference_service_connections": {
    "ollama-local": { "api_type": "ollama", "base_url": "http://localhost:11434",
                      "default_model": "qwen3.6:35b-a3b-mxfp8", "default_ctx_len": 32768,
                      "options": { "num_ctx": 32768 } },
    "openrouter":   { "api_type": "openai", "base_url": "https://openrouter.ai/api/v1",
                      "default_model": "qwen/qwen3-235b-a22b", "api_key_env": "OPENROUTER_API_KEY" }
  }
}
```

`inference_service_connections` follows Crystallizer's shape: a name, an `api_type` (`openai` | `ollama` | `anthropic`), a `base_url`, `default_*` fields and a free-form `options` passthrough. vLLM, llama.cpp and OpenRouter are all `openai`. Ollama connections send `think: false` unless `options.think` is `true`, so reasoning models spend their tokens on the transformation rather than deliberation.

Environment: `TURBINE_CONFIG` (path to a different config), `TURBINE_MASTER_SECRET` (hex, ≥ 32 bytes; otherwise a random secret is generated at boot, which is the intended default).

`app/config/config.json` is separate and belongs to DiamondJS: `run_mode` `"dev"` prints the route table and keeps dev diagnostics; `"prod"` dead-code-eliminates them. Flip it and rebuild.

---

## Layout

```
turbine/
├── config.json              server + defaults (see above)
├── app/config/config.json   DiamondJS run_mode
├── shared/                  runs in the browser AND on the server
│   ├── types.ts             ConnectionSpec, JobSpec, WindowEvent, WindowRecord …
│   ├── api.ts               the HTTP/WS contract, every route in one comment block
│   ├── defaults.ts          defaultJobSpec / validateJobSpec
│   ├── providers/           registry keyed by api_type; openai / ollama / anthropic; presets
│   └── engine/              planner, template, validators, runner (async generator), assemble
├── server/                  Elysia: sessions, key vault, docs, jobs, WS fan-out, static
├── client/                  DiamondJS: shell, routes, guards, services, pages, source viewer
│   └── tooltips.json        hover help, view → component → field
├── tools/fetch_corpus.ts    builds the 3×3 public-domain corpus (see below)
├── tests/                   bun test: shared/, server/, live/ (opt-in)
└── data/                    uploads, job checkpoints (git-ignored)
```

Output naming follows Crystallizer's double-underscore convention: `<stem>__transformed.md` for the result and `<stem>__turbine.jsonl` for the checkpoint/provenance log.

---

## The corpus

`bun run corpus -- --out ~/corpus` fetches nine public-domain books in three size tiers (≈250 / 500 / 1000 pages) across neuroscience, an adjacent science, and a literary control, strips Project Gutenberg boilerplate, rejoins hard-wrapped paragraphs, promotes headings, and writes `manifest.json` with word counts and token estimates. It uses no LLM on purpose: an embeddings corpus should carry Darwin's words, not a formatting model's. Use Turbine's **conserve** validator for whatever the deterministic pass leaves messy (Pavlov's tables, James's footnotes).

---

## License

AGPL-3.0, like the rest of this repository.
