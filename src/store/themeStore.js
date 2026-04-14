import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const defaultTheme = {
  colorPrimary: '#4F46E5',
  colorSuccess: '#10B981',
  colorWarning: '#F59E0B',
  colorError: '#EF4444',
  borderRadius: 10,
  fontSize: 14,
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sidebarStyle: 'dark',
  compactMode: false,
  colorBgLayout: '#F0F2F5',
};

const useThemeStore = create(
  persist(
    (set, get) => ({
      ...defaultTheme,
      updateTheme: (partial) => set(partial),
      resetTheme: () => set(defaultTheme),
      getAntdTheme: () => {
        const s = get();
        return {
          token: {
            colorPrimary: s.colorPrimary,
            colorSuccess: s.colorSuccess,
            colorWarning: s.colorWarning,
            colorError: s.colorError,
            borderRadius: s.borderRadius,
            fontSize: s.fontSize,
            fontFamily: s.fontFamily,
            colorBgLayout: s.colorBgLayout,
            colorBgContainer: '#ffffff',
            motion: true,
          },
          components: {
            Button: {
              borderRadius: s.borderRadius,
              controlHeight: s.compactMode ? 32 : 36,
              fontWeight: 500,
            },
            Card: {
              borderRadiusLG: s.borderRadius + 2,
              boxShadowTertiary: '0 1px 2px 0 rgba(0,0,0,0.03), 0 1px 6px -1px rgba(0,0,0,0.02), 0 2px 4px 0 rgba(0,0,0,0.02)',
            },
            Table: {
              borderRadius: s.borderRadius,
              headerBg: `${s.colorPrimary}08`,
              headerColor: '#1f2937',
              rowHoverBg: `${s.colorPrimary}06`,
              headerSortActiveBg: `${s.colorPrimary}12`,
            },
            Input: {
              controlHeight: s.compactMode ? 32 : 38,
              borderRadius: s.borderRadius,
            },
            Select: {
              controlHeight: s.compactMode ? 32 : 38,
              borderRadius: s.borderRadius,
            },
            InputNumber: {
              controlHeight: s.compactMode ? 32 : 38,
              borderRadius: s.borderRadius,
            },
            DatePicker: {
              controlHeight: s.compactMode ? 32 : 38,
              borderRadius: s.borderRadius,
            },
            Menu: {
              itemBorderRadius: 8,
              itemMarginInline: 8,
              subMenuItemBorderRadius: 6,
            },
            Modal: {
              borderRadiusLG: s.borderRadius + 4,
            },
            Statistic: {
              titleFontSize: 13,
              contentFontSize: 24,
            },
          },
        };
      },
    }),
    { name: 'erp-theme' }
  )
);

export default useThemeStore;
