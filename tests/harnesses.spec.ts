/**
 * The marker that names the harness of a ticket.
 *
 * A request may name the CLI that runs it, so one repository can send a hard refactor to one CLI and a quick fix to
 * another. The marker has to be readable from the request text alone, and it must not survive into the title or the
 * prompt the worker reads.
 */
import { describe, expect, it } from 'vitest'
import { namedHarness, withoutHarness } from '../src/core/harnesses.ts'

describe('named harness', () => {
  it('reads a leading bracket', () => {
    expect(namedHarness('[codex] fix the flaky test')).toBe('codex')
    expect(namedHarness('  [antigravity] fix it')).toBe('antigravity')
    expect(namedHarness('[antigravity-xhigh] fix it')).toBe('antigravity-xhigh')
  })

  it('reads harness=name anywhere in the text', () => {
    expect(namedHarness('fix the flaky test harness=dsh please')).toBe('dsh')
    expect(namedHarness('harness = CLAUDE fix it')).toBe('claude')
  })

  it('names nothing when the request names nothing', () => {
    expect(namedHarness('fix the flaky test')).toBeUndefined()
    expect(namedHarness('use [brackets] in prose')).toBeUndefined()
    expect(namedHarness('')).toBeUndefined()
  })

  it('does not read a bracket in the middle of a sentence', () => {
    expect(namedHarness('fix it [codex] later')).toBeUndefined()
  })
})

describe('request without the marker', () => {
  it('drops a leading bracket', () => {
    expect(withoutHarness('[codex] fix the flaky test')).toBe('fix the flaky test')
  })

  it('drops harness=name and closes the gap', () => {
    expect(withoutHarness('fix it harness=codex please')).toBe('fix it please')
  })

  it('leaves a request that names nothing untouched', () => {
    expect(withoutHarness('fix the flaky test')).toBe('fix the flaky test')
  })
})
