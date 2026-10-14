/**
 * Shared by the netlist suites: a design read off disk the way a sheet
 * session assembles it, and a netlist read back into comparable data.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { SyncDesign } from '../../board/boardSync'
import type { SheetSource } from '../../componentsTable'
import { parseKicadSchematic, type KicadSchematic } from '../../kicad/schematic'
import {
  findChild,
  findChildren,
  getAtomValues,
  parseSExpr,
  type SExprList
} from '../../kicad/sexpr'
import { buildConnectivity, type SheetConnectivityInput } from '../connectivity'
import { resolveHierarchy } from '../hierarchy'

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Every sheet of the hierarchy `root` heads, with its connectivity. */
export const loadDesign = async (root: string): Promise<SyncDesign> => {
  const tree = await resolveHierarchy(
    {
      readFile: async (path) => readOrNull(path),
      listSchematics: async (dir) =>
        readdirSync(dir)
          .filter((name) => name.endsWith('.kicad_sch'))
          .map((name) => join(dir, name))
    },
    root
  )
  const parsed = new Map<string, KicadSchematic>()
  const parse = (path: string): KicadSchematic => {
    let schematic = parsed.get(path)
    if (!schematic) {
      schematic = parseKicadSchematic(readFileSync(path, 'utf8'))
      parsed.set(path, schematic)
    }
    return schematic
  }
  // A sheet whose file is missing holds nothing, as KiCad loads it.
  const instances = tree.instances.filter((instance) => existsSync(instance.filePath))
  const single = instances.length <= 1
  const sheets: SheetSource[] = instances.map((instance) => ({
    schematic: parse(instance.filePath),
    sheetPath: instance.sheetPath,
    sheetName: single ? '' : instance.namePath,
    filePath: instance.filePath
  }))
  const inputs: SheetConnectivityInput[] = instances.map((instance) => ({
    sheetPath: instance.sheetPath,
    namePath: instance.namePath,
    schematic: parse(instance.filePath)
  }))
  return { sheets, inputs, connectivity: buildConnectivity(inputs) }
}

const text = (node: SExprList, token: string): string | undefined => {
  const child = findChild(node, token)
  return child ? (getAtomValues(child)[0] ?? '') : undefined
}

export interface ReadNetlist {
  sheets: Array<{ name?: string; tstamps?: string }>
  components: Array<{ ref?: string; value?: string; footprint?: string; sheet?: string }>
  nets: Array<{
    name?: string
    netClass?: string
    nodes: Array<Record<string, string | undefined>>
  }>
}

/** The parts of a netlist the parity and unit suites compare. */
export const readNetlist = (source: string): ReadNetlist => {
  const root = parseSExpr(source) as SExprList
  const design = findChild(root, 'design')
  const components = findChild(root, 'components')
  const nets = findChild(root, 'nets')
  return {
    sheets: (design ? findChildren(design, 'sheet') : []).map((sheet) => ({
      name: text(sheet, 'name'),
      tstamps: text(sheet, 'tstamps')
    })),
    components: (components ? findChildren(components, 'comp') : []).map((comp) => {
      const sheetpath = findChild(comp, 'sheetpath')
      return {
        ref: text(comp, 'ref'),
        value: text(comp, 'value'),
        footprint: text(comp, 'footprint'),
        sheet: sheetpath ? text(sheetpath, 'tstamps') : undefined
      }
    }),
    nets: (nets ? findChildren(nets, 'net') : []).map((net) => ({
      name: text(net, 'name'),
      netClass: text(net, 'class'),
      nodes: findChildren(net, 'node').map((node) => ({
        ref: text(node, 'ref'),
        pin: text(node, 'pin'),
        pinfunction: text(node, 'pinfunction'),
        pintype: text(node, 'pintype')
      }))
    }))
  }
}
