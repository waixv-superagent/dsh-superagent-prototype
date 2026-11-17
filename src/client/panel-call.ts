/** The panel's localized API caller, shared by the panel provider and surfaces that render outside it (the active-Tickets dock). */
import { useMemo, useRef } from 'react'
import { caller, type ApiMessages, type Call } from './api.ts'
import { setupText, valueLabel, type T } from './text.ts'

/** Localized failure messages for management API calls. */
export const apiMessages = (t: T): ApiMessages => ({
  offline: t('offline'), notRunning: t('hostNotRunning'), serverError: status => t('serverError', { status }),
    requestFailed: status => t('requestFailed', { status }),
  setup: problem => problem.values.output ? `${setupText(t, problem)}\n${problem.values.output}` : setupText(t, problem),
  // A refusal names a prompt part by its label.
  user: ({ code, values }) => t(`userError.${code}`, values.part ? { ...values, part: valueLabel(t, 'promptPart', values.part) } : values),
})

/** A stable caller that reads the current translator via ref, so locale changes do not recreate it and restart polling. */
export function useApiCall(t: T): Call {
  const copy = useRef(t)
  copy.current = t
  return useMemo(() => caller(() => apiMessages(copy.current)), [])
}
