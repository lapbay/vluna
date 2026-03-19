// Helpers to extract request/response/params types from openapi-typescript output
// Use with generated `operations` types from a spec.

export type JsonResponse<Ops, OpId extends keyof Ops, Status extends number = 200> =
  Ops[OpId] extends { responses: Record<Status, infer R> }
    ? R extends { content: { 'application/json': infer Body } }
      ? Body
      : never
    : never

export type JsonRequestBody<Ops, OpId extends keyof Ops> =
  Ops[OpId] extends { requestBody: { content: { 'application/json': infer Body } } }
    ? Body
    : never

export type PathParams<Ops, OpId extends keyof Ops> =
  Ops[OpId] extends { parameters: { path: infer P } }
    ? P
    : Ops[OpId] extends { parameters: { path?: infer P } }
      ? P
      : never

export type QueryParams<Ops, OpId extends keyof Ops> =
  Ops[OpId] extends { parameters: { query: infer Q } }
    ? Q
    : Ops[OpId] extends { parameters: { query?: infer Q } }
      ? Q
      : never

export type HeaderParams<Ops, OpId extends keyof Ops> =
  Ops[OpId] extends { parameters: { header: infer H } }
    ? H
    : Ops[OpId] extends { parameters: { header?: infer H } }
      ? H
      : never

/**
 * Example:
 * import type { operations as BillingOps } from './billing.js'
 * type ListCatalogQuery = QueryParams<BillingOps, 'listCatalogProducts'>
 * type ListCatalogResp  = JsonResponse<BillingOps, 'listCatalogProducts'>
 */
