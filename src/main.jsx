import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import useThemeStore from './store/themeStore';
import MainApp from './App';
import './styles/global.css';

function ThemeWrapper() {
  const getAntdTheme = useThemeStore((s) => s.getAntdTheme);
  const theme = getAntdTheme();

  return (
    <ConfigProvider theme={theme}>
      <AntApp>
        <MainApp />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeWrapper />
    </BrowserRouter>
  </React.StrictMode>
);
