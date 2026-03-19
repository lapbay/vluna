export function newTraceId(): string {
  // 16 bytes hex (32 chars)
  return randomHex(16)
}

export function newSpanId(): string {
  // 8 bytes hex (16 chars)
  return randomHex(8)
}

function randomHex(bytes: number): string {
  const buf = Buffer.allocUnsafe(bytes)
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf.toString('hex')
}

const TRACE_RE = /^[0-9a-f]{32}$/
const SPAN_RE = /^[0-9a-f]{16}$/

export function parseIncomingTrace(traceparent?: string | null, xRequestId?: string | null): string {
  let traceId: string | undefined
  if (traceparent) {
    const parts = traceparent.split('-')
    if (parts.length === 4 && TRACE_RE.test(parts[1]) && SPAN_RE.test(parts[2])) {
      traceId = parts[1]
    }
  }
  if (!traceId && xRequestId && TRACE_RE.test(xRequestId)) {
    traceId = xRequestId
  }
  return traceId || newTraceId()
}

