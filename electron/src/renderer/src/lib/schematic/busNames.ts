/**
 * Bus names as KiCad reads them. A label, a sheet pin or a hierarchical label
 * whose text is a bus name drives a bus rather than a net:
 *
 * - a vector `D[0..7]` (optionally `D[0..7]+`, `D_{[0..7]}`), members `D0` … `D7`;
 * - a group `NAME{A B C}` (space or comma separated), members `NAME.A` …, or
 *   `A` … when the group has no name. A member may itself be a vector, or the
 *   name of a bus alias, which stands for the alias's members.
 *
 * Braces right after `_`, `^` or `~` are text markup (subscript, superscript,
 * overbar), not a group: `I2C_{SYS}{SDA SCL}` is the group `I2C_{SYS}`.
 * Parsing runs on the unescaped text; member names come back escaped as a net
 * name is, so they compare with label text as written in the file.
 */
import { unescapeKicadText } from '../kicad/textMarkup'

/** One net a bus carries. */
export interface BusMember {
  /** The member's net name on the bus's sheet: `NAME.A`, `D3`. */
  name: string
  /** The name without the group's prefix: what a group member is matched by. */
  local: string
  /** Its position in the vector it belongs to, or -1 for a plain group member. */
  vectorIndex: number
}

export interface BusName {
  kind: 'vector' | 'group'
  /** Every net the bus carries, groups and vectors flattened, in order. */
  members: BusMember[]
}

/** Bus aliases by name: the member names each stands for. */
export type BusAliases = ReadonlyMap<string, readonly string[]>

const MARKUP = new Set(['_', '^', '~'])

const escapeName = (text: string): string => text.replace(/\//g, '{slash}')

/** `prefix[a..b]suffix`: the member names, or null when `text` is not a vector. */
const parseVector = (text: string): string[] | null => {
  let prefix = ''
  let depth = 0
  let i = 0
  let fmtWrapsName = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (i === 0 || !MARKUP.has(text[i - 1])) return null
      depth++
      prefix += ch
      continue
    }
    if (ch === '}') {
      depth--
      prefix += ch
      continue
    }
    if (ch === ' ' || ch === ']') return null
    if (ch === '[') {
      if (depth > 0) {
        const open = prefix.lastIndexOf('{')
        if (open > 0 && MARKUP.has(prefix[open - 1])) {
          // `D_{[1..2]}` decorates the range; `~{BE[0..3]}` decorates the name.
          if (open === prefix.length - 1) prefix = prefix.slice(0, open - 1)
          else fmtWrapsName = true
        }
      }
      break
    }
    prefix += ch
  }
  if (i >= text.length) return null
  const range = /^\[(\d+)\.\.(\d+)\]/.exec(text.slice(i))
  if (!range) return null
  i += range[0].length
  let suffix = ''
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '}') {
      depth--
      if (fmtWrapsName) suffix += ch
    } else if ('+-PN'.includes(ch)) suffix += ch
    else return null
  }
  if (depth !== 0) return null
  let begin = Number(range[1])
  let end = Number(range[2])
  if (begin === end) return null
  if (begin > end) [begin, end] = [end, begin]
  const members: string[] = []
  for (let index = begin; index <= end; index++) members.push(`${prefix}${index}${suffix}`)
  return members
}

/** `name{a b}`: the group's name and member texts, or null when `text` is not a group. */
const parseGroup = (text: string): { name: string; members: string[] } | null => {
  let name = ''
  let depth = 0
  let i = 0
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (i > 0 && MARKUP.has(text[i - 1])) {
        depth++
        name += ch
        continue
      }
      break
    }
    if (ch === '}') {
      depth--
      name += ch
      continue
    }
    if (ch === ' ' || ch === '[' || ch === ']') return null
    name += ch
  }
  if (depth !== 0 || i >= text.length) return null
  const members: string[] = []
  let current = ''
  for (i = i + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (i > 0 && MARKUP.has(text[i - 1])) {
        depth++
        current += ch
        continue
      }
      return null
    }
    if (ch === '}') {
      if (depth) {
        depth--
        current += ch
        continue
      }
      if (current) members.push(current)
      return { name, members }
    }
    if (ch === ' ' || ch === ',') {
      if (current) members.push(current)
      current = ''
      continue
    }
    current += ch
  }
  return null
}

/**
 * The bus a label's text names, or null when it names a net. `aliases` are the
 * design's bus aliases, which a group member may stand for.
 */
export const parseBusName = (text: string, aliases: BusAliases = new Map()): BusName | null => {
  const plain = unescapeKicadText(text)
  const vector = parseVector(plain)
  if (vector) {
    return {
      kind: 'vector',
      members: vector.map((member, index) => ({
        name: escapeName(member),
        local: escapeName(member),
        vectorIndex: index
      }))
    }
  }
  const group = parseGroup(plain)
  if (!group) return null
  const prefix = group.name ? `${group.name}.` : ''
  const members: BusMember[] = []
  // An alias stands for its members one level deep: a member it lists is that
  // name, even where another alias has it — as KiCad reads it.
  const add = (member: string, viaAlias: boolean): void => {
    const alias = viaAlias ? undefined : aliases.get(member)
    if (alias) {
      for (const aliasMember of alias) add(aliasMember, true)
      return
    }
    const nested = parseVector(member)
    if (nested) {
      nested.forEach((name, index) =>
        members.push({
          name: escapeName(prefix + name),
          local: escapeName(name),
          vectorIndex: index
        })
      )
      return
    }
    members.push({ name: escapeName(prefix + member), local: escapeName(member), vectorIndex: -1 })
  }
  for (const member of group.members) add(member, false)
  return { kind: 'group', members }
}

/**
 * The member of `bus` that `member` of a bus joined to it across a sheet
 * boundary lands on, as an index into `bus.members`, or -1. A vector matches
 * by position, since the two sides may name it differently; a group by the
 * member's own name, then by position for a vector member.
 */
export const matchBusMember = (bus: BusName, member: BusMember): number => {
  if (bus.kind === 'vector') {
    return bus.members.findIndex((candidate) => candidate.vectorIndex === member.vectorIndex)
  }
  const byName = bus.members.findIndex((candidate) => candidate.local === member.local)
  if (byName >= 0) return byName
  return member.vectorIndex >= 0 && member.vectorIndex < bus.members.length
    ? member.vectorIndex
    : -1
}
