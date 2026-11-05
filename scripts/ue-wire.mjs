/**
 * Content-Length framed JSON messages, shared by the clangd LSP client (`ue-clangd.mjs`) and the
 * lldb-dap DAP client (`ue-lldb.mjs`). Both protocols put a JSON object after a small ASCII header.
 *
 * The framing is deliberately dumb: it never interprets the body, so a test can feed a stream of
 * bytes and check exactly which messages come out and what is left for the next read.
 */

/** Encodes one JSON message as a `Content-Length` framed buffer. */
export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/**
 * Consumes as many complete framed messages as `buffer` holds and returns them with the unfinished
 * remainder. A frame whose header lacks `Content-Length`, or whose body is not JSON, throws: a
 * corrupt stream must fail loudly instead of making a request wait forever.
 */
export function parseMessages(buffer) {
  const messages = []
  let rest = buffer
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.subarray(0, headerEnd).toString('ascii')
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
    if (!match) throw new Error(`JSON message frame has no Content-Length header: ${header.slice(0, 200)}`)
    const length = Number(match[1])
    const end = headerEnd + 4 + length
    if (rest.length < end) break
    const body = rest.subarray(headerEnd + 4, end).toString('utf8')
    rest = rest.subarray(end)
    let message
    try {
      message = JSON.parse(body)
    } catch (error) {
      throw new Error(`JSON message body is not valid JSON (${String(error)}): ${body.slice(0, 200)}`)
    }
    messages.push(message)
  }
  return { messages, rest }
}
