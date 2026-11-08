import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/fonts.css';
import '@astryxdesign/theme-neutral/theme.css';
import './styles.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
);
