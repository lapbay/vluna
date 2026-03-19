import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common'
import { ADMIN_PLANE_SERVICE } from '../services/admin-plane/admin-plane.service.js'
import { NoopAdminPlaneService } from '../services/admin-plane/noop-admin-plane.service.js'

@Global()
@Module({})
export class AdminPlaneModule {
  static forRoot(provider?: Provider): DynamicModule {
    return {
      module: AdminPlaneModule,
      providers: [
        provider ?? {
          provide: ADMIN_PLANE_SERVICE,
          useFactory: () => new NoopAdminPlaneService(),
        },
      ],
      exports: [ADMIN_PLANE_SERVICE],
      global: true,
    }
  }
}
