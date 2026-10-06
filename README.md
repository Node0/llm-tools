# llm-tools

Small, sharp tools for working with language models. Swiss army knife tools as single HTML files you can open from disk.


## Static single-page apps

Self-contained HTML files in **[`single-page-apps/`](single-page-apps/)**. Open them in a browser; no server, no build.

| App | What it does | Try it |
|---|---|---|
| **Tokens Per Second Simulator** | Type a tokens-per-second rate, pick a corpus, and watch text stream at that speed. Useful for feeling what a model's throughput number means. | [GitHub Pages](https://node0.github.io/llm-tools/single-page-static-apps/tkps_simulator.html) |
| **Text Stats Analyzer** | Characters, lines and a whitespace token estimate for any pasted text. | [GitHub Pages](https://node0.github.io/llm-tools/single-page-static-apps/text_stats_analyzer.html) |
| **OpenAI TTS Inspector** | Poke at OpenAI's text-to-speech endpoint from a single page. | open `openai_tts_inspector.html` |

## Scripts

- **`python-tools/`** — an Ollama CLI prompt utility and a tokens-per-second versus GPU-count optimizer.
- **`cli-tools/`** — shell helpers.


## Contributing

Issues and pull requests are welcome. 
## License

AGPL-3.0. See [LICENSE](LICENSE).
