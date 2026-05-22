import { clawd, drawClawd } from './clawd.js'
import { glassesDog, drawGlassesDog } from './glassesDog.js'
import { blackCat, drawBlackCat } from './blackCat.js'
import { yellowBird, drawYellowBird } from './yellowBird.js'
import { fox, drawFox } from './fox.js'

export const petList = [
  { id: 'glassesDog', ...glassesDog, drawFn: drawGlassesDog },
  { id: 'clawd', ...clawd, drawFn: drawClawd },
  { id: 'blackCat', ...blackCat, drawFn: drawBlackCat },
  { id: 'yellowBird', ...yellowBird, drawFn: drawYellowBird },
  { id: 'fox', ...fox, drawFn: drawFox },
]

export function getPet(id) {
  return petList.find(p => p.id === id) || petList[0]
}
