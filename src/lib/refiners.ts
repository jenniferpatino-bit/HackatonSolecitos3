import type { Refiner } from './types'

/** Última versión conocida de cada expediente, llegue por HTTP o por el stream. */
const latest = new Map<number, Refiner>()

/** Devuelve la versión más nueva entre la recibida y la conocida: una vieja nunca pisa a una nueva. */
export function reconcile(refiner: Refiner): Refiner {
  const known = latest.get(refiner.id)
  if (known && known.version > refiner.version) return known
  latest.set(refiner.id, refiner)
  return refiner
}

export const etagOf = (version: number): string => `"${version}"`
