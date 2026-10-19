const translations = {
  'zh-CN': {
    title: '找不到页面 · 宝可梦卡牌学堂',
    heading: '这个页面躲进草丛里了。',
    message: '这个地址没有内容。可以回到首页，或直接开始练习。',
    play: '开始练习', home: '返回首页',
  },
  en: {
    title: 'Page not found · Pokémon TCG Academy',
    heading: 'This page wandered into the tall grass.',
    message: 'There is nothing at this address. Go home or start practicing.',
    play: 'Play in your browser', home: 'Go to the home page',
  },
};
let lang = 'zh-CN';
try {
  const saved = localStorage.getItem('lang');
  if (saved && !/^zh(?:-|_|$)/i.test(saved)) lang = 'en';
} catch { /* storage unavailable */ }
function apply() {
  document.documentElement.lang = lang;
  document.title = translations[lang].title;
  document.querySelectorAll('[data-text]').forEach((el) => { el.textContent = translations[lang][el.dataset.text]; });
  document.querySelectorAll('[data-lang]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.lang === lang)));
}
document.querySelectorAll('[data-lang]').forEach((el) => el.addEventListener('click', () => {
  lang = el.dataset.lang;
  try { localStorage.setItem('lang', lang); } catch { /* storage unavailable */ }
  apply();
}));
apply();
