import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { SYSTEM, ask, extract } from './polish-prompt'

const isBusy = atom({ plugin: 'prompt-polish', key: 'isBusy' } as const, false)
const frame = atom({ plugin: 'prompt-polish', key: 'frame' } as const, 0)
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

async function polish($: EngineInterface) {
  if (await read($, isBusy)) return
  const { text: draft } = await $.prompt.read()
  if (!draft.trim()) {
    $.ui.toast('Nothing to polish: type a prompt first')
    return
  }

  await update($, isBusy, () => true)
  const tick = $.clock.every(80, () => update($, frame, n => (n + 1) % FRAMES.length))
  try {
    const r = await $.model.complete({
      model: 'sonnet',
      system: SYSTEM,
      prompt: ask(draft),
      maxTokens: 4096,
      effort: 'medium',
      timeoutMs: 90_000,
    })
    if (!r.isAnswered) {
      $.ui.toast(`Polish failed: ${r.reason}`)
      return
    }
    // Don't clobber edits the person made while we waited.
    if ((await $.prompt.read()).text !== draft) {
      $.ui.toast('Draft changed while polishing; left it alone')
      return
    }
    const polished = extract(r.text)
    if (polished) await $.prompt.fill({ text: polished, mode: 'replace' })
  } finally {
    tick.cancel()
    await update($, isBusy, () => false)
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const f = await read($, frame)

    return (
      <Box>
        {busy ? (
          <Text dimColor>{FRAMES[f]} Polishing prompt…</Text>
        ) : (
          <Button key="polish" label="✨ Polish prompt" dimColor onPress={() => polish($)} />
        )}
      </Box>
    )
  })
}
