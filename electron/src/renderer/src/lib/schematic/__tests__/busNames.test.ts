import { describe, expect, test } from 'vitest'
import { matchBusMember, parseBusName } from '../busNames'

const names = (text: string, aliases = new Map<string, string[]>()): string[] | undefined =>
  parseBusName(text, aliases)?.members.map((member) => member.name)

describe('parseBusName', () => {
  test('a vector names its members by index, either way round', () => {
    expect(names('D[0..3]')).toEqual(['D0', 'D1', 'D2', 'D3'])
    expect(names('D[3..0]')).toEqual(['D0', 'D1', 'D2', 'D3'])
    expect(names('LANE[0..1]+')).toEqual(['LANE0+', 'LANE1+'])
  })

  test('a range of one, a bad range and a plain name are not buses', () => {
    expect(parseBusName('D[1..1]')).toBeNull()
    expect(parseBusName('D[a..3]')).toBeNull()
    expect(parseBusName('CLK')).toBeNull()
  })

  test('braces after _, ^ or ~ are markup, not a group', () => {
    expect(parseBusName('+V_{ADJ}')).toBeNull()
    expect(parseBusName('~{RESET}')).toBeNull()
    expect(names('I2C_{SYS}{SDA SCL}')).toEqual(['I2C_{SYS}.SDA', 'I2C_{SYS}.SCL'])
  })

  test('a group prefixes its members with its name, or not when it has none', () => {
    expect(names('USB{DP DM}')).toEqual(['USB.DP', 'USB.DM'])
    expect(names('{DP, DM}')).toEqual(['DP', 'DM'])
    expect(names('MEM{A[0..1] WE}')).toEqual(['MEM.A0', 'MEM.A1', 'MEM.WE'])
  })

  test('a group member that names an alias stands for its members', () => {
    const aliases = new Map([['I2C', ['SDA', 'SCL']]])
    expect(names('{I2C}', aliases)).toEqual(['SDA', 'SCL'])
    expect(names('SYS{I2C}', aliases)).toEqual(['SYS.SDA', 'SYS.SCL'])
  })

  test("an alias's own members are names, even one another alias has", () => {
    const aliases = new Map([
      ['RESOLVER', ['EXC', 'PWM']],
      ['PWM', ['PWM_H', 'PWM_L']]
    ])
    expect(names('RES{RESOLVER}', aliases)).toEqual(['RES.EXC', 'RES.PWM'])
  })
})

describe('matchBusMember', () => {
  test('a vector matches by position, whatever the two sides call it', () => {
    const parent = parseBusName('DATA[0..3]')!
    const child = parseBusName('D[4..7]')!
    expect(matchBusMember(parent, child.members[2])).toBe(2)
  })

  test('a group matches by the member name, without its prefix', () => {
    const parent = parseBusName('SFP0{TX RX}')!
    const child = parseBusName('SFP{RX TX}')!
    expect(matchBusMember(parent, child.members[0])).toBe(1)
  })
})
