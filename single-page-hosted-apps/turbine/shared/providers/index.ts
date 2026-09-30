/**
 * shared/providers — import this module (not the individual backends) so every
 * backend registers itself before createProvider() is called.
 */
import './openai.ts'
import './ollama.ts'
import './anthropic.ts'

export { createProvider, hasProvider, registerProvider, registeredApiTypes, type ProviderFactory } from './registry.ts'
export { OpenAICompatibleProvider } from './openai.ts'
export { OllamaProvider } from './ollama.ts'
export { AnthropicProvider } from './anthropic.ts'
export {
  PRESETS, presetById, classifyLocality, parseBaseUrl, buildBaseUrl, normalizeConnection, connectionFromPreset,
  ConnectionValidationError, type Preset, type UrlParts,
} from './presets.ts'
export { scrubSecret, type FetchLike } from './http.ts'
