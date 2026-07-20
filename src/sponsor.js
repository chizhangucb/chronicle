// Sponsorship links — the single source of truth for the in-app Support modal.
// Chronicle takes no payments itself; every entry is a hosted provider page opened
// in the user's browser (see src/shell.js). Keep these URLs in sync with the
// matching links in website/index.html and .github/FUNDING.yml.
//
// Coverage (see docs / PRD):
//   lemonSqueezy — cards + PayPal (Venmo for US buyers) + Alipay/WeChat one-time;
//                  monthly is cards only (Alipay/WeChat recurring is not supported).
//   afdian       — 支付宝 / 微信, both one-time (投喂) and monthly (包月).
//   github       — cards, one-time + monthly (tier chosen on GitHub).
//
// TODO(accounts): replace the placeholders once the Lemon Squeezy store and Afdian
// page exist. The GitHub Sponsors URL is live once enrollment completes.
export const SPONSOR = {
  lemonSqueezy: {
    oneTime: 'https://chronicle.lemonsqueezy.com/buy/one-time',
    monthly: 'https://chronicle.lemonsqueezy.com/buy/monthly',
  },
  afdian: {
    oneTime: 'https://afdian.com/a/chronicle',
    monthly: 'https://afdian.com/a/chronicle/plan',
  },
  github: 'https://github.com/sponsors/chizhangucb',
};
