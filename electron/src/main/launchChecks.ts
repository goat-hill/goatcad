// Registry for rerunnable machine checks and their Settings status.

export interface SystemCheckResult {
  id: string
  /** One line for Settings — already resolved to concrete paths and counts. */
  detail: string | null
  /** Rows this run added; 0 on a re-run that found nothing new. */
  added?: number
  /** Set when the check itself failed, rather than finding nothing. */
  error?: string
}

export interface SystemCheck {
  id: string
  run: () => Promise<Omit<SystemCheckResult, 'id'>> | Omit<SystemCheckResult, 'id'>
}

const checks: SystemCheck[] = []

export function registerSystemChecks(...toAdd: SystemCheck[]): void {
  checks.push(...toAdd)
}

/** Run checks in dependency order; failures do not abort the remaining checks. */
export async function runSystemChecks(only?: readonly string[]): Promise<SystemCheckResult[]> {
  const results: SystemCheckResult[] = []
  for (const check of checks) {
    if (only && !only.includes(check.id)) continue
    try {
      results.push({ id: check.id, ...(await check.run()) })
    } catch (err) {
      results.push({
        id: check.id,
        detail: null,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}
