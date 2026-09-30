/**
 * RequireConnection — the Source / Prompt / Output tabs need a live inference
 * connection. Denial sends the visitor to /connect and remembers where they
 * were headed. Client guards predict; the server enforces on every API call.
 */
import { Guard, type Destination, type GuardContext } from '@diamondjs/runtime'
import { session } from '../services/session.ts'

export class RequireConnection extends Guard {
  static override check(): boolean {
    return session.state.connected
  }
  static override deny({ to }: GuardContext): Destination {
    return { type: 'route-id', target: 'connect', query: { returnTo: to } }
  }
}
