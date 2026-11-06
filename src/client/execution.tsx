/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { TICKET_KINDS, type TicketKind } from '../core/kind.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill, SegmentedControl } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, kind, state, reload }: {
  filter: TicketFilter; kind?: TicketKind; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit, ...kind ? { kind } : {} } }),
    [current, kind, limit])
  const { paused } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={state.load.running} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: { ...value === 'open' ? {} : { filter: value }, ...kind ? { kind } : {} } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    {/* The kind of work cuts across the stage filters above: it narrows the same list and counts that stage's tickets per kind. */}
    <div className="dt-filters dt-kind-filters" role="group" aria-label={t('ticketKindLabel')}>
      {[undefined, ...TICKET_KINDS].map(value => <Pill key={value ?? 'all'} active={kind === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: { ...current === 'open' ? {} : { filter: current }, ...value ? { kind: value } : {} } },
          true) }}>{value ? t(`ticketKind.${value}`) : t('ticketKindAll')}
        {data && <span className="dt-count">{value ? data.kinds[value] ?? 0 : Object.values(data.kinds).reduce((sum, count) => sum + (count ?? 0), 0)}</span>}</Pill>)}
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
/** "name=value" lines for a list of pairs. */
export const pairLines = (pairs: readonly (readonly [string, string])[]): string => pairs.map(([label, value]) => `${label}=${value}`).join('\n')
/** The pairs of "name=value" lines; a line without `=` uses its text for both, and blank lines are skipped. */
export const parsePairs = (text: string): [string, string][] => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
  const at = line.lastIndexOf('=')
  return at < 0 ? [line, line] : [line.slice(0, at).trim() || line.slice(at + 1).trim(), line.slice(at + 1).trim()]
})
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  // The reviewer and package-recipient lists are edited as "name=value" lines and parsed back only on save.
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' '),
    editor: { ...executor.editor, targets: executor.editor.targets.join('\n') },
    p4: { ...executor.p4, reviewers: pairLines(executor.p4.reviewers.map(item => [item.label, item.user])),
      autobuildTargets: pairLines(executor.p4.autobuildTargets.map(item => [item.label, item.id])) } }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean),
      editor: { ...value.editor, targets: value.editor.targets.split(/\r?\n/).map(line => line.trim()).filter(Boolean) },
      p4: { ...value.p4, reviewers: parsePairs(value.p4.reviewers).map(([label, user]) => ({ label, user })),
        autobuildTargets: parsePairs(value.p4.autobuildTargets).map(([label, id]) => ({ label, id })) } }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <Field label={t('deliveryBackend')} hint={t('deliveryBackendHint')}>
            <SegmentedControl label={t('deliveryBackend')} value={value.backend} onChange={backend => edit({ backend })}
              options={[{ value: 'git', label: t('deliveryBackendGit') }, { value: 'p4', label: t('deliveryBackendP4') }]} />
          </Field>
          {value.backend === 'p4' && <>
            <Field label={t('p4Port')} hint={t('p4PortHint')}>
              <Input className="dt-mono" value={value.p4.port} placeholder={t('p4EmptyKeepsInstallation')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, port: event.target.value } })} />
            </Field>
            <Field label={t('p4User')} hint={t('p4UserHint')}>
              <Input className="dt-mono" value={value.p4.user} placeholder={t('p4EmptyKeepsInstallation')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, user: event.target.value } })} />
            </Field>
            <Field label={t('p4ClientTemplate')} hint={t('p4ClientTemplateHint')}>
              <Input className="dt-mono" value={value.p4.clientTemplate} placeholder="dsh-<name>" spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, clientTemplate: event.target.value } })} />
            </Field>
            <Field label={t('p4Depot')} hint={t('p4DepotHint')}>
              <Input className="dt-mono" value={value.p4.depot} placeholder="//depot/mainline" spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, depot: event.target.value } })} />
            </Field>
            <Field label={t('p4SyncSpec')} hint={t('p4SyncSpecHint')}>
              <Input className="dt-mono" value={value.p4.syncSpec} placeholder="@head" spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, syncSpec: event.target.value } })} />
            </Field>
            <Field label={t('swarmUrl')} hint={t('swarmUrlHint')}>
              <Input className="dt-mono" value={value.p4.swarmUrl} placeholder={t('swarmUrlEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, swarmUrl: event.target.value } })} />
            </Field>
            <Field label={t('jenkinsUrl')} hint={t('jenkinsUrlHint')}>
              <Input className="dt-mono" value={value.p4.jenkinsUrl} placeholder={t('jenkinsUrlEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, jenkinsUrl: event.target.value } })} />
            </Field>
            <Field label={t('jenkinsUser')} hint={t('jenkinsUserHint')}>
              <Input className="dt-mono" value={value.p4.jenkinsUser} placeholder={t('jenkinsUserEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, jenkinsUser: event.target.value } })} />
            </Field>
            <Field label={t('jenkinsToken')} hint={t('jenkinsTokenHint')}>
              <Input className="dt-mono" type="password" autoComplete="off" value={value.p4.jenkinsToken}
                placeholder={t('jenkinsTokenEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, jenkinsToken: event.target.value } })} />
            </Field>
            <Field label={t('postApprovalJob')} hint={t('postApprovalJobHint')}>
              <Input className="dt-mono" value={value.p4.postApprovalJob} placeholder={t('postApprovalJobEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, postApprovalJob: event.target.value } })} />
            </Field>
            <Field label={t('p4Reviewers')} hint={t('p4ReviewersHint')}>
              <textarea className="dt-textarea dt-mono" rows={3} spellCheck={false} placeholder="张三=zhangsan" value={value.p4.reviewers}
                onChange={event => edit({ p4: { ...value.p4, reviewers: event.target.value } })} />
            </Field>
            <Field label={t('autobuildJob')} hint={t('autobuildJobHint')}>
              <Input className="dt-mono" value={value.p4.autobuildJob} placeholder={t('autobuildJobEmpty')} spellCheck={false}
                onChange={event => edit({ p4: { ...value.p4, autobuildJob: event.target.value } })} />
            </Field>
            {value.p4.autobuildJob.trim() && <>
              <Field label={t('autobuildArtifact')} hint={t('autobuildArtifactHint')}>
                <Input className="dt-mono" value={value.p4.autobuildArtifact} placeholder="<url>" spellCheck={false}
                  onChange={event => edit({ p4: { ...value.p4, autobuildArtifact: event.target.value } })} />
              </Field>
              <Field label={t('autobuildTargets')} hint={t('autobuildTargetsHint')}>
                <textarea className="dt-textarea dt-mono" rows={3} spellCheck={false} placeholder="编辑器群=oc_xxx" value={value.p4.autobuildTargets}
                  onChange={event => edit({ p4: { ...value.p4, autobuildTargets: event.target.value } })} />
              </Field>
            </>}
          </>}
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('editorProject')} hint={t('editorProjectHint')}>
            <Input className="dt-mono" value={value.editor.project} placeholder={t('editorCommandEmpty')} spellCheck={false}
              onChange={event => edit({ editor: { ...value.editor, project: event.target.value } })} />
          </Field>
          {(['build', 'restart', 'test'] as const).map(kind => <Field key={kind} label={t(`editorCommand.${kind}`)} hint={t('editorCommandHint')}>
            <Input className="dt-mono" value={value.editor[kind]} placeholder={t('editorCommandEmpty')} spellCheck={false}
              onChange={event => edit({ editor: { ...value.editor, [kind]: event.target.value } })} />
          </Field>)}
          <Field label={t('editorTargets')} hint={t('editorTargetsHint')}>
            <textarea className="dt-textarea dt-mono" rows={4} spellCheck={false} value={value.editor.targets}
              placeholder={`Development Editor=<project 目录>\\Build.bat -Target=... && <project>`}
              onChange={event => edit({ editor: { ...value.editor, targets: event.target.value } })} />
          </Field>
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}

