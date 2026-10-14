/**
 * What the schematic check worker does with a job (`protocol.ts`): parse the
 * files it was sent, build the design's graph from the instances named, and
 * run the checks that read the sheets alone. The same class runs on the page
 * where there is no Worker (a test under node).
 */
import { parseKicadSchematic, type KicadSchematic } from '../../kicad/schematic'
import { sheetChecks } from '../checks'
import { buildConnectivity, type SheetConnectivityInput } from '../connectivity'
import type { FromWorker, ToWorker } from './protocol'

export class CheckWorkerEngine {
  /** Each file's parsed sheet; null where its text does not parse. */
  private readonly sheets = new Map<string, KicadSchematic | null>()

  handle(message: ToWorker): FromWorker {
    const started = performance.now()
    for (const file of message.drop) this.sheets.delete(file)
    for (const [file, text] of message.texts) {
      let sheet: KicadSchematic | null
      try {
        sheet = parseKicadSchematic(text)
      } catch {
        sheet = null
      }
      this.sheets.set(file, sheet)
    }
    try {
      const inputs: SheetConnectivityInput[] = []
      for (const { file, ...instance } of message.instances) {
        const schematic = this.sheets.get(file)
        if (schematic) inputs.push({ ...instance, schematic })
      }
      const results = inputs.length
        ? sheetChecks(
            buildConnectivity(inputs, message.naming),
            inputs,
            message.grid,
            message.pinMap,
            {
              ...(message.netclasses ? { netclasses: message.netclasses } : {}),
              ...(message.textVariables ? { textVariables: message.textVariables } : {})
            }
          )
        : []
      return { type: 'checked', job: message.job, results, ms: performance.now() - started }
    } catch (error) {
      return {
        type: 'failed',
        job: message.job,
        message: error instanceof Error ? (error.stack ?? error.message) : String(error)
      }
    }
  }
}
