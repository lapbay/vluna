import { Body, Controller, Post } from '@nestjs/common'
import { okEnvelope } from '../../common/envelope.js'
import type { ConsentBody } from '../../types/http.js'

@Controller()
export class ConsentController {
  @Post('/consent')
  async postConsent(@Body() body: ConsentBody) {
    return okEnvelope({ saved: true, ...body })
  }
}

