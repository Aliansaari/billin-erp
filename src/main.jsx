import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import ThemeProvider from './theme/ThemeProvider';
import MainApp from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <MainApp />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
