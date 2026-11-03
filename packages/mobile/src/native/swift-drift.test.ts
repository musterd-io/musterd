import { readFileSync } from 'node:fs';
import { appQuickActionSigningBytes } from '@musterd/protocol/app-channel';
import { describe, expect, it } from 'vitest';
import {
  ACTION_QUESTION_CHOICE_PREFIX,
  ACTION_QUESTION_REPLY,
  QUESTION_BUTTONS_MAX,
  QUESTION_OPTIONS_CATEGORY_PREFIX,
  QUESTION_REPLY_CATEGORY,
  QUESTION_UNDELIVERED_TEXT,
  ANSWER_HINT,
  OPEN_HINT,
  ACTION_APPROVE,
  ACTION_REJECT,
  ADVISORY_CATEGORY,
  STALE_TEXT,
  LOCK_SCREEN_FALLBACK_TEXT,
  QUICK_ACTION_LABELS,
  ROSTER_TEXT,
} from './notice';

const read = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');

describe('the Swift extension matches the TypeScript sentences', () => {
  const notice = read('packages/mobile/modules/musterd-keys/ios/extension/Notice.swift');
  const store = read('packages/mobile/modules/musterd-keys/ios/extension/SharedStore.swift');
  const keys = read('packages/mobile/modules/musterd-keys/ios/PhoneKeys.swift');
  const plugin = read('packages/mobile/plugins/withMusterdKeys.js');
  const podspec = read('packages/mobile/modules/musterd-keys/ios/MusterdKeys.podspec');
  const config = read('packages/mobile/modules/musterd-keys/expo-module.config.json');

  it('pins the quick-action labels, result copy and seal purpose (ADR 791)', () => {
    for (const [action, label] of Object.entries(QUICK_ACTION_LABELS))
      expect(notice).toContain(`"${action}": "${label}"`);
    expect(notice).toContain(ROSTER_TEXT);
    expect(notice).toContain('reached \\(seat).');
    expect(notice).toContain('is offline. \\(label) waits in its inbox.');
    expect(keys).toContain('"quick_action":');
    // The silent question key signs a quick action (nick, build 45: Start didn't send without it).
    const bytes = appQuickActionSigningBytes({
      team: 't',
      binding: 'b',
      seat: 's',
      action: 'start',
      nonce: 'n',
      ts: 1,
    });
    const tag = bytes.slice(0, bytes.indexOf('\n') + 1).replace('\n', '\\n');
    expect(keys).toContain(`quickActionTag = "${tag}"`);
    expect(keys).toContain('message.hasPrefix(quickActionTag)');
  });

  it('pins the lock-screen copy and the action identifiers', () => {
    for (const sentence of [
      LOCK_SCREEN_FALLBACK_TEXT,
      STALE_TEXT,
      ANSWER_HINT,
      OPEN_HINT,
      ADVISORY_CATEGORY,
      ACTION_APPROVE,
      ACTION_REJECT,
      '1 more waiting',
      '1 ask is held.',
      'Paired as ',
    ]) {
      expect(notice).toContain(sentence);
    }
  });

  it('pins the question actions and their copy (ADR 774 §5)', () => {
    const question = read('packages/mobile/modules/musterd-keys/ios/extension/Question.swift');
    const answer = read('packages/mobile/modules/musterd-keys/ios/QuestionAnswer.swift');
    for (const id of [
      `"${QUESTION_REPLY_CATEGORY}"`,
      `"${QUESTION_OPTIONS_CATEGORY_PREFIX}"`,
      `"${ACTION_QUESTION_CHOICE_PREFIX}"`,
      `"${ACTION_QUESTION_REPLY}"`,
      `maxButtons = ${QUESTION_BUTTONS_MAX}`,
    ]) {
      expect(question).toContain(id);
    }
    expect(answer).toContain(QUESTION_UNDELIVERED_TEXT);
    expect(plugin).toContain('extension/Question.swift');
    expect(plugin).toContain('extension/QuestionCategory.swift');
  });

  it('shares one keychain service and does not add a notification or sqlite package', () => {
    expect(keys).toContain('dev.musterd.keys');
    expect(store).toContain('dev.musterd.keys');
    expect(store).toContain('seen-nonces');
    expect(store).toContain('push-token');
    expect(store).toContain('pairing-pin');
    // Lane 01M6FJFW66: "Pair again" deletes the pin first and never the push token.
    expect(store).toMatch(/pairingAccounts = \[\s*pinAccount,/);
    expect(
      store.slice(
        store.indexOf('pairingAccounts = ['),
        store.indexOf(']', store.indexOf('pairingAccounts = [')),
      ),
    ).not.toContain('pushAccount');
    expect(read('packages/mobile/modules/musterd-keys/ios/MusterdKeysModule.swift')).toContain(
      'Function("forgetPairing")',
    );
    expect(keys).toContain('#if !NOTIFICATION_EXTENSION');
    const pkg = read('packages/mobile/package.json');
    expect(plugin).not.toMatch(/require\([^)]*expo-notifications/);
    expect(plugin).not.toMatch(/require\([^)]*expo-sqlite/);
    expect(pkg).not.toContain('"expo-notifications"');
    expect(pkg).not.toContain('"expo-sqlite"');
    expect(plugin).toContain('aps-environment');
    expect(plugin).toContain('CFBundleIdentifier');
    expect(plugin).toContain('$(PRODUCT_BUNDLE_IDENTIFIER)');
    expect(plugin).toContain('com.apple.usernotifications.service');
    expect(plugin).toContain('io.musterd.app.notify');
    expect(plugin).toContain('extension/PinBinding.swift');
    expect(podspec).toContain('extension/NotificationService.swift');
    expect(config).toContain('MusterdPushSubscriber');
  });
});
