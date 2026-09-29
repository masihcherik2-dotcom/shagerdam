import localFont from 'next/font/local';

/**
 * Vazirmatn (OFL-1.1, npm package `vazirmatn`), self-hosted through
 * next/font: the variable font file is bundled at build time, so no request
 * leaves for a third-party font CDN. Falls back to the system stack in
 * globals.css while loading.
 */
export const vazirmatn = localFont({
  src: '../../node_modules/vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-vazirmatn',
  preload: true,
});
