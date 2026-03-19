import { Body, Controller, Get, Post, Req, UseGuards, UseInterceptors, Inject } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { okEnvelope } from '../../../common/envelope.js'
import { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import type { operations as GateOperations } from '../../../contracts/gate.js'
import type { AppRequest } from '../../../types/app-request.js'
import { SeatService } from '../services/seat.service.js'

@Controller('seats')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard)
export class SeatsController {
  constructor(@Inject(SeatService) private readonly seatService: SeatService) {}

  @Get()
  async list(@Req() req: AppRequest): Promise<SeatsList200> {
    const query = req.query as Record<string, unknown> | undefined
    const seats = await this.seatService.listActiveSeats(req, query?.feature_code)
    return okEnvelope({ seats }) as SeatsList200
  }

  @Post('revoke')
  @UseInterceptors(IdempotencyInterceptor)
  async revoke(@Req() req: AppRequest, @Body() body: SeatActionBody): Promise<SeatAction200> {
    const seat = await this.seatService.revokeSeat(req, body?.feature_code, body?.seat_id)
    return okEnvelope(seat) as SeatAction200
  }

  @Post('restore')
  @UseInterceptors(IdempotencyInterceptor)
  async restore(@Req() req: AppRequest, @Body() body: SeatActionBody): Promise<SeatAction200> {
    const seat = await this.seatService.restoreSeat(req, body?.feature_code, body?.seat_id)
    return okEnvelope(seat) as SeatAction200
  }
}

type SeatActionBody = JsonRequestBody<GateOperations, 'revokeSeat'>
type SeatAction200 = JsonResponse<GateOperations, 'revokeSeat', 200>
type SeatsList200 = JsonResponse<GateOperations, 'listSeats', 200>
