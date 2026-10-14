import path from 'node:path';
import { tests } from '@iobroker/testing';

// Starts the adapter in a temporary js-controller and checks that it runs and does not crash.
// Like testPackageFiles.ts this is loaded by mocha via Node's native TypeScript type-stripping.
tests.integration(path.join(import.meta.dirname, '..'));
