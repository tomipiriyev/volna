import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useProject, useUi } from './model/store';
import { enableIsolation } from './platform/coi';
import './styles.css';

// Store handles for debugging and end-to-end tests (development builds only).
if (import.meta.env.DEV) Object.assign(window, { __stores: { useProject, useUi } });

const start = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

if (import.meta.env.MODE === 'pages') void enableIsolation().then((reloading) => reloading || start());
else start();
