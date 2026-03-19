import type {
  AdminPlaneService,
  RealmSlotAuthorizeInput,
  RealmSlotAuthorizeResult,
  RealmSlotCancelInput,
  RealmSlotCommitInput,
  RealmSlotRevokeInput,
} from './admin-plane.service.js'

export class NoopAdminPlaneService implements AdminPlaneService {
  async authorizeRealmSlot(_input: RealmSlotAuthorizeInput): Promise<RealmSlotAuthorizeResult> {
    return {
      leaseToken: 'noop_lease',
    }
  }

  async commitRealmSlot(_input: RealmSlotCommitInput): Promise<void> {}

  async cancelRealmSlot(_input: RealmSlotCancelInput): Promise<void> {}

  async revokeRealmSlot(_input: RealmSlotRevokeInput): Promise<void> {}
}
