/** Text helpers shared by Feishu replies and cards: the cmd-safe rewrite and the post-content JSON. */

/** Full-width forms of the characters cmd re-reads; they read the same in a message and reach Feishu intact. */
const CMD_UNSAFE: Record<string, string> = { '<': '＜', '>': '＞', '&': '＆', '|': '｜', '^': '＾', '!': '！', '%': '％' }
/**
 * Feishu's CLI is a `.cmd` wrapper that re-runs the real CLI with `%*` under `EnableDelayedExpansion`, and Windows reaches it
 * through `cmd.exe /c`, so a message argument passes two cmd parsers. The JSON a reply needs is made of quotes, so cmd does
 * not keep it as one quoted word. Measured through that chain: `&` cuts the content at the character (a reply carrying
 * `「收集&更新飘带动画List」` arrived as invalid JSON and its tail ran as a command), `|` loses the argument, `<` and `>` are
 * redirections, `^` and `!` disappear without an error, and `%NAME%` expands. Full-width forms are the one rewrite that
 * survives both parsers, so every string that goes into a message passes through here.
 */
export const cmdSafe = (text: string): string => text.replace(/[<>&|^!%]/g, char => CMD_UNSAFE[char] ?? char)
/**
 * The `post` content JSON for Markdown text. `JSON.stringify` escapes every newline, so the whole message reaches the CLI
 * as one argument even through the Windows `.cmd` wrapper that `Commands` runs with `cmd.exe /c`; a literal newline there
 * would be cut at the first line by cmd before the CLI ever saw it.
 */
export const feishuPostContent = (text: string): string => JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } })
