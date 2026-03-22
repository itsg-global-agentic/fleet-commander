// =============================================================================
// Fleet Commander -- Client Test Setup
//
// This setup file runs inside each vitest worker fork. It ensures proper cleanup
// after every test to keep the jsdom environment tidy.
// =============================================================================

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Ensure React Testing Library cleans up rendered components after every test.
// With globals: true this should be automatic, but we make it explicit to be safe.
afterEach(() => {
  cleanup();
});
