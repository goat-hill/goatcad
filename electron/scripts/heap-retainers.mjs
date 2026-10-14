/**
 * What keeps objects alive in a heap snapshot: finds every object carrying all
 * of a set of property names (a board by default) and prints the shortest
 * strong chain from a GC root to each. WeakMap entries are not followed — an
 * entry is held by its key, and the chain that matters is the one to the key.
 *
 *   node --max-old-space-size=12000 scripts/heap-retainers.mjs closed.heapsnapshot \
 *     [footprints,segments,nets,vias]
 *
 * `--largest=N` in place of the names follows the N largest objects instead:
 * a held board text or buffer rather than a board.
 *
 * A production build's names are minified; the property names along a chain
 * (`onMouseMoveCallback`, `stopWatch`) are what to search the source for.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
import { readFileSync } from 'node:fs'

const [file, match = 'footprints,segments,nets,vias'] = process.argv.slice(2)
if (!file) throw new Error('usage: heap-retainers.mjs <file.heapsnapshot> [prop,prop,…]')
const want = match.split(',')

/** Section by section, since a big board's snapshot passes V8's string length limit. */
function load(buf) {
  const at = (key, from = 0) => {
    const i = buf.indexOf(`"${key}":[`, from)
    if (i < 0) throw new Error(`heap-retainers: no ${key} section`)
    return i + key.length + 4
  }
  const numbers = (start) => {
    const end = buf.indexOf(0x5d, start)
    let n = 0
    for (let i = start; i < end; i++) if (buf[i] === 0x2c) n++
    const out = new Uint32Array(end > start ? n + 1 : 0)
    let k = 0
    let v = 0
    let digits = false
    for (let i = start; i <= end; i++) {
      const c = buf[i]
      if (c >= 0x30 && c <= 0x39) {
        v = v * 10 + c - 0x30
        digits = true
      } else if (digits) {
        out[k++] = v
        v = 0
        digits = false
      }
    }
    return { values: out.subarray(0, k), end }
  }
  const nodesAt = at('nodes')
  const header = buf.toString('utf8', 0, buf.lastIndexOf(0x2c, nodesAt)) + '}'
  const nodes = numbers(nodesAt)
  const edges = numbers(at('edges', nodes.end))
  const strings = []
  let i = at('strings', edges.end)
  for (;;) {
    while (buf[i] !== 0x22 && buf[i] !== 0x5d) i++
    if (buf[i] === 0x5d) break
    let j = i + 1
    while (buf[j] !== 0x22) j += buf[j] === 0x5c ? 2 : 1
    strings.push(JSON.parse(buf.toString('utf8', i, j + 1)))
    i = j + 1
  }
  return { ...JSON.parse(header), nodes: nodes.values, edges: edges.values, strings }
}
const { snapshot, nodes, edges, strings } = load(readFileSync(file))
const meta = snapshot.meta
const NF = meta.node_fields.length
const EF = meta.edge_fields.length
const nType = meta.node_fields.indexOf('type')
const nName = meta.node_fields.indexOf('name')
const nEdges = meta.node_fields.indexOf('edge_count')
const nSize = meta.node_fields.indexOf('self_size')
const eType = meta.edge_fields.indexOf('type')
const eName = meta.edge_fields.indexOf('name_or_index')
const eTo = meta.edge_fields.indexOf('to_node')
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const count = nodes.length / NF

const firstEdge = new Uint32Array(count + 1)
for (let i = 0, e = 0; i < count; i++) {
  firstEdge[i] = e
  e += nodes[i * NF + nEdges] * EF
}
firstEdge[count] = edges.length

const edgeName = (e) => {
  const type = edgeTypes[edges[e + eType]]
  const value = edges[e + eName]
  return type === 'element' || type === 'hidden' ? `[${value}]` : strings[value]
}
const nodeName = (i) =>
  `${nodeTypes[nodes[i * NF + nType]]}:${strings[nodes[i * NF + nName]]}`.slice(0, 80)

const largest = /^--largest=(\d+)$/.exec(match)
const found = []
if (largest) {
  const bySize = Array.from({ length: count }, (_, i) => i)
  bySize.sort((a, b) => nodes[b * NF + nSize] - nodes[a * NF + nSize])
  found.push(...bySize.slice(0, Number(largest[1])))
} else {
  for (let i = 0; i < count; i++) {
    if (nodeTypes[nodes[i * NF + nType]] !== 'object') continue
    const props = new Set()
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
      if (edgeTypes[edges[e + eType]] === 'property') props.add(strings[edges[e + eName]])
    }
    if (want.every((p) => props.has(p))) found.push(i)
  }
  console.log(`${found.length} alive with ${want.join(', ')}`)
}

// Breadth first from the root, so each chain found is a shortest one.
const parent = new Int32Array(count).fill(-1)
const via = new Int32Array(count).fill(-1)
const queue = new Int32Array(count)
let head = 0
let tail = 0
queue[tail++] = 0
parent[0] = 0
while (head < tail) {
  const i = queue[head++]
  for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
    const type = edgeTypes[edges[e + eType]]
    if (type === 'weak' || type === 'shortcut') continue
    if (type === 'internal' && /pair in WeakMap/.test(edgeName(e))) continue
    const to = edges[e + eTo] / NF
    if (parent[to] !== -1) continue
    parent[to] = i
    via[to] = e
    queue[tail++] = to
  }
}

for (const target of found) {
  console.log(`\n${nodeName(target)} ${(nodes[target * NF + nSize] / 1048576).toFixed(1)}MB`)
  if (parent[target] === -1) {
    console.log('  held only weakly')
    continue
  }
  const chain = []
  for (let i = target; i !== 0; i = parent[i])
    chain.push(`  ${nodeName(parent[i])} --${edgeName(via[i])}-->`)
  console.log(chain.reverse().join('\n'))
}
