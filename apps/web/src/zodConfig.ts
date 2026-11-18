import { z } from 'zod';

// Zod compiles validators with new Function() unless told not to, which the Content-Security-Policy
// (no unsafe-eval) forbids. The forms validate a handful of fields, so nothing is lost.
// This module must be the FIRST import of the entry point: the shared schemas are built when they
// are imported, and read this setting at that moment.
z.config({ jitless: true });
