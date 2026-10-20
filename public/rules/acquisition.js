import { validateAcquisitionDescriptor, validateEntryContext } from './schema-validators.js';

export const ACQUISITION_RULE_IDS = Object.freeze(['trigger.before-hand']);

export function acquisitionMatches(descriptor, entry) {
  if (!validateAcquisitionDescriptor(descriptor) || !validateEntryContext(entry))
    throw new TypeError('Invalid before-hand acquisition descriptor/context.');
  return descriptor.origin === entry.origin &&
    (descriptor.turn === 'either' || entry.during === entry.player) &&
    (descriptor.drawReason === 'any' || descriptor.drawReason === entry.reason);
}
