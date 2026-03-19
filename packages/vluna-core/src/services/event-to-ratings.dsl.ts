import { normalizeIdentifier } from '../utils/identifiers.js'

type LinkKind = 'billed' | 'adjustment' | 'reversal' | 'shadow'

export type EventToRatingsDsl = {
  dsl_version: 'v1'
  engine: 'single' | 'aggregate'
  params?: Record<string, ParamSpec>
  match: DslMatch
  emit: { intents: DslIntent[] }
}

export type DslMatch = {
  event_type:
    | string
    | { op: 'exact'; value: string }
    | { op: 'prefix'; value: string }
    | { op: 'regex'; value: string; flags?: string }
  where?: Predicate
}

type ParamSpec =
  | { type: 'int'; default?: number; min?: number; max?: number; source?: { term_key: string } }
  | { type: 'string'; default?: string; source?: { term_key: string } }
  | { type: 'string[]'; default?: string[]; source?: { term_key: string } }
  | { type: 'bool'; default?: boolean; source?: { term_key: string } }

type ResolvedParams = Record<string, number | string | string[] | boolean>

type CompiledParamSpec =
  | { type: 'int'; default?: number; min?: number; max?: number; sourceTermKey?: string }
  | { type: 'string'; default?: string; sourceTermKey?: string }
  | { type: 'string[]'; default?: string[]; sourceTermKey?: string }
  | { type: 'bool'; default?: boolean; sourceTermKey?: string }

type CompiledParams = {
  specs: Record<string, CompiledParamSpec>
  requiredTermKeys: string[]
}

type DslIntent = {
  link_kind?: LinkKind
  feature_code: string
  budget_id?: StringExpr | string
  feature_quantity_minor?: IntExpr | number
  meters: Array<{ meter_code: string; quantity_minor: IntExpr | number }>
  labels?: Record<string, StringExpr | string>
  metadata?: Record<string, AnyExpr>
}

type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { eq: [ValueExpr, ValueExpr] }
  | { ne: [ValueExpr, ValueExpr] }
  | { in: [ValueExpr, ValueExpr[]] }
  | { gt: [ValueExpr, ValueExpr] }
  | { gte: [ValueExpr, ValueExpr] }
  | { lt: [ValueExpr, ValueExpr] }
  | { lte: [ValueExpr, ValueExpr] }
  | { exists: [ValueExpr] }
  | { prefix: [ValueExpr, string] }
  | { contains: [ValueExpr, string] }

type ValueExpr =
  | null
  | boolean
  | number
  | string
  | Record<string, unknown>
  | { event: 'subject_ref' | 'occurred_at' | 'billing_account_id' | 'event_type' | 'semantic_kind' }
  | { payload: string }
  | { label: string }
  | { param: string }
  | StringExpr
  | IntExpr

type AggOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'

type AggEventField = 'subject_ref' | 'occurred_at' | 'billing_account_id' | 'event_type' | 'semantic_kind'

type AggOf =
  | { payload: string }
  | { label: string }
  | { event: AggEventField }

type IntExpr =
  | { const: number }
  | { payload_int: string; default?: number }
  | { label_int: string; default?: number }
  | { agg: { key?: string; op: AggOp; of?: AggOf; default?: number; rounding?: 'floor' | 'ceil' | 'nearest' } }
  | { param: string }
  | { mul: [IntExpr | number, IntExpr | number] }
  | { div: [IntExpr | number, IntExpr | number]; rounding?: 'floor' | 'ceil' | 'nearest' }

type StringExpr =
  | { const: string }
  | { payload_str: string; default?: string }
  | { label_str: string; default?: string }
  | { event_str: 'subject_ref' | 'event_type' | 'billing_account_id' | 'semantic_kind' }
  | { param: string }

type AnyExpr = unknown | StringExpr | IntExpr

export type EngineInput =
  | {
      source_kind: 'event'
      realm_id: string
      billing_account_id: string
      semantic_kind: 'activity' | 'outcome'
      occurred_at: string
      event_type: string
      subject_ref: string | null
      payload: Record<string, unknown>
      labels: Record<string, unknown>
    }
  | {
      source_kind: 'aggregate'
      realm_id: string
      billing_account_id: string
      semantic_kind: 'activity' | 'outcome'
      event_type: string
      aggregation: {
        window_start: string
        window_end: string
      }
      aggs: Record<string, number | null>
    }

export type EngineIntent = {
  linkKind: LinkKind
  featureCode: string
  budgetId?: string
  quantityMinor?: number
  meters: Array<{ meterCode: string; quantityMinor: number }>
  labels?: Record<string, string>
  metadata?: Record<string, unknown>
}

export type CompiledEventToRatingsDsl = {
  dsl_version: 'v1'
  engine: 'single' | 'aggregate'
  params: CompiledParams
  match: {
    eventTypeExact: string
    where?: Predicate
  }
  intents: Array<{
    linkKind: LinkKind
    featureCode: string
    budgetId?: StringExpr
    quantityMinor?: IntExpr
    meters: Array<{ meterCode: string; quantityMinor: IntExpr }>
    labels?: Record<string, StringExpr>
    metadata?: Record<string, AnyExpr>
  }>
}

const SLUG_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/

function normalizeSlug(input: string): string | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
  if (!normalized) return null
  if (!SLUG_RE.test(normalized)) return null
  return normalized
}

function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseNonNegativeInt(raw: unknown, name: string): number {
  if (!isFiniteNumber(raw)) throw new Error(`${name} must be a finite number`)
  const value = Math.trunc(raw)
  if (value < 0) throw new Error(`${name} must be >= 0`)
  return value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function getByDotPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  if (!path.trim()) return undefined
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean)
  let current: unknown = obj
  for (const key of parts) {
    if (!current || typeof current !== 'object') return undefined
    const record = current as Record<string, unknown>
    current = record[key]
  }
  return current
}

function toNumberMaybe(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function toStringMaybe(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

function compileParamSpecs(raw: unknown): CompiledParams {
  if (raw === undefined) return { specs: {}, requiredTermKeys: [] }
  const root = assertObject(raw, 'dsl.params')
  const specs: Record<string, CompiledParamSpec> = {}
  const requiredTermKeys: string[] = []

  for (const [name, specRaw] of Object.entries(root)) {
    const spec = assertObject(specRaw, `dsl.params.${name}`)
    const type = assertString(spec.type, `dsl.params.${name}.type`)
    const sourceRaw = Object.prototype.hasOwnProperty.call(spec, 'source') ? spec.source : undefined
    let sourceTermKey: string | undefined
    if (sourceRaw !== undefined) {
      const sourceObj = assertObject(sourceRaw, `dsl.params.${name}.source`)
      const termKey = assertString(sourceObj.term_key, `dsl.params.${name}.source.term_key`).trim()
      if (!termKey) throw new Error(`dsl.params.${name}.source.term_key must not be empty`)
      const normalizedTermKey = normalizeIdentifier(termKey, 'term_key')
      sourceTermKey = normalizedTermKey
      requiredTermKeys.push(normalizedTermKey)
    }

    if (type === 'int') {
      const def = Object.prototype.hasOwnProperty.call(spec, 'default') ? parseNonNegativeInt(spec.default, `dsl.params.${name}.default`) : undefined
      const min = Object.prototype.hasOwnProperty.call(spec, 'min') ? parseNonNegativeInt(spec.min, `dsl.params.${name}.min`) : undefined
      const max = Object.prototype.hasOwnProperty.call(spec, 'max') ? parseNonNegativeInt(spec.max, `dsl.params.${name}.max`) : undefined
      if (min !== undefined && def !== undefined && def < min) throw new Error(`dsl.params.${name}.default must be >= min`)
      if (max !== undefined && def !== undefined && def > max) throw new Error(`dsl.params.${name}.default must be <= max`)
      specs[name] = { type: 'int', default: def, min, max, sourceTermKey }
      continue
    }
    if (type === 'string') {
      const def = Object.prototype.hasOwnProperty.call(spec, 'default') ? assertString(spec.default, `dsl.params.${name}.default`) : undefined
      specs[name] = { type: 'string', default: def, sourceTermKey }
      continue
    }
    if (type === 'string[]') {
      const defRaw = Object.prototype.hasOwnProperty.call(spec, 'default') ? spec.default : undefined
      const def = defRaw === undefined
        ? undefined
        : assertArray(defRaw, `dsl.params.${name}.default`).map((v, i) => assertString(v, `dsl.params.${name}.default[${i}]`))
      specs[name] = { type: 'string[]', default: def, sourceTermKey }
      continue
    }
    if (type === 'bool') {
      const defRaw = Object.prototype.hasOwnProperty.call(spec, 'default') ? spec.default : undefined
      if (defRaw !== undefined && typeof defRaw !== 'boolean') {
        throw new Error(`dsl.params.${name}.default must be a boolean`)
      }
      specs[name] = { type: 'bool', default: defRaw as boolean | undefined, sourceTermKey }
      continue
    }
    throw new Error(`dsl.params.${name}.type unsupported: ${type}`)
  }

  return { specs, requiredTermKeys: Array.from(new Set(requiredTermKeys)) }
}

function compileMatchEventType(raw: unknown): string {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (!value) throw new Error('dsl.match.event_type must not be empty')
    return value
  }
  const obj = assertObject(raw, 'dsl.match.event_type')
  const op = assertString(obj.op, 'dsl.match.event_type.op')
  if (op !== 'exact') {
    throw new Error(`dsl.match.event_type.op not implemented: ${op}`)
  }
  const value = assertString(obj.value, 'dsl.match.event_type.value').trim()
  if (!value) throw new Error('dsl.match.event_type.value must not be empty')
  return value
}

function compileIntExpr(raw: unknown, name: string): IntExpr {
  if (typeof raw === 'number') return { const: parseNonNegativeInt(raw, name) }
  const obj = assertObject(raw, name)
  if (Object.prototype.hasOwnProperty.call(obj, 'const')) {
    return { const: parseNonNegativeInt(obj.const, `${name}.const`) }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'payload_int')) {
    const path = assertString(obj.payload_int, `${name}.payload_int`).trim()
    if (!path) throw new Error(`${name}.payload_int must not be empty`)
    const def = Object.prototype.hasOwnProperty.call(obj, 'default') ? parseNonNegativeInt(obj.default, `${name}.default`) : undefined
    return { payload_int: path, default: def }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'label_int')) {
    const key = assertString(obj.label_int, `${name}.label_int`).trim()
    if (!key) throw new Error(`${name}.label_int must not be empty`)
    const def = Object.prototype.hasOwnProperty.call(obj, 'default') ? parseNonNegativeInt(obj.default, `${name}.default`) : undefined
    return { label_int: key, default: def }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'agg')) {
    const aggObj = assertObject(obj.agg, `${name}.agg`)
    const op = assertString(aggObj.op, `${name}.agg.op`) as AggOp
    if (!['count', 'sum', 'avg', 'min', 'max', 'count_distinct'].includes(op)) {
      throw new Error(`${name}.agg.op unsupported: ${String(aggObj.op)}`)
    }

    const defaultRaw = Object.prototype.hasOwnProperty.call(aggObj, 'default') ? aggObj.default : undefined
    const def = defaultRaw === undefined ? undefined : parseNonNegativeInt(defaultRaw, `${name}.agg.default`)

    const roundingRaw = aggObj.rounding === undefined ? undefined : assertString(aggObj.rounding, `${name}.agg.rounding`)
    if (roundingRaw !== undefined && roundingRaw !== 'floor' && roundingRaw !== 'ceil' && roundingRaw !== 'nearest') {
      throw new Error(`${name}.agg.rounding unsupported: ${roundingRaw}`)
    }
    const rounding = roundingRaw as 'floor' | 'ceil' | 'nearest' | undefined

    const ofRaw = Object.prototype.hasOwnProperty.call(aggObj, 'of') ? aggObj.of : undefined
    let of: AggOf | undefined
    if (op === 'count') {
      if (ofRaw !== undefined) throw new Error(`${name}.agg.of must not be provided when op=count`)
    } else {
      if (ofRaw === undefined) throw new Error(`${name}.agg.of is required when op=${op}`)
      const ofObj = assertObject(ofRaw, `${name}.agg.of`)
      if (Object.prototype.hasOwnProperty.call(ofObj, 'payload')) {
        const path = assertString(ofObj.payload, `${name}.agg.of.payload`).trim()
        if (!path) throw new Error(`${name}.agg.of.payload must not be empty`)
        of = { payload: path }
      } else if (Object.prototype.hasOwnProperty.call(ofObj, 'label')) {
        const key = assertString(ofObj.label, `${name}.agg.of.label`).trim()
        if (!key) throw new Error(`${name}.agg.of.label must not be empty`)
        of = { label: key }
      } else if (Object.prototype.hasOwnProperty.call(ofObj, 'event')) {
        const field = assertString(ofObj.event, `${name}.agg.of.event`)
        if (!['subject_ref', 'occurred_at', 'billing_account_id', 'event_type', 'semantic_kind'].includes(field)) {
          throw new Error(`${name}.agg.of.event unsupported: ${field}`)
        }
        of = { event: field as AggEventField }
      } else {
        throw new Error(`${name}.agg.of must contain one of: payload, label, event`)
      }
    }

    if ((op === 'sum' || op === 'avg' || op === 'min' || op === 'max') && of && 'event' in of) {
      throw new Error(`${name}.agg.of.event is not allowed for op=${op}`)
    }
    if (op === 'count_distinct' && !of) {
      throw new Error(`${name}.agg.of is required when op=count_distinct`)
    }

    const key =
      op === 'count'
        ? 'count'
        : `${op}:${of && 'payload' in of ? `payload:${of.payload}` : of && 'label' in of ? `label:${of.label}` : of && 'event' in of ? `event:${of.event}` : 'unknown'}`

    return { agg: { key, op, of, default: def, rounding } }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'param')) {
    const param = assertString(obj.param, `${name}.param`).trim()
    if (!param) throw new Error(`${name}.param must not be empty`)
    return { param }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'mul')) {
    const args = assertArray(obj.mul, `${name}.mul`)
    if (args.length !== 2) throw new Error(`${name}.mul must have 2 args`)
    return { mul: [compileIntExpr(args[0], `${name}.mul[0]`), compileIntExpr(args[1], `${name}.mul[1]`)] }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'div')) {
    const args = assertArray(obj.div, `${name}.div`)
    if (args.length !== 2) throw new Error(`${name}.div must have 2 args`)
    const roundingRaw = obj.rounding === undefined ? undefined : assertString(obj.rounding, `${name}.rounding`)
    if (roundingRaw !== undefined && roundingRaw !== 'floor' && roundingRaw !== 'ceil' && roundingRaw !== 'nearest') {
      throw new Error(`${name}.rounding unsupported: ${roundingRaw}`)
    }
    return {
      div: [compileIntExpr(args[0], `${name}.div[0]`), compileIntExpr(args[1], `${name}.div[1]`)],
      rounding: roundingRaw,
    }
  }
  throw new Error(`${name} unsupported int_expr`)
}

function compileStringExpr(raw: unknown, name: string): StringExpr {
  if (typeof raw === 'string') return { const: raw }
  const obj = assertObject(raw, name)
  if (Object.prototype.hasOwnProperty.call(obj, 'const')) {
    return { const: assertString(obj.const, `${name}.const`) }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'payload_str')) {
    const path = assertString(obj.payload_str, `${name}.payload_str`).trim()
    if (!path) throw new Error(`${name}.payload_str must not be empty`)
    const def = Object.prototype.hasOwnProperty.call(obj, 'default') ? assertString(obj.default, `${name}.default`) : undefined
    return { payload_str: path, default: def }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'label_str')) {
    const key = assertString(obj.label_str, `${name}.label_str`).trim()
    if (!key) throw new Error(`${name}.label_str must not be empty`)
    const def = Object.prototype.hasOwnProperty.call(obj, 'default') ? assertString(obj.default, `${name}.default`) : undefined
    return { label_str: key, default: def }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'event_str')) {
    const field = assertString(obj.event_str, `${name}.event_str`)
    if (field !== 'subject_ref' && field !== 'event_type' && field !== 'billing_account_id' && field !== 'semantic_kind') {
      throw new Error(`${name}.event_str unsupported: ${field}`)
    }
    return { event_str: field }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'param')) {
    const param = assertString(obj.param, `${name}.param`).trim()
    if (!param) throw new Error(`${name}.param must not be empty`)
    return { param }
  }
  throw new Error(`${name} unsupported string_expr`)
}

function compileAnyExpr(raw: unknown, name: string): AnyExpr {
  if (raw === null) return null
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (Array.isArray(raw)) return raw.map((v, i) => compileAnyExpr(v, `${name}[${i}]`))
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Object.keys(obj).length === 1 && Object.prototype.hasOwnProperty.call(obj, 'param')) {
      return compileStringExpr(raw, name)
    }
    if (
      Object.prototype.hasOwnProperty.call(obj, 'payload_str') ||
      Object.prototype.hasOwnProperty.call(obj, 'label_str') ||
      Object.prototype.hasOwnProperty.call(obj, 'event_str') ||
      Object.prototype.hasOwnProperty.call(obj, 'const')
    ) {
      return compileStringExpr(raw, name)
    }
    if (
      Object.prototype.hasOwnProperty.call(obj, 'payload_int') ||
      Object.prototype.hasOwnProperty.call(obj, 'label_int') ||
      Object.prototype.hasOwnProperty.call(obj, 'agg') ||
      Object.prototype.hasOwnProperty.call(obj, 'mul') ||
      Object.prototype.hasOwnProperty.call(obj, 'div')
    ) {
      return compileIntExpr(raw, name)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = compileAnyExpr(v, `${name}.${k}`)
    }
    return out
  }
  return raw
}

function compileValueExpr(raw: unknown, name: string): ValueExpr {
  if (raw === null || typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') return raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${name} must be a value expression`)
  }
  const obj = raw as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(obj, 'event')) {
    const field = assertString(obj.event, `${name}.event`)
    if (field !== 'subject_ref' && field !== 'occurred_at' && field !== 'billing_account_id' && field !== 'event_type' && field !== 'semantic_kind') {
      throw new Error(`${name}.event unsupported: ${field}`)
    }
    return { event: field }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'payload')) {
    const path = assertString(obj.payload, `${name}.payload`).trim()
    if (!path) throw new Error(`${name}.payload must not be empty`)
    return { payload: path }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'label')) {
    const key = assertString(obj.label, `${name}.label`).trim()
    if (!key) throw new Error(`${name}.label must not be empty`)
    return { label: key }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'param')) {
    const key = assertString(obj.param, `${name}.param`).trim()
    if (!key) throw new Error(`${name}.param must not be empty`)
    return { param: key }
  }
  if (
    Object.prototype.hasOwnProperty.call(obj, 'payload_str') ||
    Object.prototype.hasOwnProperty.call(obj, 'label_str') ||
    Object.prototype.hasOwnProperty.call(obj, 'event_str') ||
    Object.prototype.hasOwnProperty.call(obj, 'const')
  ) {
    return compileStringExpr(raw, name)
  }
  if (
    Object.prototype.hasOwnProperty.call(obj, 'payload_int') ||
    Object.prototype.hasOwnProperty.call(obj, 'label_int') ||
    Object.prototype.hasOwnProperty.call(obj, 'agg') ||
    Object.prototype.hasOwnProperty.call(obj, 'mul') ||
    Object.prototype.hasOwnProperty.call(obj, 'div')
  ) {
    return compileIntExpr(raw, name)
  }
  return obj
}

function compilePredicate(raw: unknown, name: string): Predicate {
  const obj = assertObject(raw, name)
  const keys = Object.keys(obj)
  if (keys.length !== 1) throw new Error(`${name} must have exactly 1 key`)
  const op = keys[0]!

  if (op === 'all') {
    const items = assertArray(obj.all, `${name}.all`).map((p, i) => compilePredicate(p, `${name}.all[${i}]`))
    return { all: items }
  }
  if (op === 'any') {
    const items = assertArray(obj.any, `${name}.any`).map((p, i) => compilePredicate(p, `${name}.any[${i}]`))
    return { any: items }
  }
  if (op === 'not') {
    return { not: compilePredicate(obj.not, `${name}.not`) }
  }

  const binary = (field: string): [ValueExpr, ValueExpr] => {
    const args = assertArray((obj as Record<string, unknown>)[field], `${name}.${field}`)
    if (args.length !== 2) throw new Error(`${name}.${field} must have 2 args`)
    return [compileValueExpr(args[0], `${name}.${field}[0]`), compileValueExpr(args[1], `${name}.${field}[1]`)]
  }

  if (op === 'eq') {
    const [a, b] = binary('eq')
    return { eq: [a, b] }
  }
  if (op === 'ne') {
    const [a, b] = binary('ne')
    return { ne: [a, b] }
  }
  if (op === 'gt') {
    const [a, b] = binary('gt')
    return { gt: [a, b] }
  }
  if (op === 'gte') {
    const [a, b] = binary('gte')
    return { gte: [a, b] }
  }
  if (op === 'lt') {
    const [a, b] = binary('lt')
    return { lt: [a, b] }
  }
  if (op === 'lte') {
    const [a, b] = binary('lte')
    return { lte: [a, b] }
  }
  if (op === 'in') {
    const args = assertArray(obj.in, `${name}.in`)
    if (args.length !== 2) throw new Error(`${name}.in must have 2 args`)
    const lhs = compileValueExpr(args[0], `${name}.in[0]`)
    const rhsArr = assertArray(args[1], `${name}.in[1]`).map((v, i) => compileValueExpr(v, `${name}.in[1][${i}]`))
    return { in: [lhs, rhsArr] }
  }
  if (op === 'exists') {
    const args = assertArray(obj.exists, `${name}.exists`)
    if (args.length !== 1) throw new Error(`${name}.exists must have 1 arg`)
    return { exists: [compileValueExpr(args[0], `${name}.exists[0]`)] }
  }
  if (op === 'prefix') {
    const args = assertArray(obj.prefix, `${name}.prefix`)
    if (args.length !== 2) throw new Error(`${name}.prefix must have 2 args`)
    const lhs = compileValueExpr(args[0], `${name}.prefix[0]`)
    const rhs = assertString(args[1], `${name}.prefix[1]`)
    return { prefix: [lhs, rhs] }
  }
  if (op === 'contains') {
    const args = assertArray(obj.contains, `${name}.contains`)
    if (args.length !== 2) throw new Error(`${name}.contains must have 2 args`)
    const lhs = compileValueExpr(args[0], `${name}.contains[0]`)
    const rhs = assertString(args[1], `${name}.contains[1]`)
    return { contains: [lhs, rhs] }
  }

  throw new Error(`${name} unsupported predicate op: ${op}`)
}

export function compileEventToRatingsDsl(raw: unknown): CompiledEventToRatingsDsl {
  const root = assertObject(raw, 'dsl')
  const version = assertString(root.dsl_version, 'dsl.dsl_version')
  if (version !== 'v1') throw new Error(`Unsupported dsl.dsl_version: ${version}`)

  const engine = assertString(root.engine, 'dsl.engine')
  if (engine !== 'single' && engine !== 'aggregate') {
    throw new Error(`dsl.engine unsupported: ${engine}`)
  }

  const params = compileParamSpecs(root.params)
  const matchRaw = assertObject(root.match, 'dsl.match')
  const eventTypeExact = compileMatchEventType(matchRaw.event_type)
  const where = matchRaw.where === undefined ? undefined : compilePredicate(matchRaw.where, 'dsl.match.where')

  const emitRaw = assertObject(root.emit, 'dsl.emit')
  const intentsRaw = assertArray(emitRaw.intents, 'dsl.emit.intents')
  if (intentsRaw.length === 0) throw new Error('dsl.emit.intents must not be empty')

  const intents: CompiledEventToRatingsDsl['intents'] = []
  for (let i = 0; i < intentsRaw.length; i += 1) {
    const intent = assertObject(intentsRaw[i], `dsl.emit.intents[${i}]`)
    const linkKindRaw = intent.link_kind
    const linkKind = linkKindRaw === undefined ? 'billed' : assertString(linkKindRaw, `dsl.emit.intents[${i}].link_kind`)
    if (linkKind !== 'billed' && linkKind !== 'adjustment' && linkKind !== 'reversal' && linkKind !== 'shadow') {
      throw new Error(`dsl.emit.intents[${i}].link_kind unsupported: ${linkKind}`)
    }

    const featureCode = assertString(intent.feature_code, `dsl.emit.intents[${i}].feature_code`).trim()
    if (!featureCode || !SLUG_RE.test(featureCode)) {
      throw new Error(`dsl.emit.intents[${i}].feature_code must be a slug`)
    }

    const budgetId = intent.budget_id === undefined ? undefined : compileStringExpr(intent.budget_id, `dsl.emit.intents[${i}].budget_id`)
    const quantityMinor = intent.feature_quantity_minor === undefined ? undefined : compileIntExpr(intent.feature_quantity_minor, `dsl.emit.intents[${i}].feature_quantity_minor`)

    const metersRaw = assertArray(intent.meters, `dsl.emit.intents[${i}].meters`)
    if (metersRaw.length === 0) throw new Error(`dsl.emit.intents[${i}].meters must not be empty`)
    const meters = metersRaw.map((m, j) => {
      const meter = assertObject(m, `dsl.emit.intents[${i}].meters[${j}]`)
      const meterCode = assertString(meter.meter_code, `dsl.emit.intents[${i}].meters[${j}].meter_code`).trim()
      if (!meterCode || !SLUG_RE.test(meterCode)) {
        throw new Error(`dsl.emit.intents[${i}].meters[${j}].meter_code must be a slug`)
      }
      const qty = compileIntExpr(meter.quantity_minor, `dsl.emit.intents[${i}].meters[${j}].quantity_minor`)
      return { meterCode, quantityMinor: qty }
    })

    const labelsRaw = intent.labels === undefined ? undefined : assertObject(intent.labels, `dsl.emit.intents[${i}].labels`)
    const labels: Record<string, StringExpr> | undefined = labelsRaw
      ? Object.fromEntries(Object.entries(labelsRaw).map(([k, v]) => [k, compileStringExpr(v, `dsl.emit.intents[${i}].labels.${k}`)]))
      : undefined

    const metadataRaw = intent.metadata === undefined ? undefined : assertObject(intent.metadata, `dsl.emit.intents[${i}].metadata`)
    const metadata: Record<string, AnyExpr> | undefined = metadataRaw
      ? Object.fromEntries(Object.entries(metadataRaw).map(([k, v]) => [k, compileAnyExpr(v, `dsl.emit.intents[${i}].metadata.${k}`)]))
      : undefined

    intents.push({
      linkKind,
      featureCode,
      budgetId,
      quantityMinor,
      meters,
      labels,
      metadata,
    })
  }

  return {
    dsl_version: 'v1',
    engine,
    params,
    match: { eventTypeExact, where },
    intents,
  }
}

function resolveParam(name: string, params: ResolvedParams): number | string | string[] | boolean | null {
  if (!Object.prototype.hasOwnProperty.call(params, name)) return null
  return params[name] ?? null
}

function resolveString(expr: StringExpr, input: EngineInput, params: ResolvedParams): string | null {
  if ('const' in expr) return expr.const
  if ('payload_str' in expr) {
    const value = input.source_kind === 'event' ? getByDotPath(input.payload, expr.payload_str) : undefined
    const str = toStringMaybe(value)
    if (str !== null) return str
    return expr.default ?? null
  }
  if ('label_str' in expr) {
    const value = input.source_kind === 'event' ? input.labels[expr.label_str] : undefined
    const str = toStringMaybe(value)
    if (str !== null) return str
    return expr.default ?? null
  }
  if ('event_str' in expr) {
    if (expr.event_str === 'subject_ref') return input.source_kind === 'event' ? input.subject_ref : null
    if (expr.event_str === 'event_type') return input.event_type
    if (expr.event_str === 'billing_account_id') return input.billing_account_id
    if (expr.event_str === 'semantic_kind') return input.semantic_kind
    return null
  }
  if ('param' in expr) {
    const value = resolveParam(expr.param, params)
    if (typeof value === 'string') return value
    return null
  }
  return null
}

function resolveInt(expr: IntExpr, input: EngineInput, params: ResolvedParams): number | null {
  if ('const' in expr) return expr.const
  if ('payload_int' in expr) {
    const value = input.source_kind === 'event' ? getByDotPath(input.payload, expr.payload_int) : undefined
    const num = toNumberMaybe(value)
    if (num === null) return expr.default ?? null
    return Math.trunc(num)
  }
  if ('label_int' in expr) {
    const value = input.source_kind === 'event' ? input.labels[expr.label_int] : undefined
    const num = toNumberMaybe(value)
    if (num === null) return expr.default ?? null
    return Math.trunc(num)
  }
  if ('agg' in expr) {
    if (input.source_kind !== 'aggregate') return expr.agg.default ?? null
    const key = expr.agg.key
    if (!key) return expr.agg.default ?? null
    const raw = input.aggs[key]
    if (raw === null || raw === undefined) return expr.agg.default ?? null

    if (expr.agg.op === 'avg') {
      const rounding = expr.agg.rounding ?? 'floor'
      if (rounding === 'ceil') return Math.trunc(Math.ceil(raw))
      if (rounding === 'nearest') return Math.trunc(Math.round(raw))
      return Math.trunc(Math.floor(raw))
    }

    return Math.trunc(raw)
  }
  if ('param' in expr) {
    const value = resolveParam(expr.param, params)
    if (typeof value === 'number') return Math.trunc(value)
    return null
  }
  if ('mul' in expr) {
    const [aExpr, bExpr] = expr.mul
    const a = resolveInt(typeof aExpr === 'number' ? { const: aExpr } : aExpr, input, params)
    const b = resolveInt(typeof bExpr === 'number' ? { const: bExpr } : bExpr, input, params)
    if (a === null || b === null) return null
    return Math.trunc(a * b)
  }
  if ('div' in expr) {
    const [aExpr, bExpr] = expr.div
    const a = resolveInt(typeof aExpr === 'number' ? { const: aExpr } : aExpr, input, params)
    const b = resolveInt(typeof bExpr === 'number' ? { const: bExpr } : bExpr, input, params)
    if (a === null || b === null) return null
    if (b === 0) return null
    const raw = a / b
    const rounding = expr.rounding ?? 'floor'
    if (rounding === 'ceil') return Math.trunc(Math.ceil(raw))
    if (rounding === 'nearest') return Math.trunc(Math.round(raw))
    return Math.trunc(Math.floor(raw))
  }
  return null
}

function resolveValue(expr: ValueExpr, input: EngineInput, params: ResolvedParams): unknown {
  if (expr === null || typeof expr === 'boolean' || typeof expr === 'number' || typeof expr === 'string') return expr
  if (typeof expr === 'object') {
    if ('event' in expr) {
      const field = expr.event
      if (field === 'subject_ref') return input.source_kind === 'event' ? input.subject_ref : null
      if (field === 'occurred_at') return input.source_kind === 'event' ? input.occurred_at : null
      if (field === 'billing_account_id') return input.billing_account_id
      if (field === 'event_type') return input.event_type
      if (field === 'semantic_kind') return input.semantic_kind
      return null
    }
    if ('payload' in expr && typeof (expr as { payload: unknown }).payload === 'string') {
      return input.source_kind === 'event' ? getByDotPath(input.payload, (expr as { payload: string }).payload) : undefined
    }
    if ('label' in expr && typeof (expr as { label: unknown }).label === 'string') {
      return input.source_kind === 'event' ? input.labels[(expr as { label: string }).label] : undefined
    }
    if ('param' in expr && typeof (expr as { param: unknown }).param === 'string') {
      return resolveParam((expr as { param: string }).param, params)
    }
    if ('payload_str' in expr || 'label_str' in expr || 'event_str' in expr || 'const' in expr) {
      return resolveString(expr as StringExpr, input, params)
    }
    if ('payload_int' in expr || 'label_int' in expr || 'agg' in expr || 'mul' in expr || 'div' in expr) {
      return resolveInt(expr as IntExpr, input, params)
    }
  }
  return expr
}

function evalPredicate(predicate: Predicate, input: EngineInput, params: ResolvedParams): boolean {
  if ('all' in predicate) return predicate.all.every((p) => evalPredicate(p, input, params))
  if ('any' in predicate) return predicate.any.some((p) => evalPredicate(p, input, params))
  if ('not' in predicate) return !evalPredicate(predicate.not, input, params)

  if ('exists' in predicate) {
    const value = resolveValue(predicate.exists[0], input, params)
    return value !== null && value !== undefined
  }

  if ('prefix' in predicate) {
    const value = resolveValue(predicate.prefix[0], input, params)
    const str = toStringMaybe(value)
    if (str === null) return false
    return str.startsWith(predicate.prefix[1])
  }

  if ('contains' in predicate) {
    const value = resolveValue(predicate.contains[0], input, params)
    const str = toStringMaybe(value)
    if (str === null) return false
    return str.includes(predicate.contains[1])
  }

  const cmp = (a: unknown, b: unknown): { aNum: number | null; bNum: number | null; aVal: unknown; bVal: unknown } => ({
    aNum: toNumberMaybe(a),
    bNum: toNumberMaybe(b),
    aVal: a,
    bVal: b,
  })

  if ('eq' in predicate) {
    const a = resolveValue(predicate.eq[0], input, params)
    const b = resolveValue(predicate.eq[1], input, params)
    return deepEqual(a, b)
  }
  if ('ne' in predicate) {
    const a = resolveValue(predicate.ne[0], input, params)
    const b = resolveValue(predicate.ne[1], input, params)
    return !deepEqual(a, b)
  }
  if ('in' in predicate) {
    const lhs = resolveValue(predicate.in[0], input, params)
    for (const item of predicate.in[1]) {
      const rhs = resolveValue(item, input, params)
      if (deepEqual(lhs, rhs)) return true
    }
    return false
  }
  if ('gt' in predicate) {
    const a = resolveValue(predicate.gt[0], input, params)
    const b = resolveValue(predicate.gt[1], input, params)
    const { aNum, bNum } = cmp(a, b)
    if (aNum === null || bNum === null) return false
    return aNum > bNum
  }
  if ('gte' in predicate) {
    const a = resolveValue(predicate.gte[0], input, params)
    const b = resolveValue(predicate.gte[1], input, params)
    const { aNum, bNum } = cmp(a, b)
    if (aNum === null || bNum === null) return false
    return aNum >= bNum
  }
  if ('lt' in predicate) {
    const a = resolveValue(predicate.lt[0], input, params)
    const b = resolveValue(predicate.lt[1], input, params)
    const { aNum, bNum } = cmp(a, b)
    if (aNum === null || bNum === null) return false
    return aNum < bNum
  }
  if ('lte' in predicate) {
    const a = resolveValue(predicate.lte[0], input, params)
    const b = resolveValue(predicate.lte[1], input, params)
    const { aNum, bNum } = cmp(a, b)
    if (aNum === null || bNum === null) return false
    return aNum <= bNum
  }

  return false
}

function evalAnyExpr(expr: AnyExpr, input: EngineInput, params: ResolvedParams): unknown {
  if (expr === null || typeof expr === 'string' || typeof expr === 'number' || typeof expr === 'boolean') return expr
  if (Array.isArray(expr)) return expr.map((v) => evalAnyExpr(v, input, params))
  if (expr && typeof expr === 'object') {
    const obj = expr as Record<string, unknown>
    if ('payload_str' in obj || 'label_str' in obj || 'event_str' in obj || 'const' in obj || 'param' in obj) {
      return resolveString(expr as StringExpr, input, params)
    }
    if ('payload_int' in obj || 'label_int' in obj || 'agg' in obj || 'mul' in obj || 'div' in obj) {
      return resolveInt(expr as IntExpr, input, params)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = evalAnyExpr(v, input, params)
    }
    return out
  }
  return expr
}

export function getRequiredContractTermKeys(compiled: CompiledEventToRatingsDsl): string[] {
  return compiled.params.requiredTermKeys
}

type ParamResolutionAudit = Record<string, { source: 'term' | 'default'; term_key?: string }>

export class ContractParamResolutionError extends Error {
  readonly code: 'contract_term_missing' | 'contract_term_invalid'
  constructor(code: ContractParamResolutionError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function resolveEventToRatingsParams(
  compiled: CompiledEventToRatingsDsl,
  termValuesByKey: Record<string, unknown>,
): { params: ResolvedParams; audit: ParamResolutionAudit } {
  const resolved: ResolvedParams = {}
  const audit: ParamResolutionAudit = {}

  for (const [name, spec] of Object.entries(compiled.params.specs)) {
    const termKey = spec.sourceTermKey
    const hasTerm = Boolean(termKey && Object.prototype.hasOwnProperty.call(termValuesByKey, termKey))
    const rawValue = hasTerm && termKey ? termValuesByKey[termKey] : undefined

    const setAudit = (source: 'term' | 'default') => {
      audit[name] = source === 'term' && termKey ? { source, term_key: termKey } : { source }
    }

    if (spec.type === 'int') {
      const parsedFromTerm = hasTerm ? toNumberMaybe(rawValue) : null
      if (hasTerm && parsedFromTerm === null) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: term_key=${termKey} param=${name} expected=int`,
        )
      }
      const value = parsedFromTerm !== null ? Math.trunc(parsedFromTerm) : spec.default
      if (value === undefined) {
        throw new ContractParamResolutionError(
          'contract_term_missing',
          `contract_term_missing: term_key=${termKey ?? '-'} param=${name}`,
        )
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: param=${name} value < min (${value} < ${spec.min})`,
        )
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: param=${name} value > max (${value} > ${spec.max})`,
        )
      }
      resolved[name] = value
      setAudit(parsedFromTerm !== null ? 'term' : 'default')
      continue
    }

    if (spec.type === 'string') {
      const parsedFromTerm = hasTerm ? toStringMaybe(rawValue) : null
      if (hasTerm && parsedFromTerm === null) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: term_key=${termKey} param=${name} expected=string`,
        )
      }
      const value = parsedFromTerm !== null ? parsedFromTerm : spec.default
      if (value === undefined) {
        throw new ContractParamResolutionError(
          'contract_term_missing',
          `contract_term_missing: term_key=${termKey ?? '-'} param=${name}`,
        )
      }
      resolved[name] = value
      setAudit(parsedFromTerm !== null ? 'term' : 'default')
      continue
    }

    if (spec.type === 'bool') {
      const parsedFromTerm = hasTerm
        ? typeof rawValue === 'boolean'
          ? rawValue
          : null
        : null
      if (hasTerm && parsedFromTerm === null) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: term_key=${termKey} param=${name} expected=bool`,
        )
      }
      const value = parsedFromTerm !== null ? parsedFromTerm : spec.default
      if (value === undefined) {
        throw new ContractParamResolutionError(
          'contract_term_missing',
          `contract_term_missing: term_key=${termKey ?? '-'} param=${name}`,
        )
      }
      resolved[name] = value
      setAudit(parsedFromTerm !== null ? 'term' : 'default')
      continue
    }

    if (spec.type === 'string[]') {
      const parsedFromTerm = hasTerm
        ? Array.isArray(rawValue) && rawValue.every((v) => typeof v === 'string')
          ? (rawValue as string[])
          : null
        : null
      if (hasTerm && parsedFromTerm === null) {
        throw new ContractParamResolutionError(
          'contract_term_invalid',
          `contract_term_invalid: term_key=${termKey} param=${name} expected=string[]`,
        )
      }
      const value = parsedFromTerm !== null ? parsedFromTerm : spec.default
      if (value === undefined) {
        throw new ContractParamResolutionError(
          'contract_term_missing',
          `contract_term_missing: term_key=${termKey ?? '-'} param=${name}`,
        )
      }
      resolved[name] = value
      setAudit(parsedFromTerm !== null ? 'term' : 'default')
      continue
    }
  }

  return { params: resolved, audit }
}

export function evaluateEventToRatingsDsl(
  compiled: CompiledEventToRatingsDsl,
  input: EngineInput,
  resolvedParams: ResolvedParams,
): { intents: EngineIntent[] } | null {
  if (compiled.match.eventTypeExact !== input.event_type) return null
  if (compiled.match.where && !evalPredicate(compiled.match.where, input, resolvedParams)) return null

  const intents: EngineIntent[] = compiled.intents.map((intent) => {
    const budgetId = intent.budgetId ? resolveString(intent.budgetId, input, resolvedParams) ?? undefined : undefined
    const quantityMinorRaw = intent.quantityMinor ? resolveInt(intent.quantityMinor, input, resolvedParams) : null
    const quantityMinor = quantityMinorRaw === null ? undefined : Math.max(0, Math.trunc(quantityMinorRaw))
    const meters = intent.meters.map((m) => {
      const qty = resolveInt(m.quantityMinor, input, resolvedParams)
      if (qty === null) throw new Error('meter quantity expression resolved to null')
      return { meterCode: m.meterCode, quantityMinor: Math.max(0, Math.trunc(qty)) }
    })

    const labels = intent.labels
      ? Object.fromEntries(
          Object.entries(intent.labels).map(([k, v]) => [k, resolveString(v, input, resolvedParams) ?? '']),
        )
      : undefined

    const metadata = intent.metadata
      ? Object.fromEntries(
          Object.entries(intent.metadata).map(([k, v]) => [k, evalAnyExpr(v, input, resolvedParams)]),
        )
      : undefined

    return {
      linkKind: intent.linkKind,
      featureCode: intent.featureCode,
      budgetId,
      quantityMinor,
      meters,
      labels,
      metadata,
    }
  })

  return { intents }
}

export function normalizeEventToRatingsSlug(input: string): string | null {
  return normalizeSlug(input)
}
