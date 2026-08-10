import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

// Non-null assertion: matches the original's assumption that #root always
// exists in index.html.
createRoot(document.getElementById('root')!).render(<App />);
