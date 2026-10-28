import { describe, expect, test } from 'claude-code/testing'

const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 } as any

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('Polish replaces the draft with the extracted rewrite', async ($, on) => {
      let filled: string | undefined
      let asked = ''
      on('prompt.read', () => ({ value: { text: 'fix login bug', cursor: 13 } }))
      on('model.complete', (_$, e) => {
        asked = e.prompt
        return { value: { isAnswered: true, text: 'Sure!\n<polished>Fix the login bug.\n\nDone when: login works.</polished>', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
      })
      on('prompt.fill', (_$, e) => {
        filled = e.text
        return { isFilled: true, text: e.text, cursor: e.text.length }
      })

      const ui = await $.ui.mount({ plugin: 'prompt-polish', surface, component: 'AbovePrompt', props })
      await ui.press({ key: 'polish' })

      expect(asked).toContain('<draft>\nfix login bug\n</draft>')
      expect(filled).toBe('Fix the login bug.\n\nDone when: login works.')
    })

    test('empty draft is left alone', async ($, on) => {
      let filled = false
      on('prompt.read', () => ({ value: { text: '  ', cursor: 0 } }))
      on('prompt.fill', (_$, e) => { filled = true; return { isFilled: true, text: e.text, cursor: 0 } })

      const ui = await $.ui.mount({ plugin: 'prompt-polish', surface, component: 'AbovePrompt', props })
      await ui.press({ key: 'polish' })

      expect(filled).toBe(false)
    })
  })
}
