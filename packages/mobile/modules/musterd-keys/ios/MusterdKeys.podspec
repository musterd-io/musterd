require 'json'

Pod::Spec.new do |s|
  s.name           = 'MusterdKeys'
  s.version        = '1.0.0'
  s.summary        = 'The phone keys: Secure Enclave signing and receive keys, HPKE, App Attest.'
  s.description    = 'Native half of the musterd sealed ask client (ADR 676 §2). Plain CryptoKit over Security and DeviceCheck; no wire format lives here.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  # iOS 17 is a floor, not a preference: CryptoKit HPKE (Sender/Recipient) is iOS 17+, and the
  # daemon interop suite is built from its public Ciphersuite init. The config plugin refuses a
  # prebuild whose deployment target is lower, so the two never disagree.
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift,hpp,cpp}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
