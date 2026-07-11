import path from 'node:path';
import { tests } from '@iobroker/testing';

// Validate the package files (package.json and io-package.json) using @iobroker/testing.
// This file is loaded by mocha via Node's native TypeScript type-stripping. The `import`
// statements make Node treat it as an ES module, where `__dirname` is not defined — so we
// use `import.meta.dirname` (available since Node 20.11; the adapter requires Node >= 22).
tests.packageFiles(path.join(import.meta.dirname, '..'));
