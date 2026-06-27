import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store/useStore';

// Dev-only handle so the store can be driven/inspected (tests, headless checks).
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __waypoint: unknown }).__waypoint = useStore;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
