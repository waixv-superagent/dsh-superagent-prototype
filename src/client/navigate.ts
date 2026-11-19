/** Lets a control mounted outside the panel (the frame-wide bottom strip) move the panel that is mounted. */
import type { Route } from './route.ts'

let navigator: ((route: Route) => void) | undefined

/** The mounted panel registers its own navigate for as long as it is mounted; a replacement page takes the slot over. */
export function setPanelNavigator(navigate?: (route: Route) => void): void {
  navigator = navigate
}

/** Moves the mounted panel to `route`; false when the panel is not mounted and its own page must be opened instead. */
export function goInPanel(route: Route): boolean {
  if (navigator === undefined) return false
  navigator(route)
  return true
}
