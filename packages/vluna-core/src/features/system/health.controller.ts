import { Controller, Get } from '@nestjs/common'
import { okEnvelope } from '../../common/envelope.js'

@Controller()
export class HealthController {
  @Get('/health')
  health() {
    return okEnvelope({ service: 'vluna', status: 'healthy' })
  }
}

