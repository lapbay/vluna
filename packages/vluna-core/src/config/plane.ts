const DEFAULT_PLANE = 'vluna'
const PLANE_IDENTIFIER = /^[a-z][a-z0-9_\-]*$/

export function resolvePlane(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.VLUNA_PLANE ?? DEFAULT_PLANE).trim().toLowerCase()
  if (!raw) {
    throw new Error('[plane] invalid VLUNA_PLANE: empty value is not allowed')
  }
  if (!PLANE_IDENTIFIER.test(raw)) {
    throw new Error(`[plane] invalid VLUNA_PLANE: ${raw}`)
  }
  return raw
}

export const PLANE = resolvePlane()

export function isAdminPlaneValue(plane: string): boolean {
  return plane === 'admin'
}

export function isRuntimePlaneValue(plane: string): boolean {
  return !isAdminPlaneValue(plane)
}

export const IS_ADMIN_PLANE = isAdminPlaneValue(PLANE)
export const IS_RUNTIME_PLANE = isRuntimePlaneValue(PLANE)

export function getPlaneTags(): { plane: string; is_admin_plane: boolean } {
  return {
    plane: PLANE,
    is_admin_plane: IS_ADMIN_PLANE,
  }
}
