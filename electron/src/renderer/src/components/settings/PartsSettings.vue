<script setup lang="ts">
/**
 * Settings ▸ Distributor APIs — obtaining and maintaining distributor API keys.
 *
 * The card is driven by `PartsProviderInfo` from main's registry:
 * the credential fields, their labels, the
 * registration link and the quota all arrive as data, which is why a Mouser card
 * renders one input and a DigiKey card renders two. The onboarding *prose* is
 * the exception and lives in `parts.yaml` under the provider id, because it is
 * translatable copy rather than registry data.
 *
 * **The badge is the only place status is reported.** Test connection issues a
 * real request but says nothing itself — the badge and the timestamp under it
 * are its entire output. A "Connection worked" line beneath a badge already
 * reading *Connected* is the same fact twice, and the second copy is the one
 * that goes stale. A *failure* still prints below, because "Not working" is not
 * actionable on its own: a rejected key and an unsubscribed product need
 * different fixes.
 *
 * **Saving and checking are different operations and must not look alike.**
 * Storing a key is a file write and is instant; checking it is a network round
 * trip. So the button does the instant half and returns, and the badge carries
 * `Checking… → Connected / Not working` with a Cancel while it runs.
 *
 * **Nothing here can read a stored key.** There is no getter on the bridge, so a
 * configured provider shows no input boxes at all — changing a key is Remove
 * then add, which is also why Remove is the card's only destructive control
 * rather than sitting beside a separate Replace.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  PartsCredentialStatus,
  PartsError,
  PartsProviderId,
  PartsProviderInfo,
  PartsUsage
} from '../../../../preload/partsTypes'
import { relativeTime } from '../../lib/relativeTime'

const { t, tm, rt, locale, n } = useI18n()

const providers = ref<PartsProviderInfo[]>([])
const statuses = ref<PartsCredentialStatus[]>([])
const usage = ref<PartsUsage[]>([])

/** Draft input values, per provider. Never seeded from a stored key — there is
 *  no way to read one, by design. Cleared as soon as a save succeeds. */
const drafts = ref<Record<string, Record<string, string>>>({})
/** The instant half. Set only across the credential write, so in practice this
 *  label is never seen — which is the point. */
const saving = ref<PartsProviderId | null>(null)
/** The slow half, surfaced in the badge rather than on a button. */
const checking = ref<Record<string, boolean>>({})
/**
 * Bumped to orphan an in-flight check, for Cancel and for a superseded one. The
 * request keeps running until main's deadline stops it — this only decides
 * whether we still care about the answer, which is the honest limit of what a
 * renderer can cancel over an already-sent IPC.
 */
const checkToken = ref<Record<string, number>>({})
const failure = ref<Record<string, string | undefined>>({})

const refresh = async (): Promise<void> => {
  const [info, status, meter] = await Promise.all([
    window.api.partsProviders(),
    window.api.partsCredentialStatus(),
    window.api.partsUsage()
  ])
  providers.value = info
  statuses.value = status
  usage.value = meter
  for (const provider of info) {
    if (!drafts.value[provider.id]) {
      drafts.value[provider.id] = Object.fromEntries(provider.fields.map((f) => [f.key, '']))
    }
  }
}

onMounted(refresh)

const statusFor = (id: PartsProviderId): PartsCredentialStatus | undefined =>
  statuses.value.find((status) => status.provider === id)

const usageFor = (id: PartsProviderId): PartsUsage | undefined =>
  usage.value.find((meter) => meter.provider === id)

const isConfigured = (id: PartsProviderId): boolean => statusFor(id)?.configured === true

/**
 * What the badge says. "A key is stored" and "a key works" are different facts,
 * and `unverified` is the one that would otherwise be misreported as Connected.
 */
type ConnectionState = 'none' | 'checking' | 'connected' | 'unverified' | 'failed'

const connectionState = (id: PartsProviderId): ConnectionState => {
  if (checking.value[id]) return 'checking'
  if (!isConfigured(id)) return 'none'
  if (failure.value[id]) return 'failed'
  return statusFor(id)?.lastVerifiedAt ? 'connected' : 'unverified'
}

/** Badge copy and paint, per state. Pending and unproven share the accent:
 *  both mean "not an answer yet", so neither may read as success or failure. */
const BADGE: Record<ConnectionState, { key: string; tone: string }> = {
  none: { key: 'notConnected', tone: 'is-neutral' },
  checking: { key: 'checking', tone: 'is-pending' },
  connected: { key: 'connected', tone: 'is-ok' },
  unverified: { key: 'unverified', tone: 'is-pending' },
  failed: { key: 'notWorking', tone: 'is-error' }
}

const badge = (id: PartsProviderId): { label: string; tone: string } => {
  const spec = BADGE[connectionState(id)]
  return { label: t(`settings.parts.${spec.key}`), tone: spec.tone }
}

/** "Checked 2 days ago" — the exact timestamp is noise here; what a reader wants
 *  is whether the last check was recent enough to still mean anything. */
const checkedWhen = (id: PartsProviderId): string | null => {
  const at = statusFor(id)?.lastVerifiedAt
  if (!at) return null
  const when = relativeTime(at, Date.now(), locale.value)
  return when ? t('settings.parts.verifiedAt', { when }) : t('settings.parts.justNow')
}

/** Fraction of the day's quota spent, for the meter. */
const usedFraction = (id: PartsProviderId): number => {
  const meter = usageFor(id)
  if (!meter || meter.day.limit <= 0) return 0
  return Math.min(1, meter.day.used / meter.day.limit)
}

/** The numbered steps for a provider, as a list message. */
const steps = (id: PartsProviderId): string[] => {
  const raw: unknown = tm(`parts.providers.${id}.steps`)
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => rt(entry as Parameters<typeof rt>[0]))
}

const isComplete = (provider: PartsProviderInfo): boolean =>
  provider.fields.every((field) => (drafts.value[provider.id]?.[field.key] ?? '').trim().length > 0)

/**
 * The draft as a **plain** object, built fresh from the provider's declared
 * fields.
 *
 * `drafts` is a reactive ref, so indexing it hands back a Vue Proxy — and a
 * Proxy cannot be structured-cloned, which is what Electron does to every IPC
 * argument. Passing it straight through rejects the invoke with "An object could
 * not be cloned" (RULES.md §9). Rebuilding from `provider.fields` also means
 * only declared fields are ever sent.
 */
const plainDraft = (provider: PartsProviderInfo): Record<string, string> =>
  Object.fromEntries(
    provider.fields.map((field) => [field.key, drafts.value[provider.id]?.[field.key] ?? ''])
  )

const clearDraft = (provider: PartsProviderInfo): void => {
  drafts.value = {
    ...drafts.value,
    [provider.id]: Object.fromEntries(provider.fields.map((f) => [f.key, '']))
  }
}

const setFailure = (id: PartsProviderId, message: string | undefined): void => {
  failure.value = { ...failure.value, [id]: message }
}

const errorText = (error: PartsError): string =>
  t(`parts.errors.${error.kind}`, { detail: error.detail ?? '' })

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The slow half. Never awaited by a caller that owns a button's label — the
 * badge reports it. A result whose token was superseded is dropped, so a Cancel
 * or a newer check cannot be overwritten by an older reply landing late.
 */
const check = async (provider: PartsProviderInfo): Promise<void> => {
  const token = (checkToken.value[provider.id] ?? 0) + 1
  checkToken.value = { ...checkToken.value, [provider.id]: token }
  checking.value = { ...checking.value, [provider.id]: true }
  const current = (): boolean => checkToken.value[provider.id] === token
  try {
    const result = await window.api.partsTestCredentials(provider.id)
    if (!current()) return
    setFailure(provider.id, result.ok ? undefined : errorText(result.error))
    await refresh()
  } catch (err) {
    // A rejected invoke is a bug on our side, not a distributor failure. It still
    // has to clear the badge and say something.
    if (current()) setFailure(provider.id, asMessage(err))
  } finally {
    if (current()) checking.value = { ...checking.value, [provider.id]: false }
  }
}

const cancelCheck = (provider: PartsProviderInfo): void => {
  checkToken.value = {
    ...checkToken.value,
    [provider.id]: (checkToken.value[provider.id] ?? 0) + 1
  }
  checking.value = { ...checking.value, [provider.id]: false }
}

/** The instant half: write the key, then hand off to the badge. */
const save = async (provider: PartsProviderInfo): Promise<void> => {
  saving.value = provider.id
  try {
    const result = await window.api.partsSetCredentials(provider.id, plainDraft(provider))
    if (!result.ok) {
      setFailure(provider.id, errorText(result.error))
      return
    }
    // Only clear on success: a rejected paste should stay in the box to be fixed.
    clearDraft(provider)
    setFailure(provider.id, undefined)
    await refresh()
    // Deliberately not awaited. Saving proved the key is storable, not that it
    // works, and the answer to that belongs in the badge.
    void check(provider)
  } catch (err) {
    setFailure(provider.id, t('settings.parts.saveFailed', { error: asMessage(err) }))
  } finally {
    saving.value = null
  }
}

const remove = async (provider: PartsProviderInfo): Promise<void> => {
  cancelCheck(provider)
  setFailure(provider.id, undefined)
  try {
    await window.api.partsRemoveCredentials(provider.id)
  } finally {
    await refresh()
  }
}

const openRegistration = (provider: PartsProviderInfo): void => {
  void window.api.partsOpenRegistration(provider.id)
}

/** One shared warning rather than one per card: the keyring is a property of the
 *  machine, not of a distributor. */
const keyringMissing = computed(
  () => statuses.value.length > 0 && statuses.value.every((s) => !s.encryptionAvailable)
)
</script>

<template>
  <div class="setting-row">
    <p v-if="keyringMissing" class="parts-warning">{{ t('settings.parts.noKeyring') }}</p>

    <div v-for="provider in providers" :key="provider.id" class="provider-card">
      <div class="provider-head">
        <!-- A company name: a proper noun, never run through t(). -->
        <span class="provider-name">{{ provider.name }}</span>

        <!-- The card's whole status surface. -->
        <span class="provider-status">
          <span class="status-badge" :class="badge(provider.id).tone">
            {{ badge(provider.id).label }}
          </span>
          <button
            v-if="connectionState(provider.id) === 'checking'"
            class="btn-subtle btn-sm"
            @click="cancelCheck(provider)"
          >
            {{ t('settings.parts.cancel') }}
          </button>
          <span v-else-if="checkedWhen(provider.id)" class="provider-checked">
            {{ checkedWhen(provider.id) }}
          </span>
        </span>
      </div>

      <!-- Onboarding: what someone with no key needs, in the order they need it.
           Gone once a key is stored, when the card becomes a status panel. -->
      <template v-if="!isConfigured(provider.id)">
        <p class="provider-steps-heading">{{ t('settings.parts.stepsHeading') }}</p>
        <ol class="provider-steps">
          <li v-for="(step, index) in steps(provider.id)" :key="index">{{ step }}</li>
        </ol>
        <button class="btn-cta btn-md provider-register" @click="openRegistration(provider)">
          {{ t('settings.parts.register', { name: provider.name }) }}
        </button>

        <div v-for="field in provider.fields" :key="field.key" class="provider-field">
          <label class="provider-field-label" :for="`parts-${provider.id}-${field.key}`">
            {{ t(`parts.fields.${field.labelKey}`) }}
          </label>
          <input
            :id="`parts-${provider.id}-${field.key}`"
            v-model="drafts[provider.id][field.key]"
            class="field-md provider-input"
            :type="field.secret ? 'password' : 'text'"
            spellcheck="false"
            autocomplete="off"
            :placeholder="field.placeholder ?? ''"
            @keydown.enter="isComplete(provider) && save(provider)"
          />
        </div>

        <div class="provider-actions">
          <button
            class="btn-outline btn-md"
            :disabled="!isComplete(provider) || saving === provider.id"
            @click="save(provider)"
          >
            {{ saving === provider.id ? t('settings.parts.saving') : t('settings.parts.save') }}
          </button>
        </div>
      </template>

      <!-- Connected: which key, how much of today's budget is left, and out. -->
      <template v-else>
        <p v-if="statusFor(provider.id)?.hint" class="provider-meta">
          {{ t('settings.parts.keyHint', { hint: statusFor(provider.id)?.hint }) }}
        </p>

        <div v-if="usageFor(provider.id)" class="provider-quota">
          <div class="quota-line">
            <span>
              {{
                t('settings.parts.usage', {
                  used: n(usageFor(provider.id)?.day.used ?? 0),
                  limit: n(usageFor(provider.id)?.day.limit ?? 0)
                })
              }}
            </span>
            <span class="provider-meta">{{ t('settings.parts.usageResets') }}</span>
          </div>
          <!-- A gauge, not loading feedback: the bar exists to make a small
               budget legible at a glance, which a bare fraction is not. -->
          <div
            class="quota-track"
            role="progressbar"
            :aria-valuenow="usageFor(provider.id)?.day.used ?? 0"
            aria-valuemin="0"
            :aria-valuemax="usageFor(provider.id)?.day.limit ?? 0"
          >
            <div class="quota-fill" :style="{ width: `${usedFraction(provider.id) * 100}%` }" />
          </div>
        </div>

        <div class="provider-actions">
          <!-- Reports only by side effect: the badge and the timestamp above it
               are the whole answer, so there is no confirmation line to read. -->
          <button
            class="btn-outline btn-md"
            :disabled="checking[provider.id]"
            @click="check(provider)"
          >
            {{ t('settings.parts.test') }}
          </button>
          <button class="btn-danger btn-md" @click="remove(provider)">
            {{ t('settings.parts.remove') }}
          </button>
        </div>
      </template>

      <p v-if="failure[provider.id]" class="provider-failure">{{ failure[provider.id] }}</p>
    </div>
  </div>
</template>

<style scoped>
.parts-warning {
  margin: 0 0 12px;
  font-size: var(--text-body-sm);
  line-height: 1.5;
  color: var(--vscode-accent);
}

.provider-card {
  margin-bottom: 16px;
  padding: 14px;
  border: 1px solid var(--vscode-border);
  border-radius: 4px;
}

.provider-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.provider-name {
  font-size: var(--text-heading);
  font-weight: 600;
  color: var(--vscode-text-light);
}

/* Badge over timestamp, both right-aligned under the card's top edge. */
.provider-status {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex: none;
}

.provider-checked {
  font-size: var(--text-caption);
  color: var(--vscode-text-muted);
}

.provider-steps-heading {
  margin: 14px 0 6px;
  font-size: var(--text-body-sm);
  font-weight: 600;
  color: var(--vscode-text-light);
}

.provider-steps {
  margin: 0;
  padding-left: 18px;
  font-size: var(--text-body-sm);
  line-height: 1.7;
  color: var(--vscode-text-muted);
}

.provider-register {
  margin-top: 14px;
}

.provider-meta {
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.provider-card > .provider-meta {
  margin: 12px 0 0;
}

.provider-field {
  margin-top: 12px;
}

.provider-field-label {
  display: block;
  margin-bottom: 4px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text-muted);
}

.provider-input {
  width: 100%;
  font-family: var(--font-mono, monospace);
}

/* ------------------------------------------------------------------- quota */

.provider-quota {
  margin-top: 12px;
}

.quota-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
  font-size: var(--text-body-sm);
  color: var(--vscode-text);
}

.quota-track {
  height: 4px;
  border-radius: 2px;
  background: var(--vscode-overlay-control);
  overflow: hidden;
}

.quota-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--vscode-accent);
  transition: width 120ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .quota-fill {
    transition: none;
  }
}

.provider-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.provider-failure {
  margin: 10px 0 0;
  font-size: var(--text-body-sm);
  color: var(--vscode-error);
}
</style>
