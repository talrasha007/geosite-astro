import { onMounted, ref } from 'vue';

export type Theme = 'light' | 'dark';
export type Locale = 'zh' | 'en';

const THEME_KEY = 'geodata-theme';
const LOCALE_KEY = 'geodata-locale';

// Defaults are SSR-safe placeholders (this component is prerendered before it
// hydrates, and window/localStorage/navigator don't exist during that pass).
// The real system-derived value is applied in onMounted, which only runs
// client-side.
export function useTheme() {
  const theme = ref<Theme>('light');

  function apply(value: Theme) {
    theme.value = value;
    document.documentElement.dataset.theme = value;
  }

  onMounted(() => {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') {
      apply(stored);
    } else {
      apply(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    }
  });

  function toggleTheme() {
    const next: Theme = theme.value === 'light' ? 'dark' : 'light';
    apply(next);
    localStorage.setItem(THEME_KEY, next);
  }

  return { theme, toggleTheme };
}

export function useLocale() {
  const locale = ref<Locale>('en');

  onMounted(() => {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'zh' || stored === 'en') {
      locale.value = stored;
    } else {
      locale.value = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }
  });

  function toggleLocale() {
    locale.value = locale.value === 'zh' ? 'en' : 'zh';
    localStorage.setItem(LOCALE_KEY, locale.value);
  }

  return { locale, toggleLocale };
}
