import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTION_QUESTION_CHOICE_PREFIX,
  ACTION_QUESTION_REPLY,
  QUESTION_BUTTONS_MAX,
  QUESTION_OPTIONS_CATEGORY_PREFIX,
  QUESTION_REPLY_CATEGORY,
  QUESTION_UNDELIVERED_TEXT,
  ANSWER_HINT,
  ACTION_APPROVE,
  ACTION_REJECT,
  ADVISORY_CATEGORY,
  STALE_TEXT,
  LOCK_SCREEN_FALLBACK_TEXT,
} from './notice';

const read = (rel: string) => readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');

describe('the Swift extension matches the TypeScript sentences', () => {
  const notice = read('packages/mobile/modules/musterd-keys/ios/extension/Notice.swift');
  const store = read('packages/mobile/modules/musterd-keys/ios/extension/SharedStore.swift');
  const keys = read('packages/mobile/modules/musterd-keys/ios/PhoneKeys.swift');
  const plugin = read('packages/mobile/plugins/withMusterdKeys.js');
  const podspec = read('packages/mobile/modules/musterd-keys/ios/MusterdKeys.podspec');
  const config = read('packages/mobile/modules/musterd-keys/expo-module.config.json');

  it('pins the lock-screen copy and the action identifiers', () => {
    for (const sentence of [
      LOCK_SCREEN_FALLBACK_TEXT,
      STALE_TEXT,
      ANSWER_HINT,
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
