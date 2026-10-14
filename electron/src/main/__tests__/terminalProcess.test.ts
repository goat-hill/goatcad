import { describe, expect, test } from 'vitest'
import {
  cleanCommandLine,
  foregroundInTree,
  isShellName,
  parseProcStat,
  parsePsTable
} from '../terminalProcess'

describe('cleanCommandLine', () => {
  test('keeps a bare command as its basename', () => {
    expect(cleanCommandLine('/usr/local/bin/claude')).toBe('claude')
    expect(cleanCommandLine('claude --continue')).toBe('claude')
  })

  test('keeps the subcommand of a package runner', () => {
    expect(cleanCommandLine('/usr/bin/npm run dev')).toBe('npm run dev')
    expect(cleanCommandLine('pnpm run build --watch')).toBe('pnpm run build')
  })

  test('names the script an interpreter is running, not its flags', () => {
    expect(cleanCommandLine('node -r esm /home/u/p/build.js')).toBe('node build.js')
    expect(cleanCommandLine('python3 -u scripts/flash.py')).toBe('python3 flash.py')
  })

  test('falls back to the interpreter when no argument looks like a script', () => {
    expect(cleanCommandLine('python3 -i')).toBe('python3')
    // `esm` is -r's value, not the program; naming the tab after it would be wrong.
    expect(cleanCommandLine('node -r esm')).toBe('node')
  })

  test('names what sudo is wrapping, not sudo', () => {
    expect(cleanCommandLine('sudo -E npm run build')).toBe('npm run build')
    expect(cleanCommandLine('sudo dmesg -w')).toBe('dmesg')
  })

  test('survives empty and whitespace input', () => {
    expect(cleanCommandLine('')).toBe('')
    expect(cleanCommandLine('   ')).toBe('')
  })
})

describe('parseProcStat', () => {
  // Field order is the kernel's: pid (name) state ppid pgrp session tty tpgid …
  const line = '4242 (fish) S 4200 4242 4242 34816 4310 4194304 …'

  test('reads ppid, pgrp and tpgid from the fields after the name', () => {
    expect(parseProcStat(line)).toEqual({ name: 'fish', ppid: 4200, pgrp: 4242, tpgid: 4310 })
  })

  test('counts from the last paren, so a name with spaces and parens still parses', () => {
    const odd = '77 (my (weird) proc) S 1 77 77 34816 99 4194304'
    expect(parseProcStat(odd)?.name).toBe('my (weird) proc')
    expect(parseProcStat(odd)?.tpgid).toBe(99)
  })

  test('rejects malformed input rather than guessing', () => {
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('4242 fish S 1 2 3')).toBeNull()
    expect(parseProcStat('4242 (fish) S 1')).toBeNull()
  })
})

describe('parsePsTable', () => {
  const output = [
    '  501   500 Ss     -fish',
    '  610   501 S+     node /usr/local/bin/claude',
    'garbage line',
    '  611   610 R+     rg --json pattern'
  ].join('\n')

  test('splits three columns off and keeps the rest as the command', () => {
    expect(parsePsTable(output)).toEqual([
      { pid: 501, ppid: 500, stat: 'Ss', args: '-fish' },
      { pid: 610, ppid: 501, stat: 'S+', args: 'node /usr/local/bin/claude' },
      { pid: 611, ppid: 610, stat: 'R+', args: 'rg --json pattern' }
    ])
  })
})

describe('foregroundInTree', () => {
  const rows = parsePsTable(
    [
      '  501   500 Ss     -fish',
      '  610   501 S+     npm run dev',
      '  620   610 S+     node /w/node_modules/.bin/vite',
      '  700   501 S      node background.js'
    ].join('\n')
  )

  test('names the deepest foreground descendant', () => {
    expect(foregroundInTree(rows, 501)).toBe('node vite')
  })

  test('ignores background descendants', () => {
    const background = parsePsTable(
      ['  501   500 Ss     -fish', '  700   501 S      node bg.js'].join('\n')
    )
    expect(foregroundInTree(background, 501)).toBeNull()
  })

  test('an idle shell is running nothing', () => {
    expect(foregroundInTree(parsePsTable('  501   500 Ss     -fish'), 501)).toBeNull()
  })

  test('a foreground sub-shell is still just a shell', () => {
    const nested = parsePsTable(['  501   500 Ss     -fish', '  610   501 S+     bash'].join('\n'))
    expect(foregroundInTree(nested, 501)).toBeNull()
  })
})

describe('isShellName', () => {
  test('recognizes shells by basename', () => {
    expect(isShellName('/usr/local/bin/fish')).toBe(true)
    expect(isShellName('zsh')).toBe(true)
    expect(isShellName('claude')).toBe(false)
  })
})
