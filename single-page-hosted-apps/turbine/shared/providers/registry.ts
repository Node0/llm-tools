/**
 * shared/providers/registry.ts — Crystallizer's PROVIDER_REGISTRY, in TypeScript.
 *
 * A factory per api_type. `createProvider(spec, apiKey)` is the only way the
 * engine, the server and the browser obtain a Provider — nobody news a backend
 * class directly, so swapping or adding a wire protocol is one registration.
 */

import type { ApiType, ConnectionSpec, Provider } from '../types.ts'
import type { FetchLike } from './http.ts'

export type ProviderFactory = (spec: ConnectionSpec, apiKey: string | null, fetchImpl?: FetchLike) => Provider

const REGISTRY = new Map<ApiType, ProviderFactory>()

export function registerProvider(apiType: ApiType, factory: ProviderFactory): void {
  if (REGISTRY.has(apiType)) throw new Error(`Provider type '${apiType}' already registered`)
  REGISTRY.set(apiType, factory)
}

export function hasProvider(apiType: string): apiType is ApiType {
  return REGISTRY.has(apiType as ApiType)
}

export function registeredApiTypes(): ApiType[] {
  return [...REGISTRY.keys()]
}

export function createProvider(spec: ConnectionSpec, apiKey: string | null, fetchImpl?: FetchLike): Provider {
  const factory = REGISTRY.get(spec.api_type)
  if (!factory) throw new Error(`Provider type '${spec.api_type}' not registered`)
  if (spec.requires_key && !apiKey) {
    throw new Error(`Connection '${spec.name}' requires an API key and none was supplied`)
  }
  return factory(spec, apiKey, fetchImpl)
}
