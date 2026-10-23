/**
 * withMusterdKeys — the config plugin for `modules/musterd-keys`.
 *
 * Prebuild-time it makes the app buildable and usable with the phone keys (ADR 676 §2, spec §4/§9):
 *
 *  - `NSFaceIDUsageDescription` — without it iOS silently fails every Face ID prompt, so the
 *    signing key would never authorize (and expo-secure-store throws for the same reason).
 *  - `com.apple.developer.devicecheck.appattest-environment` — the App Attest entitlement, in
 *    `production` (TestFlight is the only distribution, ADR 676 decision 11).
 *  - `keychain-access-groups` scoped to `$(AppIdentifierPrefix)<bundle id>` — the module stores
 *    its two key references in the keychain; an explicit app-scoped group keeps them out of any
 *    team-wide default and gives the notification extension one group to share later.
 *  - A deployment-target floor of iOS 17: CryptoKit HPKE is iOS 17+, and the module's podspec
 *    declares the same floor. This guard makes `expo prebuild` fail loudly rather than let the
 *    two drift into a build error deep inside CocoaPods.
 *
 * No runtime dependency is added: `expo/config-plugins` is `@expo/config-plugins`, already a
 * dependency of `expo` itself, re-exported for plugins exactly like this one.
 */
'use strict';

const { createRunOncePlugin, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const pkg = require('../package.json');

const FACE_ID_USAGE =
  'musterd uses Face ID to approve asks and answers with the key stored in the Secure Enclave.';
const APP_ATTEST_ENVIRONMENT = 'production';
const MIN_IOS_VERSION = '17.0';

/** Compare dotted numeric versions; enough for deployment targets like "17.0". */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function withMusterdKeysIos(config) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) {
    throw new Error(
      'withMusterdKeys: ios.bundleIdentifier must be set in app.json — the keychain access group is scoped to it.',
    );
  }
  const deploymentTarget = config.ios?.deploymentTarget;
  if (deploymentTarget && compareVersions(deploymentTarget, MIN_IOS_VERSION) < 0) {
    throw new Error(
      `withMusterdKeys: ios.deploymentTarget is ${deploymentTarget}, but the keys module needs iOS ${MIN_IOS_VERSION}+ (CryptoKit HPKE). Raise it in app.json.`,
    );
  }

  config = withInfoPlist(config, (inner) => {
    inner.modResults.NSFaceIDUsageDescription ??= FACE_ID_USAGE;
    return inner;
  });

  config = withEntitlementsPlist(config, (inner) => {
    inner.modResults['com.apple.developer.devicecheck.appattest-environment'] =
      APP_ATTEST_ENVIRONMENT;
    const group = `$(AppIdentifierPrefix)${bundleId}`;
    const groups = inner.modResults['keychain-access-groups'] ?? [];
    if (!groups.includes(group)) groups.push(group);
    inner.modResults['keychain-access-groups'] = groups;
    return inner;
  });

  return config;
}

module.exports = createRunOncePlugin(withMusterdKeysIos, pkg.name, pkg.version);
