/**
 * What the `workspace.*` ops share: the service they reach, and the refusal
 * when a server has none (`ops/context.ts`, `WorkspaceService`).
 */
import type { OpContext, WorkspaceService } from '../context'
import { internal, type OpFailure } from '../errors'

export const workspaceService = (ctx: OpContext): WorkspaceService | OpFailure =>
  ctx.workspaces ?? internal('This server keeps no workspaces.', 'no-bridge')

export const isFailure = (value: WorkspaceService | OpFailure): value is OpFailure => 'ok' in value
