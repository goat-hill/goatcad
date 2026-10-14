<script setup lang="ts">
/**
 * Settings ▸ AI Integrations — the MCP server this app runs, and how a session
 * outside the app reaches it.
 *
 * Three things shape this pane.
 *
 * **There is no connection state to report.** An agent tab opened inside
 * GoatCAD is told about the server when it launches (`partsMcpClients.ts`),
 * so no client is ever "connected" or "stale" here. What each client card
 * carries is the manual path: the text a person uses in a terminal
 * of their own, with a copy button — and nothing else, since the card is for
 * copying, not reading about.
 *
 * **The badge is the only place status is reported**, following the
 * Distributor APIs card next door: the server's state is a `status-badge`,
 * never colored prose, and never the same fact said twice.
 *
 * **Nothing appears or disappears.** Each card keeps one note line, rendered
 * whether or not it has anything to say, so a copy or a token replacement
 * changes text in place instead of shoving the buttons under the pointer.
 *
 * **The API is inspected last, each fact once.** Below the cards, the
 * prompts and the tools (grouped by the domain of their `domain.verb` name,
 * in the registry's order) read from the server's own registries
 * (`mcp:surface`). A row names a tool; opening it shows the rest once each:
 * summary, flags, guidance, arguments and examples.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { abbreviateHome } from '../../lib/displayPath'
import Icon from '../shared/Icon.vue'
import type {
  McpArgumentInfo,
  McpClientId,
  McpClientInfo,
  McpServerStatus,
  McpSurface,
  McpToolInfo
} from '../../../../preload/mcpTypes'

const { t } = useI18n()

const status = ref<McpServerStatus | null>(null)
const busy = ref(false)
/** Transient per-card text: a copy, a replaced token, a failure. */
const note = ref<Partial<Record<McpClientId | 'token', string>>>({})

const refresh = async (): Promise<void> => {
  status.value = await window.api.mcpStatus()
}

const surface = ref<McpSurface | null>(null)

onMounted(async () => {
  await refresh()
  surface.value = await window.api.mcpSurface()
})

const clients = computed((): McpClientInfo[] => status.value?.clients ?? [])

/** The tools by domain, each domain where its first tool sits in the registry. */
const toolGroups = computed((): Array<{ domain: string; tools: McpToolInfo[] }> => {
  const groups = new Map<string, McpToolInfo[]>()
  for (const tool of surface.value?.tools ?? []) {
    const group = groups.get(tool.domain)
    if (group) group.push(tool)
    else groups.set(tool.domain, [tool])
  }
  return [...groups].map(([domain, tools]) => ({ domain, tools }))
})

/** Rows opened for detail, by tool name or prompt command. */
const open = ref(new Set<string>())
const toggle = (key: string): void => {
  const next = new Set(open.value)
  if (!next.delete(key)) next.add(key)
  open.value = next
}

/** An argument's shape after its type: its values, or its bounds. */
const constraint = (argument: McpArgumentInfo): string => {
  if (argument.values) return argument.values.join(' | ')
  if (argument.min !== undefined && argument.max !== undefined)
    return `${argument.min}–${argument.max}`
  if (argument.min !== undefined) return `≥ ${argument.min}`
  if (argument.max !== undefined) return `≤ ${argument.max}`
  return ''
}

/** Arguments with their nested fields after them, each with its depth. */
const flatten = (
  args: McpArgumentInfo[],
  depth = 0
): Array<{ argument: McpArgumentInfo; depth: number }> =>
  args.flatMap((argument) => [{ argument, depth }, ...flatten(argument.fields ?? [], depth + 1)])

const shortPath = (path: string): string => abbreviateHome(path, window.api.homeDir)

/** The one line above a client's text: run it, or add it to a named file. */
const manualLabel = (client: McpClientInfo): string =>
  client.manual === 'command'
    ? t('settings.mcp.runCommand')
    : t('settings.mcp.addToFile', { path: shortPath(client.configPath) })

const copyToken = async (): Promise<void> => {
  if (!status.value?.token) return
  await navigator.clipboard.writeText(status.value.token)
  note.value = { ...note.value, token: t('settings.mcp.tokenCopied') }
}

const copy = async (client: McpClientInfo): Promise<void> => {
  if (!client.manualText) return
  await navigator.clipboard.writeText(client.manualText)
  note.value = { ...note.value, [client.id]: t('settings.mcp.copied') }
}

/**
 * A new token restarts the listener. Tabs opened from GoatCAD are handed the
 * token at launch, so they pick it up on their own; the token and the client
 * texts change under the button, which is why the note says to copy again.
 */
const regenerate = async (): Promise<void> => {
  busy.value = true
  note.value = {}
  const result = await window.api.mcpRegenerateToken()
  await refresh()
  busy.value = false
  note.value = {
    token: result.ok
      ? t('settings.mcp.tokenReplaced')
      : (result.detail ?? t('settings.mcp.regenerateFailed'))
  }
}
</script>

<template>
  <div class="setting-row">
    <div class="mcp-card">
      <div class="mcp-head">
        <span class="mcp-name">{{ t('settings.mcp.serverHeading') }}</span>
        <span class="status-badge" :class="status?.running ? 'is-ok' : 'is-neutral'">
          {{ status?.running ? t('settings.mcp.running') : t('settings.mcp.stopped') }}
        </span>
      </div>

      <p class="mcp-note" :class="{ 'is-error': status && !status.running }">
        <template v-if="status && !status.running">{{ t('settings.mcp.notRunning') }}</template>
        <template v-else-if="status?.url">
          {{ t('settings.mcp.listening', { url: status.url }) }}
        </template>
      </p>

      <!-- The token, for a client that has no card below, on its own line in a
           field so it selects like a value; the buttons sit beside it. -->
      <label class="mcp-token-label" for="mcp-token">{{ t('settings.mcp.tokenLabel') }}</label>
      <div class="mcp-token-row">
        <input
          id="mcp-token"
          class="field-md mcp-token"
          type="text"
          readonly
          spellcheck="false"
          :value="status?.token ?? ''"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button class="btn-outline btn-md" :disabled="busy || !status?.token" @click="copyToken">
          {{ t('settings.mcp.copyToken') }}
        </button>
        <button class="btn-outline btn-md" :disabled="busy" @click="regenerate">
          {{ t('settings.mcp.regenerate') }}
        </button>
      </div>

      <p class="mcp-note" :class="{ 'is-error': !note.token && status?.tokenReset }">
        {{ note.token || (status?.tokenReset ? t('settings.mcp.tokenReset') : '') }}
      </p>
    </div>

    <!-- One card per client: its name, the one line that says what to do with
         the text, the text, and Copy. -->
    <div v-for="client in clients" :key="client.id" class="mcp-card">
      <div class="mcp-head">
        <!-- A product name: a proper noun, never run through t(). -->
        <span class="mcp-name">{{ client.name }}</span>
        <button
          class="btn-subtle btn-md"
          :disabled="busy || !client.manualText"
          @click="copy(client)"
        >
          {{ t('settings.mcp.copy') }}
        </button>
      </div>

      <p class="mcp-note">{{ note[client.id] || manualLabel(client) }}</p>

      <!-- Rendered whether or not the server is up, so the card keeps its
           shape; empty while there is nothing to point at. -->
      <pre class="mcp-manual-text"><code>{{ client.manualText ?? '' }}</code></pre>
    </div>

    <!-- What the server exposes, from its own registries. -->
    <div v-if="surface" class="mcp-card">
      <div class="mcp-head">
        <span class="mcp-name">{{ t('settings.mcp.apiHeading') }}</span>
      </div>

      <h4 class="mcp-section">
        {{ t('settings.mcp.promptsLabel') }}
        <span class="mcp-count">{{ surface.prompts.length }}</span>
      </h4>
      <div v-for="prompt in surface.prompts" :key="prompt.command" class="mcp-api">
        <button
          class="mcp-api-row"
          type="button"
          :aria-expanded="open.has(prompt.command)"
          @click="toggle(prompt.command)"
        >
          <Icon
            :name="open.has(prompt.command) ? 'chevron-down' : 'chevron-right'"
            class="mcp-chevron"
          />
          <code class="mcp-api-name">{{ prompt.command }}</code>
        </button>
        <div v-if="open.has(prompt.command)" class="mcp-api-detail">
          <p class="mcp-prose">{{ prompt.description }}</p>
          <span class="mcp-detail-label">{{ t('settings.mcp.arguments') }}</span>
          <p v-if="!prompt.arguments.length" class="mcp-none">
            {{ t('settings.mcp.noArguments') }}
          </p>
          <table v-else class="mcp-args">
            <tr v-for="argument in prompt.arguments" :key="argument.name">
              <td>
                <code>{{ argument.name }}</code>
              </td>
              <td class="mcp-arg-need">
                {{ argument.required ? t('settings.mcp.required') : t('settings.mcp.optional') }}
              </td>
              <td>{{ argument.description }}</td>
            </tr>
          </table>
        </div>
      </div>

      <h4 class="mcp-section">
        {{ t('settings.mcp.toolsLabel') }}
        <span class="mcp-count">{{ surface.tools.length }}</span>
      </h4>
      <section v-for="group in toolGroups" :key="group.domain" class="mcp-domain">
        <!-- The domain of the tools' domain.verb names: an identifier, not copy. -->
        <h5 class="mcp-domain-name">
          <code>{{ group.domain }}</code>
          <span class="mcp-count">{{ group.tools.length }}</span>
        </h5>
        <div v-for="tool in group.tools" :key="tool.name" class="mcp-api">
          <button
            class="mcp-api-row"
            type="button"
            :aria-expanded="open.has(tool.name)"
            @click="toggle(tool.name)"
          >
            <Icon
              :name="open.has(tool.name) ? 'chevron-down' : 'chevron-right'"
              class="mcp-chevron"
            />
            <code class="mcp-api-name">{{ tool.mcpName }}</code>
          </button>
          <div v-if="open.has(tool.name)" class="mcp-api-detail">
            <p class="mcp-prose">{{ tool.summary }}</p>
            <dl class="mcp-facts">
              <dt>{{ t('settings.mcp.http') }}</dt>
              <dd>
                <code>POST /v1/ops/{{ tool.name }}</code>
              </dd>
              <dt>{{ t('settings.mcp.scope') }}</dt>
              <dd>
                <code>{{ tool.scope }}</code>
              </dd>
              <dt>{{ t('settings.mcp.effect') }}</dt>
              <dd>{{ tool.mutates ? t('settings.mcp.mutates') : t('settings.mcp.readsOnly') }}</dd>
            </dl>
            <p v-if="tool.guidance" class="mcp-prose">{{ tool.guidance }}</p>

            <span class="mcp-detail-label">{{ t('settings.mcp.arguments') }}</span>
            <p v-if="!tool.arguments.length" class="mcp-none">
              {{ t('settings.mcp.noArguments') }}
            </p>
            <table v-else class="mcp-args">
              <tr v-for="row in flatten(tool.arguments)" :key="`${row.depth}:${row.argument.name}`">
                <td :style="{ paddingLeft: `${row.depth * 16}px` }">
                  <code>{{ row.argument.name }}</code>
                </td>
                <td class="mcp-arg-type">
                  <code>{{ row.argument.type }}</code>
                  <span v-if="constraint(row.argument)" class="mcp-arg-constraint">
                    {{ constraint(row.argument) }}
                  </span>
                </td>
                <td class="mcp-arg-need">
                  {{
                    row.argument.required ? t('settings.mcp.required') : t('settings.mcp.optional')
                  }}
                </td>
                <td>{{ row.argument.description ?? '' }}</td>
              </tr>
            </table>

            <template v-if="tool.examples.length">
              <span class="mcp-detail-label">{{ t('settings.mcp.examples') }}</span>
              <div v-for="(example, i) in tool.examples" :key="i" class="mcp-example">
                <p class="mcp-none">{{ example.note }}</p>
                <pre
                  class="mcp-manual-text"
                ><code>{{ JSON.stringify(example.args, null, 2) }}</code></pre>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mcp-card {
  margin-bottom: 16px;
  padding: 14px;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
}

.mcp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mcp-name {
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

/* Reserved: the line exists whether or not it has anything to say, so nothing
   below it moves when it starts saying something. */
.mcp-note {
  min-height: 18px;
  margin: 6px 0 0;
  font-size: var(--text-caption);
  line-height: 1.45;
  color: var(--vscode-text-muted);
}

.mcp-note.is-error {
  color: var(--vscode-error);
}

/* The API inspector: sections, domains, rows that open for detail. */
.mcp-section {
  margin: 14px 0 4px;
  font-size: var(--text-body);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.mcp-count {
  margin-left: 6px;
  font-weight: 400;
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

.mcp-domain {
  margin-top: 8px;
}

.mcp-domain-name {
  margin: 0 0 2px;
  font-size: var(--text-body-sm);
  font-weight: 600;
}

.mcp-domain-name code,
.mcp-api code,
.mcp-args code {
  font-family: var(--font-mono);
  color: var(--vscode-text-light);
}

.mcp-api-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: var(--text-body-sm);
  text-align: left;
  cursor: pointer;
}

.mcp-api-row:hover {
  background: var(--vscode-bg-hover);
}

.mcp-chevron {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  align-self: center;
  color: var(--vscode-text-muted);
}

.mcp-api-name {
  flex-shrink: 0;
}

.mcp-api-detail {
  margin: 2px 0 10px 24px;
  font-size: var(--text-body-sm);
  line-height: 1.5;
}

.mcp-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 4px 0 8px;
}

.mcp-facts dt,
.mcp-detail-label,
.mcp-arg-need,
.mcp-arg-constraint,
.mcp-none {
  color: var(--vscode-text-muted);
}

.mcp-facts dd {
  margin: 0;
}

.mcp-prose {
  margin: 0 0 8px;
  color: var(--vscode-text);
}

.mcp-detail-label {
  display: block;
  margin-top: 8px;
  font-size: var(--text-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mcp-none {
  margin: 2px 0;
}

.mcp-args {
  width: 100%;
  margin-top: 2px;
  border-collapse: collapse;
}

.mcp-args td {
  padding: 3px 12px 3px 0;
  vertical-align: top;
  border-bottom: 1px solid var(--vscode-border);
}

.mcp-arg-type,
.mcp-arg-need {
  white-space: nowrap;
}

.mcp-arg-constraint {
  margin-left: 6px;
  white-space: normal;
}

.mcp-example {
  margin-top: 4px;
}

.mcp-token-label {
  display: block;
  margin-top: 10px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.mcp-token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/* Look from `.field-md`; only the layout is local (DESIGN §Form controls). */
.mcp-token {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}

/* The copyable text, wrapped rather than scrolled: a registration line is
   long, and a person reads it before they trust it. */
.mcp-manual-text {
  min-height: 18px;
  margin: 8px 0 0;
  padding: 6px 8px;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.45;
  color: var(--vscode-text-light);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
