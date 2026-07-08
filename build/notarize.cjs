// electron-builder afterSign hook. Notarizes the signed .app ONLY when Apple
// credentials are present in the environment; otherwise it no-ops so unsigned
// builds keep working until enrollment completes. Prefers an App Store Connect
// API key (APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER); falls back to
// Apple ID + app-specific password (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID).
const { notarize } = require('@electron/notarize');

exports.default = async function notarizeHook(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const {
    APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER,
    APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID,
  } = process.env;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    console.log(`  • notarizing ${appName}.app via App Store Connect API key`);
    return notarize({ appPath, appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER });
  }
  if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
    console.log(`  • notarizing ${appName}.app via Apple ID`);
    return notarize({ appPath, appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID });
  }
  console.log('  • notarization skipped — no APPLE_* credentials in env (unsigned build)');
};
