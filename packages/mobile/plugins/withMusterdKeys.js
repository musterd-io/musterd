/**
 * withMusterdKeys — the config plugin for `modules/musterd-keys`.
 *
 * Prebuild-time it makes the app buildable with the phone keys and the notification service
 * extension (ADR 676 §2, §7, §8, spec §4/§9):
 *
 *  - `NSFaceIDUsageDescription` — without it iOS silently fails every Face ID prompt.
 *  - `com.apple.developer.devicecheck.appattest-environment` = production (TestFlight only).
 *  - `aps-environment` = production, and the time-sensitive entitlement, on the app. A debug
 *    device build will not receive a token; that is accepted under the no-local-Xcode rule.
 *  - `keychain-access-groups` with `$(AppIdentifierPrefix)<bundle id>` FIRST, on the app and
 *    on the extension. Items written without an access-group attribute land in that first
 *    group, which is how the extension sees the enclave key references and the seen-nonce
 *    store. SecItem does not expand the `$(AppIdentifierPrefix)` literal, so the module
 *    never sets the attribute itself.
 *  - A deployment-target floor of iOS 17.
 *  - The `MusterdNotify` extension target (`io.musterd.app.notify`). Its sources stay in
 *    `modules/musterd-keys/ios/` and are referenced from the generated project, so nothing
 *    native is copied and nothing under `ios/` is committed. `addTarget` does not add a
 *    Sources phase and quotes the Info.plist path with the path.join quirk; both are handled
 *    here. The target is skipped when it already exists, so a second prebuild does not
 *    duplicate it. Its Info.plist is hand-written (GENERATE_INFOPLIST_FILE is NO), so it
 *    must carry the standard `CFBundle*` keys itself — without `CFBundleIdentifier`
 *    expanding `$(PRODUCT_BUNDLE_IDENTIFIER)` the archive fails validation with an
 *    embedded-binary bundle identifier of `(null)` (EAS build bf82d194, 2026-10-28).
 *
 * No runtime dependency is added. Token registration is UserNotifications inside the existing
 * module, and the seen-nonce store is a keychain item, not expo-sqlite.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require(
  'expo/config-plugins',
);

const pkg = require('../package.json');

const FACE_ID_USAGE =
  'musterd uses Face ID to approve asks and answers with the key stored in the Secure Enclave.';
const APP_ATTEST_ENVIRONMENT = 'production';
const MIN_IOS_VERSION = '17.0';
const EXTENSION_NAME = 'MusterdNotify';
const EXTENSION_BUNDLE_SUFFIX = 'notify';

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

function keychainGroup(bundleId) {
  return `$(AppIdentifierPrefix)${bundleId}`;
}

/** The extension compiles these. Paths are relative to the generated `ios/` directory. */
const EXTENSION_SOURCES = [
  'PhoneKeys.swift',
  'extension/RouteJson.swift',
  'extension/SeenNonce.swift',
  'extension/SharedStore.swift',
  'extension/Notice.swift',
  'extension/DeliveryOpen.swift',
  'extension/PinBinding.swift',
  'extension/NotificationService.swift',
];

const EXTENSION_FRAMEWORKS = [
  'UserNotifications.framework',
  'Security.framework',
  'LocalAuthentication.framework',
];

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>${EXTENSION_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
}

function entitlementsPlist(group) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${group}</string>
  </array>
</dict>
</plist>
`;
}

function targetAlreadyExists(project) {
  const section = project.pbxNativeTargetSection();
  return Object.keys(section).some((key) => {
    if (key.endsWith('_comment')) return false;
    const name = section[key] && section[key].name;
    return name === EXTENSION_NAME || name === `"${EXTENSION_NAME}"`;
  });
}

function setExtensionBuildSettings(project, target, extensionBundleId) {
  const listId = target.pbxNativeTarget.buildConfigurationList;
  const list = project.pbxXCConfigurationList()[listId];
  const configs = project.pbxXCBuildConfigurationSection();
  const settings = {
    PRODUCT_BUNDLE_IDENTIFIER: `"${extensionBundleId}"`,
    INFOPLIST_FILE: `"${EXTENSION_NAME}/${EXTENSION_NAME}-Info.plist"`,
    IPHONEOS_DEPLOYMENT_TARGET: MIN_IOS_VERSION,
    SWIFT_VERSION: '5.9',
    CODE_SIGN_STYLE: 'Automatic',
    GENERATE_INFOPLIST_FILE: 'NO',
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'NOTIFICATION_EXTENSION',
    CODE_SIGN_ENTITLEMENTS: `${EXTENSION_NAME}/${EXTENSION_NAME}.entitlements`,
    TARGETED_DEVICE_FAMILY: '"1"',
  };
  for (const entry of list.buildConfigurations) {
    Object.assign(configs[entry.value].buildSettings, settings);
  }
}

function withNotificationExtension(config, bundleId) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const iosRoot = cfg.modRequest.platformProjectRoot;
    const extDir = path.join(iosRoot, EXTENSION_NAME);
    const group = keychainGroup(bundleId);
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, `${EXTENSION_NAME}-Info.plist`), infoPlist());
    fs.writeFileSync(path.join(extDir, `${EXTENSION_NAME}.entitlements`), entitlementsPlist(group));

    if (targetAlreadyExists(project)) return cfg;

    const extensionBundleId = `${bundleId}.${EXTENSION_BUNDLE_SUFFIX}`;
    const target = project.addTarget(
      EXTENSION_NAME,
      'app_extension',
      EXTENSION_NAME,
      extensionBundleId,
    );
    if (!target) {
      throw new Error('withMusterdKeys: failed to add the notification service extension target');
    }
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    for (const rel of EXTENSION_SOURCES) {
      const filePath = path.join('..', 'modules', 'musterd-keys', 'ios', rel);
      const added = project.addSourceFile(filePath, { target: target.uuid });
      if (!added) {
        throw new Error(`withMusterdKeys: failed to add ${rel} to ${EXTENSION_NAME}`);
      }
    }
    for (const framework of EXTENSION_FRAMEWORKS) {
      project.addFramework(framework, { target: target.uuid });
    }
    setExtensionBuildSettings(project, target, extensionBundleId);
    return cfg;
  });
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
    inner.modResults['aps-environment'] = 'production';
    inner.modResults['com.apple.developer.usernotifications.time-sensitive'] = true;
    const group = keychainGroup(bundleId);
    const existing = inner.modResults['keychain-access-groups'] ?? [];
    const rest = existing.filter((entry) => entry !== group);
    inner.modResults['keychain-access-groups'] = [group, ...rest];
    return inner;
  });

  config = withEasAppExtension(config, bundleId);
  config = withNotificationExtension(config, bundleId);
  return config;
}

/**
 * Declare the extension to EAS. With no committed `ios/`, EAS Build creates signing credentials
 * only for the targets listed under `extra.eas.build.experimental.ios.appExtensions`; an
 * undeclared target has no provisioning profile and the archive fails to sign.
 */
function withEasAppExtension(config, bundleId) {
  const extra = (config.extra ??= {});
  const eas = (extra.eas ??= {});
  const build = (eas.build ??= {});
  const experimental = (build.experimental ??= {});
  const ios = (experimental.ios ??= {});
  const extensions = (ios.appExtensions ??= []);
  if (!extensions.some((entry) => entry.targetName === EXTENSION_NAME)) {
    extensions.push({
      targetName: EXTENSION_NAME,
      bundleIdentifier: `${bundleId}.${EXTENSION_BUNDLE_SUFFIX}`,
      entitlements: { 'keychain-access-groups': [keychainGroup(bundleId)] },
    });
  }
  return config;
}

module.exports = createRunOncePlugin(withMusterdKeysIos, pkg.name, pkg.version);
