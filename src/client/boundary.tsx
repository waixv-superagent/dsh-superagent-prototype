/** Error boundary that keeps a crashed panel page recoverable in place instead of leaving the host's blank slot. */
import { Component, type ReactNode } from 'react'
import { Button, Icon } from './controls.tsx'
import type { T } from './text.ts'

interface Props {
  t: T
  /** A change of key (the page shown) clears a caught error, so leaving a broken page needs no reload. */
  resetKey: string
  /** Leave the broken page for the panel's home; absent at the panel's outer boundary, where retrying is the only way. */
  onHome?: () => void
  children: ReactNode
}
interface State { error: Error | undefined; key: string; attempt: number }

/**
 * Catches a render error below it and shows what failed with Retry (remount the same page) and, when given, a way home.
 * Without it the host's slot boundary retires the whole panel to an empty element until the browser reloads.
 */
export class PageBoundary extends Component<Props, State> {
  override state: State = { error: undefined, key: this.props.resetKey, attempt: 0 }
  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { key: props.resetKey, error: undefined }
  }
  override componentDidCatch(error: unknown): void {
    console.error('dsh-superagent: a panel page crashed', error)
  }
  private readonly retry = () => { this.setState(state => ({ error: undefined, attempt: state.attempt + 1 })) }
  override render(): ReactNode {
    const { t, onHome, children } = this.props
    const { error, attempt } = this.state
    if (!error) return <div key={attempt} style={{ display: 'contents' }}>{children}</div>
    return <div className="dt-crash" role="alert">
      <span className="dt-crash-icon"><Icon name="alert" size={20} /></span>
      <div className="dt-crash-text">
        <h2>{t('pageCrashed')}</h2>
        <p>{t('pageCrashedHint')}</p>
        <code className="dt-crash-detail">{error.message || error.name}</code>
      </div>
      <div className="dt-actions">
        <Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={this.retry}>{t('retry')}</Button>
        {onHome && <Button variant="outline" size="sm" onClick={onHome}>{t('pageCrashedHome')}</Button>}
      </div>
    </div>
  }
}
