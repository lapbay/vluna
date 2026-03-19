import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { RequireServiceAuthGuard } from '../../../auth/guards/require-service-auth.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing-mgt.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { okEnvelope } from '../../../common/envelope.js'
import { FeaturesManagementService } from '../services/features-management.service.js'

// OpenAPI mapping: tag=Features
// Paths:
// - GET  /features (operationId: listFeatures)
// - GET  /features/needs-config (operationId: listFeaturesNeedsConfig)
// - POST /features (operationId: upsertFeature)
// - GET  /features/{feature_id} (operationId: getFeature)
// - PATCH /features/{feature_id} (operationId: updateFeature)

type ListFeaturesQuery = QueryParams<BillingOps, 'listFeatures'>
type ListFeatures200 = JsonResponse<BillingOps, 'listFeatures', 200>
type ListFeaturesNeedsConfigQuery = QueryParams<BillingOps, 'listFeaturesNeedsConfig'>
type ListFeaturesNeedsConfig200 = JsonResponse<BillingOps, 'listFeaturesNeedsConfig', 200>
type UpsertFeatureBody = JsonRequestBody<BillingOps, 'upsertFeature'>
type UpsertFeature201 = JsonResponse<BillingOps, 'upsertFeature', 201>
type UpsertFeature200 = JsonResponse<BillingOps, 'upsertFeature', 200>
type GetFeature200 = JsonResponse<BillingOps, 'getFeature', 200>
type UpdateFeatureBody = JsonRequestBody<BillingOps, 'updateFeature'>
type UpdateFeature200 = JsonResponse<BillingOps, 'updateFeature', 200>
type DeleteFeature200 = JsonResponse<BillingOps, 'deleteFeature', 200>

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, RequireServiceAuthGuard)
export class FeaturesController {
  constructor(@Inject(FeaturesManagementService) private readonly featuresService: FeaturesManagementService) {}

  @Get('features')
  async listFeatures(@Req() req: AppRequest, @Query() query: ListFeaturesQuery): Promise<ListFeatures200> {
    const data = await this.featuresService.listFeatures(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListFeatures200
  }

  @Get('features/needs-config')
  async listFeaturesNeedsConfig(
    @Req() req: AppRequest,
    @Query() query: ListFeaturesNeedsConfigQuery,
  ): Promise<ListFeaturesNeedsConfig200> {
    const data = await this.featuresService.listNeedsConfigFeatures(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListFeaturesNeedsConfig200
  }

  @Post('features')
  @UseInterceptors(IdempotencyInterceptor)
  async upsertFeature(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertFeatureBody,
  ): Promise<UpsertFeature201 | UpsertFeature200> {
    const { created, feature } = await this.featuresService.upsertFeature(req, body as Parameters<FeaturesManagementService['upsertFeature']>[1])
    const payload = okEnvelope(feature) as UpsertFeature201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('features/:feature_id')
  async getFeature(@Req() req: AppRequest, @Param('feature_id') featureId: string): Promise<GetFeature200> {
    const data = await this.featuresService.getFeature(req, featureId)
    return okEnvelope(data) as GetFeature200
  }

  @Patch('features/:feature_id')
  @UseInterceptors(IdempotencyInterceptor)
  async updateFeature(
    @Req() req: AppRequest,
    @Param('feature_id') featureId: string,
    @Body() body: UpdateFeatureBody,
  ): Promise<UpdateFeature200> {
    const data = await this.featuresService.updateFeature(req, featureId, body ?? {})
    return okEnvelope(data) as UpdateFeature200
  }

  @Delete('features/:feature_id')
  async deleteFeature(
    @Req() req: AppRequest,
    @Param('feature_id') featureId: string,
  ): Promise<DeleteFeature200> {
    const data = await this.featuresService.deleteFeature(req, featureId)
    return okEnvelope(data) as DeleteFeature200
  }
}
