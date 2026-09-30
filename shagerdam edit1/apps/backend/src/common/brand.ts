/**
 * Platform display identity (TM decision: «شاگردم»).
 *
 * These are the *display* names used in user-facing text the backend produces:
 * SMS bodies, payment-gateway descriptions, the sandbox bank page and the API
 * docs title. Technical identifiers (package scope `@shopino/*`, container and
 * database names, cookie names, seeded slugs and e-mail domains) are deliberately
 * unchanged: renaming them would break deployments, backups and live sessions
 * without any user-visible benefit.
 *
 * `platform.name` in `system_configs` carries the same value for operators.
 */
export const PLATFORM_DISPLAY_NAME = 'شاگردم';
export const PLATFORM_DISPLAY_NAME_EN = 'Shagerdam';
export const PLATFORM_TAGLINE = 'پلتفرم هوشمند خرید و فروش اقساطی';
