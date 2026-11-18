// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalLink, clientHref, linkTarget } from '../src/client/widgets.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const desktopAgent = browserAgent.replace('Chrome/152.0.0.0', 'Chrome/152.0.7977.130 Electron/44.7.0')
const originalAgent = navigator.userAgent
const useAgent = (value: string): void => { Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => value }) }
afterEach(() => { useAgent(originalAgent) })

const feishuLink = 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=-1'
const larkLink = 'https://applink.larksuite.com/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1'
const tab = { target: '_blank', rel: 'noopener noreferrer' }

async function renderLink(href: string): Promise<HTMLAnchorElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<ExternalLink href={href}>打开飞书原文</ExternalLink>) })
  const anchor = container.querySelector('a')!
  act(() => { root.unmount() })
  container.remove()
  return anchor
}

describe('external links in the panel', () => {
  it('hands a Feishu AppLink to the client in a browser, leaving no landing page tab', async () => {
    useAgent(browserAgent)
    expect(clientHref(feishuLink)).toBe('feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=-1')
    expect(clientHref(larkLink)).toBe('lark://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1')
    expect(linkTarget(clientHref(feishuLink))).toEqual({})
    expect(linkTarget(clientHref(larkLink))).toEqual({})
    expect(clientHref('https://example.test/a')).toBe('https://example.test/a')
    expect(linkTarget('https://example.test/a')).toEqual(tab)
    const anchor = await renderLink(feishuLink)
    expect(anchor.getAttribute('href')).toBe('feishu://applink/client/thread/open?open_chat_id=oc_1&open_thread_id=omt_1&thread_position=-1')
    expect(anchor.hasAttribute('target')).toBe(false)
  })
  it('keeps the AppLink in its https form inside the DSH desktop shell, which only opens http(s) in the browser', async () => {
    useAgent(desktopAgent)
    expect(clientHref(feishuLink)).toBe(feishuLink)
    expect(clientHref(larkLink)).toBe(larkLink)
    // Older tickets may still store the client scheme; the shell drops it, so it opens through the browser form.
    expect(clientHref('feishu://applink/client/thread/open?open_chat_id=oc_1')).toBe('https://applink.feishu.cn/client/thread/open?open_chat_id=oc_1')
    expect(clientHref('lark://applink/client/thread/open?open_chat_id=oc_1')).toBe('https://applink.larksuite.com/client/thread/open?open_chat_id=oc_1')
    expect(linkTarget(clientHref(feishuLink))).toEqual(tab)
    expect(linkTarget(clientHref('feishu://applink/client/thread/open?open_chat_id=oc_1'))).toEqual(tab)
    expect(clientHref('https://example.test/a')).toBe('https://example.test/a')
    const anchor = await renderLink(feishuLink)
    expect(anchor.getAttribute('href')).toBe(feishuLink)
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })
})
