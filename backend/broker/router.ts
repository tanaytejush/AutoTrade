import { indiaBroker } from "./india.js";
import type { Broker } from "./types.js";

export function getBroker(): Broker {
  return indiaBroker;
}
