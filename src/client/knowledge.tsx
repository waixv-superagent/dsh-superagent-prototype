/** Knowledge settings group: whether the team knowledge base's MCP tools reach Sessions and the MCP server they come from (docs/033). */
import { InfoTip, Input, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint } from './widgets.tsx'

export function KnowledgeSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const draft = useBlockDraft('knowledge', blocks.knowledge.value, blocks.knowledge.revision)
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('knowledgeTitle')}<InfoTip text={t('knowledgeIntro')} /></h2>
          <div className="dt-switch-row">
            <div className="dt-field-head">{t('knowledgeEnabled')}<InfoTip text={t('knowledgeEnabledHint')} /></div>
            <Switch checked={value.enabled} onChange={enabled => edit({ enabled })} label={t('knowledgeEnabled')} />
          </div>
          <Field label={t('knowledgeServer')} hint={t('knowledgeServerHint')}>
            <Input className="dt-mono" value={value.server} spellCheck={false} pattern="[A-Za-z0-9_-]{1,32}"
              onChange={event => edit({ server: event.target.value })} />
          </Field>
          <Hint>{t('knowledgeSetup')}</Hint>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['knowledge']} />
  </div>
}
