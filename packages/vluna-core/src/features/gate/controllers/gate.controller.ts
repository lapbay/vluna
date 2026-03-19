import { Body, Controller, Get, Post, Req, UseGuards, UseInterceptors, Inject } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { okEnvelope } from '../../../common/envelope.js'
import { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import type { operations as GateOperations } from '../../../contracts/gate.js'
import type { AppRequest } from '../../../types/app-request.js'
import { GateService } from '../services/gate.service.js'
import type { GateHint } from '../services/gate.hints.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'

@Controller('gate')
// @UseGuards(RealmGuard, TokenClaimsGuard, PrincipalGuard, PrincipalBillingAccountGuard)
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard)
export class GateController {
  constructor(@Inject(GateService) private readonly gateService: GateService) {}

  @Post('authorize')
  @UseInterceptors(IdempotencyInterceptor)
  async authorize(@Req() req: AppRequest, @Body() body: AuthorizeBody): Promise<Authorize200> {
    const { data, hints } = await this.gateService.authorize(req, body)
    const opts: { meta?: Record<string, unknown>; hints?: GateHint[] } = {}
    if (hints && hints.length > 0) opts.hints = hints
    return okEnvelope(data, Object.keys(opts).length ? opts : undefined) as Authorize200
  }

  @Post('commits')
  @UseInterceptors(IdempotencyInterceptor)
  async commit(@Req() req: AppRequest, @Body() body: CommitBody): Promise<Commit200> {
    const { data, hints } = await this.gateService.commit(req, body)
    const opts: { hints?: GateHint[] } = {}
    if (hints && hints.length > 0) opts.hints = hints
    return okEnvelope(data, Object.keys(opts).length ? opts : undefined) as Commit200
  }

  @Post('ingest')
  @UseInterceptors(IdempotencyInterceptor)
  async ingest(@Req() req: AppRequest, @Body() body: IngestBody): Promise<Ingest200> {
    const { data, hints } = await this.gateService.ingest(req, body)
    const opts: { hints?: GateHint[] } = {}
    if (hints && hints.length > 0) opts.hints = hints
    return okEnvelope(data, Object.keys(opts).length ? opts : undefined) as Ingest200
  }

  @Post('commits/batch')
  @UseInterceptors(IdempotencyInterceptor)
  async batchCommit(@Req() req: AppRequest, @Body() body: BatchCommitBody): Promise<BatchCommit200> {
    const result = await this.gateService.batchCommit(req, body)
    return okEnvelope(result) as BatchCommit200
  }

  @Post('cancel')
  @UseInterceptors(IdempotencyInterceptor)
  async cancel(@Req() req: AppRequest, @Body() body: CancelBody): Promise<Cancel200> {
    const result = await this.gateService.cancel(req, body)
    return okEnvelope(result) as Cancel200
  }

  @Get('limits')
  async listFeatureLimits(@Req() req: AppRequest): Promise<FeatureLimits200> {
    const result = await this.gateService.listFeatureLimits(req)
    return okEnvelope(result) as FeatureLimits200
  }

  @Get('meters')
  async listMeters(@Req() req: AppRequest): Promise<MeterLimits200> {
    const result = await this.gateService.listMeters(req)
    return okEnvelope(result)
  }
}

type AuthorizeBody = JsonRequestBody<GateOperations, 'authorize'>
type Authorize200 = JsonResponse<GateOperations, 'authorize', 200>
type CommitBody = JsonRequestBody<GateOperations, 'commit'>
type Commit200 = JsonResponse<GateOperations, 'commit', 200>
type IngestBody = JsonRequestBody<GateOperations, 'ingest'>
type Ingest200 = JsonResponse<GateOperations, 'ingest', 200>
type BatchCommitBody = JsonRequestBody<GateOperations, 'commitBatch'>
type BatchCommit200 = JsonResponse<GateOperations, 'commitBatch', 200>
type CancelBody = JsonRequestBody<GateOperations, 'cancel'>
type Cancel200 = JsonResponse<GateOperations, 'cancel', 200>
type FeatureLimits200 = JsonResponse<GateOperations, 'listFeatureLimits', 200>
type MeterLimits200 = JsonResponse<GateOperations, 'listMeterLimits', 200>
