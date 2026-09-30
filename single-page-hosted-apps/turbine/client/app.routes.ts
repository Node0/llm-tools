/**
 * client/app.routes.ts — the whole navigation surface, as data.
 * Validated at build time by `route-check client/app.routes.ts`.
 */
import type { RouteMap } from '@diamondjs/runtime'
import { RequireConnection } from './guards/require-connection.ts'
import { ConnectPage } from './pages/connect/connect.ts'
import { NotFoundPage } from './pages/not-found.ts'
import { OutputPage } from './pages/output/output.ts'
import { PromptPage } from './pages/prompt/prompt.ts'
import { SourcePage } from './pages/source/source.ts'

export const routes = {
  'root-redirect': {
    path: '/',
    redirect: { type: 'route-id', target: 'source' },
  },

  'source': {
    path: '/source',
    component: SourcePage,
    outlet: 'main',
    guard: RequireConnection,
  },

  'prompt': {
    path: '/prompt',
    component: PromptPage,
    outlet: 'main',
    guard: RequireConnection,
  },

  'output': {
    path: '/output',
    component: OutputPage,
    outlet: 'main',
    guard: RequireConnection,
  },

  'connect': {
    path: '/connect',
    component: ConnectPage,
    outlet: 'main',
  },

  'not-found': {
    path: '*',
    component: NotFoundPage,
    outlet: 'main',
  },
} satisfies RouteMap
