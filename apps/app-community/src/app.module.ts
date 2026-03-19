import { createAppModule } from '@vluna/vluna-core/platform/app-module.builder'
import { getEditionProfile } from '@vluna/vluna-platform'

const profile = getEditionProfile('community')

export const AppModule = createAppModule({
  providers: [
    {
      provide: 'VLUNA_EDITION_PROFILE',
      useValue: profile,
    },
  ],
})
