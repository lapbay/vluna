import { Module } from '@nestjs/common'
import { ConsentController } from './consent.controller.js'

@Module({
  controllers: [ConsentController],
})
export class ScatteredApiModule {}
