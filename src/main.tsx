import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { migrateLegacyStorageKeys } from './storage.ts';
import './styles.css';

// Move any state still parked under a pre-`chronicle.<name>` key onto its dot
// key (issue #202). Runs before the first render, so every component's
// mount-time read already sees the migrated value.
migrateLegacyStorageKeys();

// Non-null assertion: matches the original's assumption that #root always
// exists in index.html.
createRoot(document.getElementById('root')!).render(<App />);
