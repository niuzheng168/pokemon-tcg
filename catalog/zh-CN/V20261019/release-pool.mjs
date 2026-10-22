// Mixed-tier authoring pool. The reviewed authoring pool stays separate: image review, merged metadata and
// card-image copying must never treat machine printings as hand-reviewed records. Generated snapshots are committed,
// so v2 per-set release builds need neither the NAS nor paid model caches.
import * as reviewed from './index.mjs';
import definitions from './library/machine/definitions.json' with { type: 'json' };
import printings from './library/machine/printings.json' with { type: 'json' };
import presentation from './library/machine/presentation.json' with { type: 'json' };
import report from './library/machine/report.json' with { type: 'json' };

if (definitions.some((d) => d.implementation.tier !== 'machine') || printings.some((p) => p.identityReview !== 'machine')
  || report.definitions !== definitions.length || report.printings !== printings.length
  || Object.keys(presentation).length !== printings.length || printings.some((p) => !presentation[p.printingId]))
  throw new Error('The machine snapshot must preserve its tier, counts and per-printing presentation.');

export const DEFINITIONS = Object.freeze([...reviewed.DEFINITIONS, ...definitions]);
export const PRINTINGS = Object.freeze([...reviewed.PRINTINGS, ...printings]);
export const PRESENTATION = Object.freeze({ ...reviewed.PRESENTATION, ...presentation });
export const TEST_IDS = Object.freeze([...reviewed.TEST_IDS, 'tests/cn-cards/machine.test.mjs', 'tests/cn-cards/machine-reprint.test.mjs',
  'tests/cn-cards/machine-release.test.mjs', 'tests/cn-cards/machine-effects.test.mjs', 'tests/effect-certificates.test.mjs',
  'tests/reviewed-effect-certificates.test.mjs', 'tests/effect-mechanism-certificates.test.mjs', 'tests/machine-ancestry.test.mjs']);
export const REVIEWED_ON = report.reviewedOn;
export const MACHINE_REPORT = report;
