/** Text helpers shared by Feishu replies and cards: the argument-safe JSON and the display rewrite. */

/** Full-width forms of the two characters card markdown reads as tag syntax; they read the same in a message. */
const ANGLE: Record<string, string> = { '<': '＜', '>': '＞' }
/**
 * Card and post markdown reads `<…>` as a tag (the cards write `<font>`, `<at>`), so loose angle brackets in a message are
 * shown full-width. Every other character is safe here and now reaches Feishu unchanged: the argument itself travels as JSON
 * with cmd's syntax characters unicode-escaped (see `jsonForCmd`), not as full-width look-alikes.
 */
export const textSafe = (text: string): string => text.replace(/[<>]/g, char => ANGLE[char] ?? char)
/** The characters the Windows `.cmd` wrapper re-reads, and the JSON unicode escape that keeps each out of its argv. */
const CMD_SYNTAX = /[<>&|^!%]/g
const JSON_ESCAPE: Record<string, string> = {
  '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '|': '\\u007c', '^': '\\u005e', '!': '\\u0021', '%': '\\u0025',
}
/**
 * A JSON argument that survives Feishu's CLI wrapper: `lark-cli` is a `.cmd` shim that re-runs itself with `%*` under
 * `EnableDelayedExpansion`, so a bare `&`, `|`, `<`, `>`, `^`, `!` or `%` in the argument is re-read as syntax and can cut
 * or corrupt the payload. Writing each of them as its JSON unicode escape keeps them out of the command line while Feishu's
 * JSON parser still turns the escaped value back into the original character. `JSON.stringify` escapes newlines and quotes
 * first, so the whole JSON stays one argument.
 */
export const jsonForCmd = (value: unknown): string => JSON.stringify(value).replace(CMD_SYNTAX, char => JSON_ESCAPE[char] ?? char)
/**
 * The `post` content JSON for Markdown text. `JSON.stringify` escapes every newline, so the whole message reaches the CLI
 * as one argument even through the Windows `.cmd` wrapper that `Commands` runs with `cmd.exe /c`; a literal newline there
 * would be cut at the first line by cmd before the CLI ever saw it. A URL keeps its `&` and `%`, so a link stays clickable.
 */
export const feishuPostContent = (text: string): string => jsonForCmd({ zh_cn: { content: [[{ tag: 'md', text }]] } })
