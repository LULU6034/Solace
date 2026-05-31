import { glassesDog, drawGlassesDog } from './glassesDog.js'

export const petList = [
  { id: 'glassesDog', ...glassesDog, drawFn: drawGlassesDog },
]

export function getPet(id) {
  return petList.find(p => p.id === id) || petList[0]
}
