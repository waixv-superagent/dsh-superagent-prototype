/** The deployment's model catalog as the host compares it with the routes a person's own message names. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RoutedModel } from '../core/index.ts'

/** Every route the deployment serves, with the display name the catalog gives it. */
export function routableModels(catalog: ModelCatalog): RoutedModel[] {
  return catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, name: model.name })))
}
