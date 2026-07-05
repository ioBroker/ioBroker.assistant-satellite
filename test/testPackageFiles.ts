import path from 'node:path';
import { tests } from '@iobroker/testing';

// Validate the package files (package.json and io-package.json) using @iobroker/testing.
tests.packageFiles(path.join(__dirname, '..'));
