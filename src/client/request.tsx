/** The panel's request form: a person's request becomes a Web Source Trigger the main Session assesses and turns into a Ticket. */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import { Button, Icon, Modal } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText } from './text.ts'

/** Header action and modal that submit one request to the main Session; the Ticket appears on the board once it is accepted. */
export function RequestButton() {
  const { t, call, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) setOpen(false) }
  const submit = async () => {
    const request = text.trim()
    if (!request || busy) return
    setBusy(true)
    try {
      await call('POST requests', { body: { text: request } })
      setOpen(false)
      setText('')
      notify(t('requestQueued'))
    } catch (error) { notify(errorText(error)) } finally { setBusy(false) }
  }
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setOpen(true)}>{t('newTicket')}</Button>
    <Modal open={open} onClose={close} title={t('newTicketTitle')} closeLabel={t('close')} description={t('newTicketHint')}
      footer={<><Button variant="ghost" onClick={close} disabled={busy}>{t('cancel')}</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !text.trim()}>{t('newTicketSend')}</Button></>}>
      <Field label={t('newTicketRequest')} hint={t('newTicketHintDetail')}>
        <textarea className="dt-textarea" rows={6} maxLength={LIMITS.requestChars} value={text} autoFocus
          placeholder={t('newTicketPlaceholder')} aria-label={t('newTicketRequest')}
          onChange={event => setText(event.target.value)} />
      </Field>
    </Modal>
  </>
}
