(() => {
  const root = document.documentElement;
  const languageButton = document.getElementById('language-switch');
  const themeButton = document.getElementById('theme-switch');
  const supported = ['zh', 'en'];
  let language = 'zh';
  let theme = 'light';
  try {
    const savedLanguage = localStorage.getItem('devspace-site-language');
    if (supported.includes(savedLanguage)) language = savedLanguage;
    const savedTheme = localStorage.getItem('devspace-site-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') theme = savedTheme;
  } catch {}

  function applyLanguage() {
    root.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-zh][data-en]').forEach((element) => {
      element.textContent = element.dataset[language];
    });
    if (languageButton) {
      languageButton.textContent = language === 'zh' ? 'EN' : '中文';
      languageButton.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换到中文');
    }
    document.title = language === 'zh' ? 'DevSpace-Forge — 在同一条对话里，完成本地开发' : 'DevSpace-Forge — Stay in chat. Build on your machine.';
  }
  function applyTheme() {
    root.dataset.theme = theme;
    if (themeButton) themeButton.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = theme === 'dark' ? '#101216' : '#f5f6f8';
  }
  if (languageButton) languageButton.addEventListener('click', () => {
    language = language === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('devspace-site-language', language); } catch {}
    applyLanguage();
  });
  if (themeButton) themeButton.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('devspace-site-theme', theme); } catch {}
    applyTheme();
  });
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
  applyLanguage();
  applyTheme();
})();
