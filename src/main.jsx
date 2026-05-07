import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/source-sans-3';
import ThemeProvider from './theme/ThemeProvider';
import MainApp from './App';
import { MenuPopupProvider } from './components/keyboard/MenuPopup';
import { DatePopupProvider } from './components/keyboard/DatePopup';
import './styles/global.css';

// MenuPopup + DatePopup providers wrap App (not nested INSIDE) so
// useMenuPopup() / useDatePopup() called from inside App's body —
// notably from useGlobalShortcuts — find the context. Putting them
// inside App's JSX makes them mount AFTER App's hooks run, leaving
// useContext returning null on the first render.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <MenuPopupProvider>
          <DatePopupProvider>
            <MainApp />
          </DatePopupProvider>
        </MenuPopupProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
