// Preloaded by the rules and card tests (package.json, node --import): checked play shares its reads as a simulation
// does and compares every shared answer with a fresh one (public/rules/trust.js verifyReads), so each test also checks
// that no read changes the state it reads.
import { verifyReads } from '../public/rules/trust.js';

verifyReads(true);
